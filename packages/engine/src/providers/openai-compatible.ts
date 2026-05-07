import path from "node:path";
import { z } from "zod";
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResponse,
  GenerationRequest,
  GenerationResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ProviderCapability,
  ProviderType,
  StructuredGenerationOptions
} from "../types.js";
import { extractJson, truncate } from "../utils.js";
import { BaseProviderAdapter } from "./base.js";
import { parseStructuredWithRepair, zodIssueSummary } from "./structured-repair.js";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  apiStyle?: "responses" | "chat";
  capabilities: ProviderCapability[];
  structuredOutputMode?: "json_schema" | "json_object" | "prompt_json";
  maxRetries?: number;
  timeoutMs?: number;
  debugProviderErrors?: boolean;
}

function buildAuthHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

type ResponsesApiPayload = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  status?: string;
  incomplete_details?: {
    reason?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type JsonSchema = Record<string, unknown>;
type StructuredProviderText = {
  text: string;
  finishReason?: string;
};

function extractResponsesText(payload: ResponsesApiPayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  return (
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("\n")
      .trim() ?? ""
  );
}

function isJsonSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowNullInSchema(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.type)) {
    return schema.type.includes("null") ? schema : { ...schema, type: [...schema.type, "null"] };
  }

  if (typeof schema.type === "string") {
    return schema.type === "null" ? schema : { ...schema, type: [schema.type, "null"] };
  }

  if (Array.isArray(schema.enum)) {
    return schema.enum.includes(null) ? schema : { ...schema, enum: [...schema.enum, null] };
  }

  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((item) => isJsonSchemaObject(item) && item.type === "null")
      ? schema
      : { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
  }

  return { anyOf: [schema, { type: "null" }] };
}

function toOpenAiStrictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => toOpenAiStrictJsonSchema(item));
  }

  if (!isJsonSchemaObject(schema)) {
    return schema;
  }

  const normalizedEntries = Object.entries(schema)
    .filter(([key]) => key !== "$schema")
    .map(([key, value]) => [key, toOpenAiStrictJsonSchema(value)]);
  const normalizedSchema = Object.fromEntries(normalizedEntries) as JsonSchema;

  if (isJsonSchemaObject(normalizedSchema.properties)) {
    const properties = normalizedSchema.properties as Record<string, unknown>;
    const originalRequired = Array.isArray(normalizedSchema.required)
      ? normalizedSchema.required.filter((item): item is string => typeof item === "string")
      : [];
    const requiredSet = new Set(originalRequired);
    const propertyEntries = Object.entries(properties).map(([key, value]) => {
      const normalizedProperty = isJsonSchemaObject(value) ? value : {};
      return [key, requiredSet.has(key) ? normalizedProperty : allowNullInSchema(normalizedProperty)];
    });
    return {
      ...normalizedSchema,
      properties: Object.fromEntries(propertyEntries),
      required: Object.keys(properties),
      additionalProperties: false
    };
  }

  return normalizedSchema;
}

function buildStructuredFormat(schema: z.ZodTypeAny) {
  return {
    type: "json_schema" as const,
    name: "swarmvault_response",
    schema: toOpenAiStrictJsonSchema(z.toJSONSchema(schema)),
    strict: true
  };
}

function truncateErrorBody(value: string): string {
  return truncate(value.replace(/\s+/g, " ").trim(), 360);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableProviderError(status: number, body: string): boolean {
  const normalized = body.toLowerCase();
  return (
    status === 429 ||
    status >= 500 ||
    normalized.includes("overloaded") ||
    normalized.includes("failed_response") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("rate limit")
  );
}

function retryDelayMs(attempt: number): number {
  return [1_000, 3_000, 8_000][attempt] ?? 8_000;
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!activeSignals.length) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return controller.signal;
}

function structuredErrorMessage(
  providerId: string,
  attempt: "initial" | "repair",
  result: StructuredProviderText,
  error: unknown,
  jsonLength?: number
): string {
  const reason = result.finishReason ? ` finishReason=${result.finishReason}` : "";
  const parsedLength = typeof jsonLength === "number" ? ` jsonChars=${jsonLength}` : "";
  const detail = zodIssueSummary(error);
  return `Provider ${providerId} structured ${attempt} response could not be parsed: rawChars=${result.text.length}${parsedLength}${reason} error=${truncateErrorBody(detail)}`;
}

export class OpenAiCompatibleProviderAdapter extends BaseProviderAdapter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly headers?: Record<string, string>;
  private readonly apiStyle: "responses" | "chat";
  private readonly structuredOutputMode: "json_schema" | "json_object" | "prompt_json";
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly debugProviderErrors: boolean;

  public constructor(id: string, type: ProviderType, model: string, options: OpenAiCompatibleOptions) {
    super(id, type, model, options.capabilities);
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.apiStyle = options.apiStyle ?? "responses";
    this.structuredOutputMode = options.structuredOutputMode ?? (type === "openai" ? "json_schema" : "json_object");
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 120_000);
    this.debugProviderErrors = options.debugProviderErrors ?? true;
  }

  public async generateText(request: GenerationRequest): Promise<GenerationResponse> {
    if (this.apiStyle === "chat") {
      return this.generateViaChatCompletions(request);
    }
    return this.generateViaResponses(request);
  }

  public async generateStructured<T>(
    request: GenerationRequest,
    schema: z.ZodType<T>,
    options: StructuredGenerationOptions = {}
  ): Promise<T> {
    const structuredFormat = buildStructuredFormat(schema);
    const parseStructured = (result: StructuredProviderText, attempt: "initial" | "repair"): T => {
      let jsonText = "";
      try {
        jsonText = extractJson(result.text);
      } catch (error) {
        throw new Error(structuredErrorMessage(this.id, attempt, result, error));
      }
      try {
        return parseStructuredWithRepair(schema, JSON.parse(jsonText), options);
      } catch (error) {
        throw new Error(structuredErrorMessage(this.id, attempt, result, error, jsonText.length));
      }
    };

    const readStructured = async (repair = false, repairReason = ""): Promise<StructuredProviderText> => {
      const repairHint = repair
        ? [
            "",
            "Your previous response was not valid JSON for the required schema.",
            repairReason ? `Validation problems: ${repairReason}` : "",
            "Return ONLY valid JSON matching the schema. Do not add explanations."
          ]
            .filter(Boolean)
            .join("\n")
        : "";
      const schemaPrompt = `JSON schema:\n${JSON.stringify(structuredFormat.schema)}`;
      const mergedSystem = [request.system, this.structuredOutputMode === "json_schema" ? "" : schemaPrompt].filter(Boolean).join("\n\n");
      const mergedRequest: GenerationRequest = {
        ...request,
        system: mergedSystem || undefined,
        prompt: `${request.prompt}${repairHint}`
      };

      if (this.apiStyle === "chat") {
        return this.generateStructuredViaChatCompletions(mergedRequest, structuredFormat, this.structuredOutputMode);
      }
      return this.generateStructuredViaResponses(mergedRequest, structuredFormat, this.structuredOutputMode);
    };

    try {
      const result = await readStructured(false);
      return parseStructured(result, "initial");
    } catch (error) {
      const initialMessage = error instanceof Error ? error.message : String(error);
      const result = await readStructured(true, initialMessage);
      try {
        return parseStructured(result, "repair");
      } catch (repairError) {
        const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
        throw new Error(`${initialMessage}; repair failed: ${repairMessage}`);
      }
    }
  }

  private async requestJson(endpoint: string, body: unknown, init?: { formData?: FormData; signal?: AbortSignal }): Promise<unknown> {
    const url = `${this.baseUrl}${endpoint}`;
    const attempts = this.maxRetries + 1;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMs);
      const signal = mergeAbortSignals(init?.signal, timeoutController.signal);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: init?.formData
            ? {
                ...buildAuthHeaders(this.apiKey),
                ...this.headers
              }
            : {
                "content-type": "application/json",
                ...buildAuthHeaders(this.apiKey),
                ...this.headers
              },
          body: init?.formData ? init.formData : JSON.stringify(body),
          signal
        });
        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const summary = this.debugProviderErrors && errorBody ? ` body=${truncateErrorBody(errorBody)}` : "";
          const message = `Provider ${this.id} failed: ${response.status} ${response.statusText}${summary}`;
          const retriable = isRetriableProviderError(response.status, errorBody);
          if (attempt < attempts - 1 && retriable) {
            lastError = new Error(message);
            await sleep(retryDelayMs(attempt));
            continue;
          }
          throw new Error(message);
        }
        return await response.json();
      } catch (error) {
        const callerAborted = init?.signal?.aborted === true;
        const timedOut = timeoutController.signal.aborted && !callerAborted;
        const message = callerAborted
          ? `Provider ${this.id} request aborted.`
          : timedOut || (error instanceof Error && error.name === "AbortError")
            ? `Provider ${this.id} timed out after ${this.timeoutMs}ms.`
            : error instanceof Error
              ? error.message
              : String(error);
        lastError = new Error(message);
        if (callerAborted || timedOut || attempt >= attempts - 1) {
          throw lastError;
        }
        await sleep(retryDelayMs(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error(`Provider ${this.id} failed.`);
  }

  public async embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts.length) {
      return [];
    }

    const payload = (await this.requestJson("/embeddings", {
      model: this.model,
      input: texts
    })) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vectors = payload.data?.map((item) => item.embedding ?? []) ?? [];
    if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
      throw new Error(`Provider ${this.id} returned invalid embedding data.`);
    }
    return vectors;
  }

  public async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResponse> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const payload = (await this.requestJson("/images/generations", {
      model: this.model,
      prompt: request.prompt,
      size:
        request.width && request.height
          ? `${Math.max(256, Math.round(request.width))}x${Math.max(256, Math.round(request.height))}`
          : undefined,
      response_format: "b64_json",
      ...(encodedAttachments.length
        ? {
            input_image: encodedAttachments.map((item) => `data:${item.mimeType};base64,${item.base64}`)
          }
        : {})
    })) as {
      data?: Array<{ b64_json?: string; revised_prompt?: string }>;
    };
    const image = payload.data?.[0];
    if (!image?.b64_json) {
      throw new Error(`Provider ${this.id} returned no image data.`);
    }

    return {
      mimeType: "image/png",
      bytes: Buffer.from(image.b64_json, "base64"),
      width: request.width,
      height: request.height,
      revisedPrompt: image.revised_prompt
    };
  }

  public async transcribeAudio(request: AudioTranscriptionRequest): Promise<AudioTranscriptionResponse> {
    const extension = request.mimeType.split("/")[1]?.split("+")[0] ?? "bin";
    const fileName = request.fileName ?? `audio.${extension}`;

    const formData = new FormData();
    formData.append("file", new File([new Uint8Array(request.bytes)], path.basename(fileName), { type: request.mimeType }));
    formData.append("model", this.model);
    formData.append("response_format", "verbose_json");
    if (request.language) {
      formData.append("language", request.language);
    }
    if (request.corpusHint) {
      formData.append("prompt", request.corpusHint);
    }

    const payload = (await this.requestJson("/audio/transcriptions", {}, { formData })) as {
      text?: string;
      duration?: number;
      language?: string;
    };

    return {
      text: payload.text ?? "",
      duration: payload.duration,
      language: payload.language
    };
  }

  private async generateViaResponses(request: GenerationRequest): Promise<GenerationResponse> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const input = encodedAttachments.length
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text: request.prompt },
              ...encodedAttachments.map((item) => ({
                type: "input_image",
                image_url: `data:${item.mimeType};base64,${item.base64}`
              }))
            ]
          }
        ]
      : request.prompt;

    const payload = (await this.requestJson(
      "/responses",
      {
        model: this.model,
        input,
        instructions: request.system,
        max_output_tokens: request.maxOutputTokens
      },
      { signal: request.signal }
    )) as ResponsesApiPayload;
    return {
      text: extractResponsesText(payload),
      usage: payload.usage ? { inputTokens: payload.usage.input_tokens, outputTokens: payload.usage.output_tokens } : undefined
    };
  }

  private async generateStructuredViaResponses(
    request: GenerationRequest,
    format: ReturnType<typeof buildStructuredFormat>,
    mode: "json_schema" | "json_object" | "prompt_json"
  ): Promise<StructuredProviderText> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const input = encodedAttachments.length
      ? [
          {
            role: "user",
            content: [
              { type: "input_text", text: request.prompt },
              ...encodedAttachments.map((item) => ({
                type: "input_image",
                image_url: `data:${item.mimeType};base64,${item.base64}`
              }))
            ]
          }
        ]
      : request.prompt;

    const payload = (await this.requestJson(
      "/responses",
      {
        model: this.model,
        input,
        instructions: request.system,
        max_output_tokens: request.maxOutputTokens,
        ...(mode === "json_schema"
          ? {
              text: {
                format
              }
            }
          : {})
      },
      { signal: request.signal }
    )) as ResponsesApiPayload;
    return {
      text: extractResponsesText(payload),
      finishReason: payload.incomplete_details?.reason ?? payload.status
    };
  }

  private async generateViaChatCompletions(request: GenerationRequest): Promise<GenerationResponse> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const content = encodedAttachments.length
      ? [
          { type: "text", text: request.prompt },
          ...encodedAttachments.map((item) => ({
            type: "image_url",
            image_url: {
              url: `data:${item.mimeType};base64,${item.base64}`
            }
          }))
        ]
      : request.prompt;

    const messages = [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content }];

    const payload = (await this.requestJson(
      "/chat/completions",
      {
        model: this.model,
        messages,
        max_tokens: request.maxOutputTokens
      },
      { signal: request.signal }
    )) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const contentValue = payload.choices?.[0]?.message?.content;
    const text = Array.isArray(contentValue) ? contentValue.map((item) => item.text ?? "").join("\n") : (contentValue ?? "");
    return {
      text,
      usage: payload.usage ? { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens } : undefined
    };
  }

  private async generateStructuredViaChatCompletions(
    request: GenerationRequest,
    format: ReturnType<typeof buildStructuredFormat>,
    mode: "json_schema" | "json_object" | "prompt_json"
  ): Promise<StructuredProviderText> {
    const encodedAttachments = await this.encodeAttachments(request.attachments);
    const content = encodedAttachments.length
      ? [
          { type: "text", text: request.prompt },
          ...encodedAttachments.map((item) => ({
            type: "image_url",
            image_url: {
              url: `data:${item.mimeType};base64,${item.base64}`
            }
          }))
        ]
      : request.prompt;

    const messages = [...(request.system ? [{ role: "system", content: request.system }] : []), { role: "user", content }];

    const payload = (await this.requestJson(
      "/chat/completions",
      {
        model: this.model,
        messages,
        max_tokens: request.maxOutputTokens,
        ...(mode === "json_schema"
          ? {
              response_format: {
                type: "json_schema",
                json_schema: format
              }
            }
          : mode === "json_object"
            ? {
                response_format: {
                  type: "json_object"
                }
              }
            : {})
      },
      { signal: request.signal }
    )) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const choice = payload.choices?.[0];
    const contentValue = choice?.message?.content;
    return {
      text: Array.isArray(contentValue) ? contentValue.map((item) => item.text ?? "").join("\n") : (contentValue ?? ""),
      finishReason: choice?.finish_reason
    };
  }
}

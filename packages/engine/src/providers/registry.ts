import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadVaultConfig } from "../config.js";
import type { ProviderAdapter, ProviderCapability, ProviderConfig, ResolvedPaths } from "../types.js";
import { AnthropicProviderAdapter } from "./anthropic.js";
import { GeminiProviderAdapter } from "./gemini.js";
import { HeuristicProviderAdapter } from "./heuristic.js";
import { LocalWhisperProviderAdapter } from "./local-whisper.js";
import { OpenAiCompatibleProviderAdapter } from "./openai-compatible.js";

const customModuleSchema = z.object({
  createAdapter: z.function({
    input: [z.string(), z.custom<ProviderConfig>(), z.string()],
    output: z.promise(z.custom<ProviderAdapter>())
  })
});

const PROVIDER_SECRETS_FILENAME = "swarmvault.secrets.json";
const providerSecretsSchema = z.object({
  providers: z.record(z.string(), z.object({ apiKey: z.string().min(1).optional() })).optional()
});

function resolveCapabilities(config: ProviderConfig, fallback: ProviderCapability[]): ProviderCapability[] {
  return config.capabilities?.length ? config.capabilities : fallback;
}

function envOrUndefined(name?: string): string | undefined {
  return name ? process.env[name] : undefined;
}

async function apiKeyFromSecretsFile(rootDir: string, providerId: string): Promise<string | undefined> {
  const secretsPath = path.join(rootDir, PROVIDER_SECRETS_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(secretsPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = providerSecretsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid ${PROVIDER_SECRETS_FILENAME} format. Expected { providers: { <id>: { apiKey } } }.`);
  }
  const candidate = parsed.data.providers?.[providerId]?.apiKey?.trim();
  return candidate || undefined;
}

async function apiKeyFromFile(rootDir: string, filePath?: string): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
  const raw = (await fs.readFile(resolved, "utf8")).trim();
  return raw || undefined;
}

async function resolveProviderSecret(
  rootDir: string,
  providerId: string,
  config: ProviderConfig,
  defaultApiKeyEnv?: string
): Promise<string | undefined> {
  const inlineKey = config.apiKey?.trim();
  if (inlineKey) {
    return inlineKey;
  }

  const secretFileKey = await apiKeyFromSecretsFile(rootDir, providerId);
  if (secretFileKey) {
    return secretFileKey;
  }

  const keyFromFile = await apiKeyFromFile(rootDir, config.apiKeyFile);
  if (keyFromFile) {
    return keyFromFile;
  }

  return envOrUndefined(config.apiKeyEnv ?? defaultApiKeyEnv);
}

async function createOpenAiCompatiblePreset(
  rootDir: string,
  id: string,
  type: ProviderConfig["type"],
  config: ProviderConfig,
  defaults: {
    baseUrl: string;
    apiKeyEnv?: string;
    apiStyle?: "responses" | "chat";
    capabilities: ProviderCapability[];
  }
): Promise<ProviderAdapter> {
  const apiKey = await resolveProviderSecret(rootDir, id, config, defaults.apiKeyEnv);
  return new OpenAiCompatibleProviderAdapter(id, type, config.model, {
    baseUrl: config.baseUrl ?? defaults.baseUrl,
    apiKey,
    headers: config.headers,
    apiStyle: config.apiStyle ?? defaults.apiStyle ?? "chat",
    capabilities: resolveCapabilities(config, defaults.capabilities),
    structuredOutputMode: config.structuredOutputMode,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    debugProviderErrors: config.debugProviderErrors
  });
}

export async function createProvider(id: string, config: ProviderConfig, rootDir: string): Promise<ProviderAdapter> {
  const resolvedApiKey = await resolveProviderSecret(rootDir, id, config);
  switch (config.type) {
    case "heuristic":
      return new HeuristicProviderAdapter(id, config.model);
    case "openai":
      return new OpenAiCompatibleProviderAdapter(id, "openai", config.model, {
        baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
        apiKey: resolvedApiKey,
        headers: config.headers,
        apiStyle: config.apiStyle ?? "responses",
        capabilities: resolveCapabilities(config, [
          "responses",
          "chat",
          "structured",
          "tools",
          "vision",
          "embeddings",
          "streaming",
          "image_generation",
          "audio"
        ]),
        structuredOutputMode: config.structuredOutputMode,
        maxRetries: config.maxRetries,
        timeoutMs: config.timeoutMs,
        debugProviderErrors: config.debugProviderErrors
      });
    case "ollama":
      return new OpenAiCompatibleProviderAdapter(id, "ollama", config.model, {
        baseUrl: config.baseUrl ?? "http://localhost:11434/v1",
        apiKey: resolvedApiKey ?? "ollama",
        headers: config.headers,
        apiStyle: config.apiStyle ?? "responses",
        capabilities: resolveCapabilities(config, [
          "responses",
          "chat",
          "structured",
          "tools",
          "vision",
          "embeddings",
          "streaming",
          "local",
          "audio"
        ]),
        structuredOutputMode: config.structuredOutputMode,
        maxRetries: config.maxRetries,
        timeoutMs: config.timeoutMs,
        debugProviderErrors: config.debugProviderErrors
      });
    case "openai-compatible":
      return new OpenAiCompatibleProviderAdapter(id, "openai-compatible", config.model, {
        baseUrl: config.baseUrl ?? "http://localhost:8000/v1",
        apiKey: resolvedApiKey,
        headers: config.headers,
        apiStyle: config.apiStyle ?? "responses",
        capabilities: resolveCapabilities(config, ["chat", "structured", "embeddings", "audio"]),
        structuredOutputMode: config.structuredOutputMode,
        maxRetries: config.maxRetries,
        timeoutMs: config.timeoutMs,
        debugProviderErrors: config.debugProviderErrors
      });
    case "openrouter":
      return createOpenAiCompatiblePreset(rootDir, id, "openrouter", config, {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "groq":
      return createOpenAiCompatiblePreset(rootDir, id, "groq", config, {
        baseUrl: "https://api.groq.com/openai/v1",
        apiKeyEnv: "GROQ_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings", "audio"]
      });
    case "together":
      return createOpenAiCompatiblePreset(rootDir, id, "together", config, {
        baseUrl: "https://api.together.xyz/v1",
        apiKeyEnv: "TOGETHER_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "xai":
      return createOpenAiCompatiblePreset(rootDir, id, "xai", config, {
        baseUrl: "https://api.x.ai/v1",
        apiKeyEnv: "XAI_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "cerebras":
      return createOpenAiCompatiblePreset(rootDir, id, "cerebras", config, {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKeyEnv: "CEREBRAS_API_KEY",
        apiStyle: "chat",
        capabilities: ["chat", "structured", "embeddings"]
      });
    case "anthropic":
      return new AnthropicProviderAdapter(id, config.model, {
        apiKey: resolvedApiKey,
        headers: config.headers,
        baseUrl: config.baseUrl
      });
    case "gemini":
      return new GeminiProviderAdapter(id, config.model, {
        apiKey: resolvedApiKey,
        baseUrl: config.baseUrl
      });
    case "local-whisper":
      return new LocalWhisperProviderAdapter(id, config.model, {
        binaryPath: config.binaryPath,
        modelPath: config.modelPath,
        extraArgs: config.extraArgs,
        threads: config.threads
      });
    case "custom": {
      if (!config.module) {
        throw new Error(`Provider ${id} is type "custom" but no module path was configured.`);
      }
      const resolvedModule = path.isAbsolute(config.module) ? config.module : path.resolve(rootDir, config.module);
      const loaded = await import(pathToFileURL(resolvedModule).href);
      const parsed = customModuleSchema.parse(loaded);
      return parsed.createAdapter(id, config, rootDir);
    }
    default:
      throw new Error(`Unsupported provider type ${String(config.type)}`);
  }
}

export async function getProviderForTask(
  rootDir: string,
  task: keyof Awaited<ReturnType<typeof loadVaultConfig>>["config"]["tasks"]
): Promise<ProviderAdapter> {
  const { config } = await loadVaultConfig(rootDir);
  const providerId = config.tasks[task];
  if (!providerId) {
    throw new Error(`No provider configured for task "${String(task)}".`);
  }
  const providerConfig = config.providers[providerId];
  if (!providerConfig) {
    throw new Error(`No provider configured with id "${providerId}" for task "${task}".`);
  }
  return createProvider(providerId, providerConfig, rootDir);
}

export function assertProviderCapability(provider: ProviderAdapter, capability: ProviderCapability): void {
  if (!provider.capabilities.has(capability)) {
    throw new Error(`Provider ${provider.id} does not support required capability "${capability}".`);
  }
}

export async function getResolvedPaths(rootDir: string): Promise<ResolvedPaths> {
  return (await loadVaultConfig(rootDir)).paths;
}

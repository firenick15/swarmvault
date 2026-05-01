import { z } from "zod";
import type { StructuredGenerationOptions } from "../types.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function pathLabel(path: Array<string | number>): string {
  return path.map((part) => String(part)).join(".");
}

function zodPath(path: PropertyKey[]): Array<string | number> {
  return path.filter((part): part is string | number => typeof part === "string" || typeof part === "number");
}

function getAtPath(root: unknown, path: Array<string | number>): unknown {
  let current = root;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === "number") {
      current = current[part];
    } else if (isObject(current)) {
      current = current[String(part)];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAtPath(root: unknown, path: Array<string | number>, value: unknown): boolean {
  if (!path.length) {
    return false;
  }
  let current = root;
  for (const part of path.slice(0, -1)) {
    if (Array.isArray(current) && typeof part === "number") {
      current = current[part];
    } else if (isObject(current)) {
      current = current[String(part)];
    } else {
      return false;
    }
  }
  const last = path[path.length - 1];
  if (Array.isArray(current) && typeof last === "number") {
    current[last] = value;
    return true;
  }
  if (isObject(current)) {
    current[String(last)] = value;
    return true;
  }
  return false;
}

function stripNullObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripNullObjectProperties(item));
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null)
      .map(([key, item]) => [key, stripNullObjectProperties(item)])
  );
}

function stringFromStructuredValue(value: unknown, path: Array<string | number>): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const firstString = value.find((item): item is string => typeof item === "string" && item.trim().length > 0);
    return firstString ?? JSON.stringify(value);
  }
  if (!isObject(value)) {
    return undefined;
  }
  const last = String(path[path.length - 1] ?? "");
  const preferredKeys =
    last === "summary"
      ? ["summary", "text", "value", "content", "description"]
      : last === "citation" || last.endsWith("Citation")
        ? ["citation", "id", "sourceId", "source", "reference", "text"]
        : ["text", "value", "summary", "content", "description", "id"];
  for (const key of preferredKeys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return JSON.stringify(value);
}

function normalizeRecommendedNextTool(value: unknown): "knowledge_base" | "environment_data_mcp" | "both" | undefined {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!text) {
    return undefined;
  }
  if (text.includes("both") || text.includes("hybrid") || text.includes("knowledge_and_data")) {
    return "both";
  }
  if (text.includes("data") || text.includes("mcp") || text.includes("monitoring")) {
    return "environment_data_mcp";
  }
  if (text.includes("knowledge") || text.includes("kb") || text.includes("vault")) {
    return "knowledge_base";
  }
  return undefined;
}

export function normalizeDeepLintCode(raw: string): string {
  const text = raw.toLowerCase();
  if (/contradict|conflict|冲突|矛盾/.test(text)) {
    return "contradiction_candidate";
  }
  if (/citation|cite|引用|missing.*source|source.*missing/.test(text)) {
    return "missing_citation";
  }
  if (/coverage|gap|缺口|覆盖/.test(text)) {
    return "coverage_gap";
  }
  if (/candidate|page|候选|页面/.test(text)) {
    return "candidate_page";
  }
  if (/follow|question|问题|追问/.test(text)) {
    return "follow_up_question";
  }
  return "follow_up_question";
}

function safeEnumReplacement(path: Array<string | number>, value: unknown, options: StructuredGenerationOptions): unknown {
  const key = String(path[path.length - 1] ?? "");
  if (options.schemaName === "deep_lint" && key === "code") {
    const normalized = normalizeDeepLintCode(String(value ?? ""));
    options.repairWarnings?.push(`normalized_deep_lint_code:${String(value)}->${normalized}`);
    return normalized;
  }
  if (key === "recommendedNextTool") {
    const normalized = normalizeRecommendedNextTool(value);
    if (normalized) {
      options.repairWarnings?.push(`normalized_recommended_next_tool:${String(value)}->${normalized}`);
      return normalized;
    }
  }
  if (key === "authorityLayer") {
    options.repairWarnings?.push(`unsafe_authority_field_reset:${pathLabel(path)}`);
    return "unknown";
  }
  if (key === "legalForce") {
    options.repairWarnings?.push(`unsafe_authority_field_reset:${pathLabel(path)}`);
    return "unknown";
  }
  if (key === "documentRole") {
    options.repairWarnings?.push(`unsafe_authority_field_reset:${pathLabel(path)}`);
    return "unknown";
  }
  if (key === "legalStatus") {
    options.repairWarnings?.push(`unsafe_authority_field_reset:${pathLabel(path)}`);
    return "unknown";
  }
  if (key === "metadataSource") {
    return "llm";
  }
  if (key === "verificationState") {
    return "unreviewed";
  }
  return undefined;
}

export function coerceStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => coerceStructuredValue(item));
  }
  if (!isObject(value)) {
    return value;
  }
  const entries = Object.entries(value).map(([key, item]) => {
    if ((key === "citation" || key.endsWith("Citation")) && isObject(item)) {
      return [key, stringFromStructuredValue(item, [key]) ?? JSON.stringify(item)];
    }
    if (key === "summary" && typeof item !== "string" && item !== undefined && item !== null) {
      return [key, stringFromStructuredValue(item, [key]) ?? ""];
    }
    if ((key === "concepts" || key === "entities" || key === "tags") && Array.isArray(item)) {
      return [
        key,
        item.map((entry) =>
          typeof entry === "string" && (key === "concepts" || key === "entities")
            ? { name: entry, description: "" }
            : coerceStructuredValue(entry)
        )
      ];
    }
    if (key === "claims" && Array.isArray(item)) {
      return [
        key,
        item.map((entry) => {
          if (typeof entry === "string") {
            return { text: entry, citation: "", confidence: 0.5 };
          }
          if (isObject(entry)) {
            const next = { ...entry };
            if (typeof next.text !== "string") {
              next.text = stringFromStructuredValue(next.text ?? next.claim ?? next.summary ?? next.content ?? entry, [key, "text"]) ?? "";
            }
            if (next.citation !== undefined && typeof next.citation !== "string") {
              next.citation = stringFromStructuredValue(next.citation, [key, "citation"]) ?? "";
            }
            return coerceStructuredValue(next);
          }
          return coerceStructuredValue(entry);
        })
      ];
    }
    return [key, coerceStructuredValue(item)];
  });
  return Object.fromEntries(entries);
}

function repairKnownShape(value: unknown, options: StructuredGenerationOptions): unknown {
  if (!isObject(value)) {
    return value;
  }
  const next = structuredClone(value) as JsonObject;
  if (options.schemaName === "grounded_answer") {
    const allowed = new Set(options.allowedEvidenceIds ?? []);
    const aliases = options.evidenceIdAliases ?? {};
    if (Array.isArray(next.usedEvidenceIds) && allowed.size) {
      next.usedEvidenceIds = next.usedEvidenceIds
        .map((id) => (typeof id === "string" ? (aliases[id] ?? aliases[id.toLowerCase()] ?? id) : id))
        .filter((id) => typeof id === "string" && allowed.has(id));
    }
    const tool = normalizeRecommendedNextTool(next.recommendedNextTool);
    if (tool) {
      next.recommendedNextTool = tool;
    }
  }
  if (options.schemaName === "source_analysis" && Array.isArray(next.claims) && next.claims.length > 8) {
    next.claims = next.claims.slice(0, 8);
    options.repairWarnings?.push("truncated_array:claims:8");
  }
  if (options.schemaName === "deep_lint" && Array.isArray(next.findings) && next.findings.length > 20) {
    next.findings = next.findings.slice(0, 20);
    options.repairWarnings?.push("truncated_array:findings:20");
  }
  return next;
}

function repairZodIssues(value: unknown, error: z.ZodError, options: StructuredGenerationOptions): unknown {
  const next = structuredClone(value);
  for (const issue of error.issues) {
    const path = zodPath(issue.path);
    const current = getAtPath(next, path);
    if (issue.code === "too_big" && Array.isArray(current) && typeof issue.maximum === "number") {
      setAtPath(next, path, current.slice(0, issue.maximum));
      options.repairWarnings?.push(`truncated_array:${pathLabel(path)}:${issue.maximum}`);
      continue;
    }
    if (issue.code === "invalid_type") {
      const expected = String((issue as { expected?: unknown }).expected ?? "");
      if (expected === "string") {
        const replacement = stringFromStructuredValue(current, path);
        if (typeof replacement === "string") {
          setAtPath(next, path, replacement);
          options.repairWarnings?.push(`coerced_string:${pathLabel(path)}`);
        }
      } else if (expected === "array" && current === undefined) {
        setAtPath(next, path, []);
        options.repairWarnings?.push(`defaulted_array:${pathLabel(path)}`);
      }
      continue;
    }
    if (issue.code === "invalid_value") {
      const replacement = safeEnumReplacement(path, current, options);
      if (replacement !== undefined) {
        setAtPath(next, path, replacement);
      }
    }
  }
  return next;
}

export function normalizeStructuredInput(value: unknown, options: StructuredGenerationOptions = {}): unknown {
  const withoutNulls = stripNullObjectProperties(value);
  const repairedKnown = repairKnownShape(withoutNulls, options);
  return options.coercion === "strict" ? repairedKnown : coerceStructuredValue(repairedKnown);
}

export function parseStructuredWithRepair<T>(schema: z.ZodType<T>, value: unknown, options: StructuredGenerationOptions = {}): T {
  const normalized = normalizeStructuredInput(value, options);
  try {
    return schema.parse(normalized);
  } catch (error) {
    if (!(error instanceof z.ZodError)) {
      throw error;
    }
    const repaired = normalizeStructuredInput(repairZodIssues(normalized, error, options), options);
    return schema.parse(repaired);
  }
}

export function zodIssueSummary(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : String(error);
  }
  return error.issues
    .slice(0, 8)
    .map((issue) => `${pathLabel(zodPath(issue.path)) || "<root>"}:${issue.code}:${compact(issue.message)}`)
    .join("; ");
}

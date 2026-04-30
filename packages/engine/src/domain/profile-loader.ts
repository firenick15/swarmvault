import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { VaultConfig } from "../types.js";
import { fileExists } from "../utils.js";
import { DEFAULT_ENV_AIR_PROFILE, type EnvAirProfile } from "./env-air-profile.js";

export type LoadedDomainProfile = EnvAirProfile;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readStructuredFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    return JSON.parse(raw);
  }
  if (/\.(ya?ml)$/i.test(filePath)) {
    return YAML.parse(raw);
  }
  return raw;
}

async function readOptionalStructured(rootDir: string, relativePath?: string): Promise<unknown> {
  if (!relativePath) {
    return undefined;
  }
  const absolutePath = path.resolve(rootDir, relativePath);
  if (!(await fileExists(absolutePath))) {
    return undefined;
  }
  return readStructuredFile(absolutePath);
}

function stringArray(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : fallback;
}

function recordOfStringArrays(value: unknown, fallback: Record<string, string[]> = {}): Record<string, string[]> {
  if (!isRecord(value)) {
    return fallback;
  }
  const output: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    const values = stringArray(entry);
    if (values.length) {
      output[key] = values;
    }
  }
  return { ...fallback, ...output };
}

function profilePathValue(profile: Record<string, unknown>, key: string, configPath?: string): string | undefined {
  const value = profile[key];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  const base = configPath ? path.dirname(configPath) : "";
  return path.normalize(path.join(base, value));
}

function mergeProfile(base: EnvAirProfile, raw: unknown): EnvAirProfile {
  if (!isRecord(raw)) {
    return base;
  }
  return {
    ...base,
    id: typeof raw.profileId === "string" ? raw.profileId : typeof raw.id === "string" ? raw.id : base.id,
    standardCatalog: Array.isArray(raw.standardCatalog) ? (raw.standardCatalog as EnvAirProfile["standardCatalog"]) : base.standardCatalog,
    envTerms: stringArray(raw.envTerms ?? raw.terms, base.envTerms),
    termAliases: recordOfStringArrays(raw.termAliases ?? raw.aliases, base.termAliases),
    pollutantFocusTerms: recordOfStringArrays(raw.pollutantFocusTerms, base.pollutantFocusTerms),
    dataObjectTerms: stringArray(raw.dataObjectTerms, base.dataObjectTerms),
    dataTimeTerms: stringArray(raw.dataTimeTerms, base.dataTimeTerms),
    dataLocationTerms: stringArray(raw.dataLocationTerms, base.dataLocationTerms),
    dataOperationTerms: stringArray(raw.dataOperationTerms, base.dataOperationTerms),
    explicitDataToolTerms: stringArray(raw.explicitDataToolTerms, base.explicitDataToolTerms),
    knowledgeOperationTerms: stringArray(raw.knowledgeOperationTerms, base.knowledgeOperationTerms),
    knowledgeHints: stringArray(raw.knowledgeHints, base.knowledgeHints),
    currentBasisHints: stringArray(raw.currentBasisHints, base.currentBasisHints),
    limitHints: stringArray(raw.limitHints, base.limitHints),
    aqiHints: stringArray(raw.aqiHints, base.aqiHints),
    monitoringMethodHints: stringArray(raw.monitoringMethodHints, base.monitoringMethodHints),
    authorityBoundaryHints: stringArray(raw.authorityBoundaryHints, base.authorityBoundaryHints),
    intentRules: Array.isArray(raw.intentRules) ? (raw.intentRules as EnvAirProfile["intentRules"]) : base.intentRules,
    topicSeeds: Array.isArray(raw.topicSeeds) ? (raw.topicSeeds as EnvAirProfile["topicSeeds"]) : base.topicSeeds,
    shortSlugAllowlist: stringArray(raw.shortSlugAllowlist, base.shortSlugAllowlist),
    sourceAnalysisSystemPrompt: stringArray(raw.sourceAnalysisSystemPrompt, base.sourceAnalysisSystemPrompt),
    topicSynthesisPromptLines: stringArray(raw.topicSynthesisPromptLines, base.topicSynthesisPromptLines)
  };
}

async function readPromptLines(rootDir: string, promptsDir: string | undefined, filename: string): Promise<string[] | undefined> {
  if (!promptsDir) {
    return undefined;
  }
  const absolutePath = path.resolve(rootDir, promptsDir, filename);
  if (!(await fileExists(absolutePath))) {
    return undefined;
  }
  const content = await fs.readFile(absolutePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function loadDomainProfile(rootDir: string, config: VaultConfig): Promise<LoadedDomainProfile> {
  let profile = DEFAULT_ENV_AIR_PROFILE;
  const domain = config.domain ?? {};
  const rawProfile = await readOptionalStructured(rootDir, domain.profilePath);
  profile = mergeProfile(profile, rawProfile);

  const profileRecord = isRecord(rawProfile) ? rawProfile : {};
  const profileBase = domain.profilePath;
  const referenced = {
    standardCatalog: profilePathValue(profileRecord, "standardCatalog", profileBase),
    terms: profilePathValue(profileRecord, "terms", profileBase),
    intentRules: profilePathValue(profileRecord, "intentRules", profileBase),
    rankingRules: profilePathValue(profileRecord, "rankingRules", profileBase),
    topicSeeds: profilePathValue(profileRecord, "topicSeeds", profileBase),
    promptsDir: profilePathValue(profileRecord, "promptsDir", profileBase)
  };

  const catalog = await readOptionalStructured(rootDir, referenced.standardCatalog);
  if (Array.isArray(catalog)) {
    profile = { ...profile, standardCatalog: catalog as EnvAirProfile["standardCatalog"] };
  }

  const terms = await readOptionalStructured(rootDir, domain.termsPath ?? referenced.terms);
  if (isRecord(terms)) {
    profile = mergeProfile(profile, {
      envTerms: terms.envTerms ?? terms.terms,
      termAliases: terms.termAliases ?? terms.aliases,
      pollutantFocusTerms: terms.pollutantFocusTerms,
      shortSlugAllowlist: terms.shortSlugAllowlist
    });
  }

  const intentRules = await readOptionalStructured(rootDir, referenced.intentRules);
  if (Array.isArray(intentRules)) {
    profile = { ...profile, intentRules: intentRules as EnvAirProfile["intentRules"] };
  }

  const topicSeeds = await readOptionalStructured(rootDir, referenced.topicSeeds);
  if (Array.isArray(topicSeeds)) {
    profile = { ...profile, topicSeeds: topicSeeds as EnvAirProfile["topicSeeds"] };
  }

  const promptsDir = domain.promptsDir ?? referenced.promptsDir;
  const sourcePrompt = await readPromptLines(rootDir, promptsDir, "source-analysis.system.md");
  const topicPrompt = await readPromptLines(rootDir, promptsDir, "topic-synthesis.system.md");
  return {
    ...profile,
    ...(sourcePrompt?.length ? { sourceAnalysisSystemPrompt: sourcePrompt } : {}),
    ...(topicPrompt?.length ? { topicSynthesisPromptLines: topicPrompt } : {})
  };
}

import type { ToolRoutingDecision } from "../types.js";
import { DEFAULT_ENV_AIR_PROFILE, type EnvAirStandardCatalogEntry } from "./env-air-profile.js";

export interface StandardReference {
  raw: string;
  family: string;
  number: string;
  year?: string;
  normalized: string;
  compact: string;
}

export type RecommendedNextTool = "knowledge_base" | "environment_data_mcp" | "both";

export interface EnvAirQueryPlan {
  normalizedQuery: string;
  standardRefs: StandardReference[];
  expandedTerms: string[];
  pinnedStandards: string[];
  rankingSignals: string[];
  currentBasisIntent: boolean;
  dataToolHints: string[];
  stages: Array<{
    name: string;
    status: "planned" | "used" | "skipped";
    reason?: string;
    resultCount?: number;
  }>;
}

const STANDARD_REFERENCE_PATTERN =
  /\b(?<family>GB\/T|GB|HJ\/T|HJ|DB[0-9]{2}\/T|DB[0-9]{2})\s*(?:[-‐‑‒–—― ]|\/)?\s*(?<number>[0-9]{2,6})(?:\s*(?:[-‐‑‒–—―:：])\s*(?<year>[0-9]{2,4}))?\b/giu;

const STANDARD_DASH_PATTERN = /[-‐‑‒–—―]/g;

export const ENV_AIR_STANDARD_CATALOG: EnvAirStandardCatalogEntry[] = DEFAULT_ENV_AIR_PROFILE.standardCatalog;

const ENV_AIR_TERMS = DEFAULT_ENV_AIR_PROFILE.envTerms;
const TERM_ALIASES: Record<string, string[]> = DEFAULT_ENV_AIR_PROFILE.termAliases;
const POLLUTANT_FOCUS_TERMS: Record<string, string[]> = DEFAULT_ENV_AIR_PROFILE.pollutantFocusTerms;
const DATA_OBJECT_TERMS = DEFAULT_ENV_AIR_PROFILE.dataObjectTerms;
const DATA_TIME_TERMS = DEFAULT_ENV_AIR_PROFILE.dataTimeTerms;
const DATA_LOCATION_TERMS = DEFAULT_ENV_AIR_PROFILE.dataLocationTerms;
const DATA_OPERATION_TERMS = DEFAULT_ENV_AIR_PROFILE.dataOperationTerms;
const EXPLICIT_DATA_TOOL_TERMS = DEFAULT_ENV_AIR_PROFILE.explicitDataToolTerms;
const KNOWLEDGE_OPERATION_TERMS = DEFAULT_ENV_AIR_PROFILE.knowledgeOperationTerms;
const KNOWLEDGE_HINTS = DEFAULT_ENV_AIR_PROFILE.knowledgeHints;
const CURRENT_BASIS_HINTS = DEFAULT_ENV_AIR_PROFILE.currentBasisHints;
const AUTHORITY_BOUNDARY_HINTS = DEFAULT_ENV_AIR_PROFILE.authorityBoundaryHints;

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeFamily(value: string): string {
  return value.toUpperCase().replace(/\s+/g, "");
}

function normalizeYear(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length === 2 ? `20${value}` : value;
}

export function compactStandardCode(value: string): string {
  return normalizeSpace(value)
    .toUpperCase()
    .replace(STANDARD_DASH_PATTERN, "-")
    .replace(/[\s/-]/g, "");
}

export function normalizePollutantName(value: string): string {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  for (const [canonical, aliases] of Object.entries(TERM_ALIASES)) {
    if (aliases.some((alias) => alias.toLowerCase().replace(/\s+/g, "") === normalized)) {
      return canonical;
    }
  }
  return value.trim();
}

export function extractStandardReferences(text: string): StandardReference[] {
  const references: StandardReference[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(STANDARD_REFERENCE_PATTERN)) {
    const groups = match.groups ?? {};
    const family = normalizeFamily(String(groups.family ?? ""));
    const number = String(groups.number ?? "");
    const year = normalizeYear(groups.year);
    if (!family || !number) {
      continue;
    }
    const normalized = year ? `${family} ${number}-${year}` : `${family} ${number}`;
    const compact = compactStandardCode(normalized);
    const key = compact;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    references.push({
      raw: normalizeSpace(match[0]),
      family,
      number,
      year,
      normalized,
      compact
    });
  }
  return references;
}

export function normalizeStandardCode(value: string): string {
  const first = extractStandardReferences(value)[0];
  return first?.normalized ?? normalizeSpace(value).toUpperCase();
}

export function standardIdentityKey(value: StandardReference | string | undefined): string {
  if (!value) {
    return "";
  }
  const ref = typeof value === "string" ? extractStandardReferences(value)[0] : value;
  if (!ref) {
    return normalizeSpace(String(value)).toUpperCase();
  }
  return `${ref.family} ${ref.number}`;
}

export function canonicalTitleForStandard(value: StandardReference | string | undefined): string | undefined {
  const identity = standardIdentityKey(value);
  return ENV_AIR_STANDARD_CATALOG.find((entry) => entry.identity === identity)?.title;
}

export function standardAliasGroupsForQuery(query: string): string[][] {
  const refs = extractStandardReferences(query);
  return refs.map((ref) => {
    const identity = standardIdentityKey(ref);
    const catalog = ENV_AIR_STANDARD_CATALOG.find((entry) => entry.identity === identity);
    const familyNumber = `${ref.family} ${ref.number}`;
    const familyCompact = `${ref.family}${ref.number}`;
    const versioned = ref.year ? `${ref.family} ${ref.number}-${ref.year}` : undefined;
    return uniqueCompact(
      [
        ref.raw,
        ref.normalized,
        ref.compact,
        familyNumber,
        familyCompact,
        versioned,
        catalog?.current,
        catalog?.title,
        ...(catalog?.aliases ?? [])
      ].filter((item): item is string => Boolean(item))
    );
  });
}

export function standardRefsForExactRetrieval(plan: EnvAirQueryPlan): StandardReference[] {
  const refs = [...plan.standardRefs, ...extractStandardReferences(plan.pinnedStandards.join(" "))];
  const seen = new Set<string>();
  const output: StandardReference[] = [];
  for (const ref of refs) {
    const key = `${ref.family}:${ref.number}:${ref.year ?? "*"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(ref);
  }
  return output;
}

export function inferCurrentBasisIntent(query: string): boolean {
  const compact = query.toLowerCase().replace(/\s+/g, "");
  return CURRENT_BASIS_HINTS.some((hint) => compact.includes(hint.toLowerCase().replace(/\s+/g, "")));
}

export function standardSearchTokens(references: StandardReference[]): string[] {
  const tokens: string[] = [];
  for (const ref of references) {
    tokens.push(ref.family.toLowerCase(), ref.number, ref.compact.toLowerCase());
    if (ref.year) {
      tokens.push(ref.year, `${ref.number}${ref.year}`);
    }
    tokens.push(ref.normalized.toLowerCase());
  }
  return uniqueCompact(tokens);
}

export function envAirSearchTerms(text: string): string[] {
  const compact = text.toLowerCase().replace(/\s+/g, "");
  const terms: string[] = [];
  for (const term of ENV_AIR_TERMS) {
    if (compact.includes(term.toLowerCase().replace(/\s+/g, ""))) {
      terms.push(term);
    }
  }
  for (const [canonical, aliases] of Object.entries(TERM_ALIASES)) {
    if (aliases.some((alias) => compact.includes(alias.toLowerCase().replace(/\s+/g, "")))) {
      terms.push(canonical, ...aliases);
    }
  }
  return uniqueCompact(terms);
}

export function buildEnvAirSearchText(input: { title: string; body: string; standardCode?: string; pollutants?: string[] }): string {
  const combined = [input.title, input.standardCode ?? "", input.body].join("\n");
  const standardRefs = extractStandardReferences(combined);
  const pollutantTerms = (input.pollutants ?? []).flatMap((pollutant) => [pollutant, normalizePollutantName(pollutant)]);
  return uniqueCompact([...standardSearchTokens(standardRefs), ...envAirSearchTerms(combined), ...pollutantTerms]).join(" ");
}

export function searchLikeTerms(query: string): string[] {
  const refs = extractStandardReferences(query);
  const refTerms = refs.flatMap((ref) => [
    ref.raw,
    ref.normalized,
    ref.compact,
    `${ref.family} ${ref.number}`,
    `${ref.family}${ref.number}`
  ]);
  const envTerms = envAirSearchTerms(query);
  const cjkTerms = (query.match(/[\p{Script=Han}]{2,24}/gu) ?? []).flatMap((term) => {
    if (term.length <= 8) {
      return [term];
    }
    return [term, ...envTerms.filter((known) => term.includes(known))];
  });
  const asciiTerms = query.match(/[a-z0-9][a-z0-9./-]{1,}/gi) ?? [];
  return uniqueCompact([...refTerms, ...envTerms, ...cjkTerms, ...asciiTerms]).slice(0, 24);
}

function includesAnyTerm(text: string, terms: string[]): boolean {
  const compact = text.toLowerCase().replace(/\s+/g, "");
  return terms.some((term) => compact.includes(term.toLowerCase().replace(/\s+/g, "")));
}

function pollutantFocus(query: string): string[] {
  const compact = query.toLowerCase().replace(/\s+/g, "");
  const pollutants: string[] = [];
  for (const [canonical, aliases] of Object.entries(TERM_ALIASES)) {
    if (aliases.some((alias) => compact.includes(alias.toLowerCase().replace(/\s+/g, "")))) {
      pollutants.push(canonical);
    }
  }
  return uniqueCompact(pollutants);
}

export function pollutantAliasGroupsForQuery(query: string, pollutants: string[] = []): string[][] {
  const requested = uniqueCompact([...pollutantFocus(query), ...pollutants.map(normalizePollutantName)]);
  return requested
    .filter((pollutant) => POLLUTANT_FOCUS_TERMS[pollutant])
    .map((pollutant) => uniqueCompact([pollutant, ...(TERM_ALIASES[pollutant] ?? [])]));
}

export function pollutantFocusTermsForQuery(query: string, pollutants: string[] = []): string[] {
  const requested = uniqueCompact([...pollutantFocus(query), ...pollutants.map(normalizePollutantName)]);
  const terms = requested.flatMap((pollutant) => POLLUTANT_FOCUS_TERMS[pollutant] ?? TERM_ALIASES[pollutant] ?? [pollutant]);
  return uniqueCompact([...terms, "浓度限值", "一级", "二级", "表"]);
}

export function inferAuthorityBoundaryIntent(query: string): boolean {
  const compact = query.toLowerCase().replace(/\s+/g, "");
  return AUTHORITY_BOUNDARY_HINTS.some((hint) => compact.includes(hint.toLowerCase().replace(/\s+/g, "")));
}

export function buildEnvAirQueryPlan(query: string): EnvAirQueryPlan {
  const normalizedQuery = query
    .replace(STANDARD_DASH_PATTERN, "-")
    .replace(/\bpm\s*2\s*\.?\s*5\b/gi, "PM2.5")
    .replace(/\bpm\s*1\s*0\b/gi, "PM10")
    .trim();
  const standardRefs = extractStandardReferences(normalizedQuery);
  const pollutants = pollutantFocus(normalizedQuery);
  const expandedTerms: string[] = [];
  const pinnedStandards: string[] = [];
  const rankingSignals: string[] = [];

  if (standardRefs.length) {
    pinnedStandards.push(...standardRefs.map((ref) => ref.normalized));
    expandedTerms.push(...standardRefs.map((ref) => canonicalTitleForStandard(ref)).filter((item): item is string => Boolean(item)));
    rankingSignals.push("explicit_standard_reference");
  }

  for (const rule of [...DEFAULT_ENV_AIR_PROFILE.intentRules].sort((left, right) => right.priority - left.priority)) {
    const textMatched = !rule.anyText?.length || includesAnyTerm(normalizedQuery, rule.anyText);
    const pollutantMatched = rule.anyPollutant !== true || pollutants.length > 0;
    if (!textMatched || !pollutantMatched) {
      continue;
    }
    expandedTerms.push(...(rule.expandedTerms ?? []));
    pinnedStandards.push(...(rule.pinnedStandards ?? []));
    rankingSignals.push(...(rule.rankingSignals ?? []));
  }

  return {
    normalizedQuery,
    standardRefs,
    expandedTerms: uniqueCompact(expandedTerms),
    pinnedStandards: uniqueCompact(pinnedStandards),
    rankingSignals: uniqueCompact(rankingSignals),
    currentBasisIntent: inferCurrentBasisIntent(normalizedQuery),
    dataToolHints: buildEnvironmentDataToolHints(normalizedQuery),
    stages: []
  };
}

export function classifyRecommendedNextTool(question: string): RecommendedNextTool {
  return classifyEnvAirToolRouting(question).finalNextTool;
}

function matchedTerms(question: string, terms: string[]): string[] {
  const compact = question.toLowerCase().replace(/\s+/g, "");
  return terms.filter((term) => compact.includes(term.toLowerCase().replace(/\s+/g, "")));
}

export function classifyEnvAirToolRouting(question: string): ToolRoutingDecision {
  const dataObjects = matchedTerms(question, DATA_OBJECT_TERMS);
  const dataTimes = matchedTerms(question, DATA_TIME_TERMS);
  const dataLocations = matchedTerms(question, DATA_LOCATION_TERMS);
  const dataOperations = matchedTerms(question, DATA_OPERATION_TERMS);
  const explicitDataTools = matchedTerms(question, EXPLICIT_DATA_TOOL_TERMS);
  const knowledgeSignals = uniqueCompact([
    ...matchedTerms(question, KNOWLEDGE_HINTS),
    ...matchedTerms(question, KNOWLEDGE_OPERATION_TERMS),
    ...extractStandardReferences(question).map((ref) => ref.normalized)
  ]);
  const dataSignals = uniqueCompact([...dataObjects, ...dataTimes, ...dataLocations, ...dataOperations, ...explicitDataTools]);
  const hasExplicitDataTool = explicitDataTools.length > 0;
  const hasConcreteDataObject = dataObjects.length > 0;
  const hasDataFrame = dataTimes.length > 0 || dataLocations.length > 0;
  const hasDataOperation = dataOperations.length > 0;
  const wantsData = hasExplicitDataTool || hasConcreteDataObject || (hasDataFrame && hasDataOperation);
  const wantsKnowledge = knowledgeSignals.length > 0;
  const reasons: string[] = [];
  if (wantsKnowledge) {
    reasons.push("knowledge_signals_present");
  }
  if (hasExplicitDataTool) {
    reasons.push("explicit_environment_data_mcp_request");
  } else if (hasConcreteDataObject) {
    reasons.push("monitoring_data_object_present");
  } else if (hasDataFrame && hasDataOperation) {
    reasons.push("data_time_or_location_plus_operation");
  }
  if (!wantsData && dataSignals.length) {
    reasons.push("data_terms_without_concrete_monitoring_request");
  }
  const finalNextTool: RecommendedNextTool = wantsData && wantsKnowledge ? "both" : wantsData ? "environment_data_mcp" : "knowledge_base";
  return {
    deterministicNextTool: finalNextTool,
    finalNextTool,
    reasons,
    dataSignals,
    knowledgeSignals,
    conflictResolvedBy: "deterministic_policy"
  };
}

export function buildEnvironmentDataToolHints(question: string): string[] {
  const routing = classifyEnvAirToolRouting(question);
  if (routing.finalNextTool === "knowledge_base") {
    return [];
  }
  const compact = question.toLowerCase().replace(/\s+/g, "");
  const hints: string[] = [];
  if (["今天", "昨日", "昨天", "本月", "今年", "小时值", "日均值", "月均值", "年均值"].some((term) => compact.includes(term))) {
    hints.push("需要调用环境数据 MCP 查询对应时间范围的监测浓度或统计值。");
  }
  if (["超标", "达标", "排名", "同比", "环比", "污染过程", "连续负值"].some((term) => compact.includes(term))) {
    hints.push("知识库只能提供评价依据和计算口径，是否超标或排名需要环境数据 MCP 返回实际数据后判断。");
  }
  if (["站点", "城市", "区域", "省", "市"].some((term) => compact.includes(term))) {
    hints.push("需要在环境数据 MCP 参数中明确地区、城市、站点或行政区范围。");
  }
  return uniqueCompact(hints);
}

export function authorityLayerRank(value: string | undefined): number {
  switch (value) {
    case "core":
      return 0;
    case "method":
      return 1;
    case "local":
      return 2;
    case "evidence":
      return 3;
    case "evolution":
      return 4;
    case "project":
      return 5;
    default:
      return 6;
  }
}

function uniqueCompact(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeSpace(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

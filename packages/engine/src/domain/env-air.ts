import type { EnvAirTemporalIntent, ToolRoutingDecision } from "../types.js";
import { DEFAULT_ENV_AIR_PROFILE, type EnvAirProfile, type EnvAirStandardCatalogEntry } from "./env-air-profile.js";

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
  decomposedIntent: EnvAirDecomposedIntent;
  expandedTerms: string[];
  pinnedStandards: string[];
  standardClusters: string[];
  rankingSignals: string[];
  factTypeBoosts: Record<string, number>;
  documentRoleBoosts: Record<string, number>;
  evidenceRoleBoosts: Record<string, number>;
  chunkTermBoosts: Record<string, number>;
  routePolicies: Array<"knowledge" | "data" | "both" | "defer">;
  matchedIntentRules: string[];
  currentBasisIntent: boolean;
  temporalIntent: EnvAirTemporalIntent;
  dataToolHints: string[];
  stages: Array<{
    name: string;
    status: "planned" | "used" | "skipped";
    reason?: string;
    resultCount?: number;
  }>;
}

export interface EnvAirDecomposedIntent {
  objectScopes: string[];
  pollutants: string[];
  businessActions: string[];
  evidenceNeeds: string[];
  authorityNeeds: string[];
}

const STANDARD_REFERENCE_PATTERN =
  /\b(?<family>GB\/T|GB|HJ\/T|HJ|DB[0-9]{2}\/T|DB[0-9]{2})\s*(?:[-‐‑‒–—― ]|\/)?\s*(?<number>[0-9]{2,6})(?:\s*(?:[-‐‑‒–—―:：])\s*(?<year>[0-9]{2,4}))?\b/giu;

const STANDARD_DASH_PATTERN = /[-‐‑‒–—―]/g;

export const ENV_AIR_STANDARD_CATALOG: EnvAirStandardCatalogEntry[] = DEFAULT_ENV_AIR_PROFILE.standardCatalog;

const ENV_AIR_TERMS = DEFAULT_ENV_AIR_PROFILE.envTerms;
const TERM_ALIASES: Record<string, string[]> = DEFAULT_ENV_AIR_PROFILE.termAliases;
const POLLUTANT_FOCUS_TERMS: Record<string, string[]> = DEFAULT_ENV_AIR_PROFILE.pollutantFocusTerms;

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mergeBoosts(target: Record<string, number>, next: Record<string, number> | undefined): void {
  if (!next) {
    return;
  }
  for (const [key, value] of Object.entries(next)) {
    const parsed = Number(value);
    if (!key || !Number.isFinite(parsed)) {
      continue;
    }
    target[key] = Math.max(target[key] ?? 0, Math.max(0, Math.min(10, parsed)));
  }
}

function standardsForClusters(profile: EnvAirProfile, clusterIds: string[]): string[] {
  const clusters = new Set(clusterIds);
  return [
    ...profile.standardClusters.filter((cluster) => clusters.has(cluster.id)).flatMap((cluster) => cluster.standards),
    ...profile.standardCatalog
      .filter((entry) => entry.clusterIds?.some((clusterId) => clusters.has(clusterId)))
      .map((entry) => entry.identity)
  ];
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

export function canonicalTitleForStandard(
  value: StandardReference | string | undefined,
  profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE
): string | undefined {
  const identity = standardIdentityKey(value);
  return profile.standardCatalog.find((entry) => entry.identity === identity)?.title;
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

export function inferCurrentBasisIntent(query: string, profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE): boolean {
  const compact = query.toLowerCase().replace(/\s+/g, "");
  return profile.currentBasisHints.some((hint) => compact.includes(hint.toLowerCase().replace(/\s+/g, "")));
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

function pollutantFocus(query: string, profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE): string[] {
  const compact = query.toLowerCase().replace(/\s+/g, "");
  const pollutants: string[] = [];
  for (const [canonical, aliases] of Object.entries(profile.termAliases)) {
    if (aliases.some((alias) => compact.includes(alias.toLowerCase().replace(/\s+/g, "")))) {
      pollutants.push(canonical);
    }
  }
  return uniqueCompact(pollutants);
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function decomposeEnvAirQueryIntent(query: string, profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE): EnvAirDecomposedIntent {
  const normalized = query.replace(STANDARD_DASH_PATTERN, "-").trim();
  const pollutants = pollutantFocus(normalized, profile);
  const objectScopes: string[] = [];
  const businessActions: string[] = [];
  const evidenceNeeds: string[] = [];
  const authorityNeeds: string[] = [];

  const mentionsFixedSource = hasAnyPattern(normalized, [/固定污染源/u, /固定源/u, /烟气/u, /\bCEMS\b/iu, /排口/u, /烟囱/u]);
  const mentionsPollutionSourceAutoMonitoring = hasAnyPattern(normalized, [
    /污染源自动监控/u,
    /自动监控设施/u,
    /自动监控管理/u,
    /自动监控系统/u,
    /在线监控/u,
    /在线监测/u,
    /在线设备/u,
    /在线数据/u,
    /排污单位/u,
    /运维单位/u,
    /数采仪/u,
    /采样探头/u
  ]);
  const mentionsAmbientAutoMonitoring =
    hasAnyPattern(normalized, [/环境空气/u, /自动站/u, /空气站/u, /国控站/u, /省控站/u, /站点/u, /连续自动监测/u, /自动监测系统/u]) &&
    !mentionsFixedSource;

  if (mentionsAmbientAutoMonitoring) objectScopes.push("ambient_air_auto_monitoring");
  if (mentionsFixedSource) objectScopes.push("fixed_source_cems");
  if (mentionsPollutionSourceAutoMonitoring) objectScopes.push("pollution_source_auto_monitoring");
  if (hasAnyPattern(normalized, [/AQI/iu, /IAQI/iu, /空气质量指数/u, /首要污染物/u, /空气质量级别/u, /日报/u, /实时报/u])) {
    objectScopes.push("ambient_aqi");
  }
  if (hasAnyPattern(normalized, [/达标评价/u, /年评价/u, /空气质量评价/u, /评价技术/u, /第\s*90\s*百分位/u, /百分位/u])) {
    objectScopes.push("ambient_quality_assessment");
  }
  if (hasAnyPattern(normalized, [/重污染天气/u, /污染过程/u, /应急预警/u, /应急响应/u, /应急减排/u, /绩效分级/u, /秋冬季/u])) {
    objectScopes.push("heavy_pollution_weather");
  }

  if (pollutants.some((item) => item === "PM2.5" || item === "PM10") || /颗粒物/u.test(normalized)) {
    objectScopes.push("particulate_monitoring");
  }
  if (pollutants.some((item) => ["SO2", "NO2", "O3", "CO", "NOx"].includes(item)) || /气态污染物|二氧化氮|臭氧/u.test(normalized)) {
    objectScopes.push("gas_monitoring");
  }

  if (hasAnyPattern(normalized, [/安装/u, /验收/u, /调试/u, /试运行/u, /到货/u, /新建/u])) {
    businessActions.push("installation_acceptance");
  }
  if (
    hasAnyPattern(normalized, [
      /运行/u,
      /质控/u,
      /质量控制/u,
      /质量保证/u,
      /校准/u,
      /零点/u,
      /跨度/u,
      /量程/u,
      /漂移/u,
      /转换炉/u,
      /转换器/u,
      /负值/u,
      /零值/u,
      /有效数据/u,
      /平行性/u,
      /流量/u,
      /维护/u
    ])
  ) {
    businessActions.push("operation_qaqc");
  }
  if (hasAnyPattern(normalized, [/技术要求/u, /检测方法/u, /性能/u, /测试/u, /检测项目/u, /性能指标/u, /采购检测/u, /仪器检测/u])) {
    businessActions.push("technical_test_method");
  }
  if (hasAnyPattern(normalized, [/参比/u, /重量法/u, /手工比对/u, /手工采样/u, /滤膜/u, /称量/u])) {
    businessActions.push("reference_method");
  }
  if (hasAnyPattern(normalized, [/数据传输/u, /传输协议/u, /数据链路/u, /上传/u, /联网/u, /数采仪/u, /协议/u, /报文/u, /通信/u])) {
    businessActions.push("data_transmission");
  }
  if (hasAnyPattern(normalized, [/现场/u, /检查/u, /执法/u, /处罚/u, /违法/u, /认定/u, /证据/u, /弄虚作假/u, /直接/u])) {
    businessActions.push("enforcement_inspection");
  }
  if (
    hasAnyPattern(normalized, [
      /管理/u,
      /职责/u,
      /责任/u,
      /运维/u,
      /停运/u,
      /停用/u,
      /停机/u,
      /停了/u,
      /拆除/u,
      /故障/u,
      /报告/u,
      /备案/u,
      /更换/u,
      /恢复/u
    ])
  ) {
    businessActions.push("management_responsibility");
  }
  if (hasAnyPattern(normalized, [/月报/u, /公报/u, /排名/u, /统计/u, /同比/u, /环比/u, /168\s*城/u, /337\s*城/u, /339\s*城/u])) {
    businessActions.push("statistics_reporting");
  }

  if (
    hasAnyPattern(normalized, [
      /包括哪些/u,
      /有哪些/u,
      /完整清单/u,
      /全部项目/u,
      /所有项目/u,
      /项目清单/u,
      /测试项目/u,
      /测试项/u,
      /检测项目/u,
      /检测项/u,
      /检查项目/u,
      /检查项/u,
      /验收项目/u,
      /质控项目/u,
      /性能指标/u,
      /评价指标/u,
      /监测项目/u,
      /要点/u,
      /步骤/u,
      /看什么/u,
      /查什么/u,
      /测什么/u
    ])
  ) {
    evidenceNeeds.push("list_complete");
  }
  if (hasAnyPattern(normalized, [/多久/u, /频次/u, /多长时间/u, /几次/u, /周期/u, /每年/u, /每月/u, /每周/u, /每日/u, /每半年/u])) {
    evidenceNeeds.push("frequency");
  }
  if (hasAnyPattern(normalized, [/限值/u, /标准值/u, /一级/u, /二级/u, /浓度限值/u, /超标/u, /达标/u])) {
    evidenceNeeds.push("limit_or_compliance");
  }
  if (hasAnyPattern(normalized, [/程序/u, /流程/u, /手续/u, /备案/u, /报告/u, /恢复/u, /责任/u])) {
    evidenceNeeds.push("procedure_or_responsibility");
  }
  if (inferAuthorityBoundaryIntent(normalized, profile)) {
    authorityNeeds.push("authority_boundary");
  }
  if (inferCurrentBasisIntent(normalized, profile)) {
    authorityNeeds.push("current_effective_basis");
  }

  if (!objectScopes.length && hasAnyPattern(normalized, [/环境空气/u, /空气质量/u, /污染物/u, /监测/u])) {
    objectScopes.push("ambient_air");
  }

  return {
    objectScopes: uniqueCompact(objectScopes),
    pollutants,
    businessActions: uniqueCompact(businessActions),
    evidenceNeeds: uniqueCompact(evidenceNeeds),
    authorityNeeds: uniqueCompact(authorityNeeds)
  };
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

export function inferAuthorityBoundaryIntent(query: string, profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE): boolean {
  const compact = query.toLowerCase().replace(/\s+/g, "");
  return profile.authorityBoundaryHints.some((hint) => compact.includes(hint.toLowerCase().replace(/\s+/g, "")));
}

export function inferEnvAirTemporalIntent(
  query: string,
  options: { asOfDate?: string; evaluationPeriod?: string; evaluationYear?: number } = {},
  profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE
): EnvAirTemporalIntent {
  const currentIntent = inferCurrentBasisIntent(query, profile);
  const historicalIntent = /(当时|彼时|历史|旧版|老版|废止|替代|代替|版本|沿革|演化)/u.test(query);
  const explicitYear = options.evaluationYear ?? Number(query.match(/(?:^|[^\d])((?:19|20)\d{2})\s*年/u)?.[1] ?? NaN);
  const hasEvaluationContext = /(评价|年均|年平均|报告|考核|达标|期间|年度)/u.test(query) || Boolean(options.evaluationPeriod);
  const evaluationPeriodYear = Number.isFinite(explicitYear) && hasEvaluationContext ? explicitYear : undefined;
  const asOfYear = options.asOfDate?.match(/^(\d{4})/)?.[1];
  const mode: EnvAirTemporalIntent["mode"] = evaluationPeriodYear
    ? "evaluation_period"
    : historicalIntent
      ? "historical_as_of"
      : currentIntent
        ? "current_now"
        : "unspecified";
  return {
    ...(options.asOfDate ? { asOfDate: options.asOfDate } : {}),
    ...(asOfYear ? { asOfYear: Number(asOfYear) } : {}),
    ...(options.evaluationPeriod ? { evaluationPeriod: options.evaluationPeriod } : {}),
    ...(evaluationPeriodYear ? { evaluationPeriodYear } : {}),
    mode,
    ...(currentIntent && evaluationPeriodYear ? { conflict: "current_vs_evaluation_period" as const } : {}),
    ...(currentIntent && historicalIntent ? { conflict: "current_vs_historical_version" as const } : {})
  };
}

export function buildEnvAirQueryPlan(
  query: string,
  profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE,
  options: { asOfDate?: string; evaluationPeriod?: string; evaluationYear?: number } = {}
): EnvAirQueryPlan {
  const normalizedQuery = query
    .replace(STANDARD_DASH_PATTERN, "-")
    .replace(/\bpm\s*2\s*\.?\s*5\b/gi, "PM2.5")
    .replace(/\bpm\s*1\s*0\b/gi, "PM10")
    .trim();
  const standardRefs = extractStandardReferences(normalizedQuery);
  const decomposedIntent = decomposeEnvAirQueryIntent(normalizedQuery, profile);
  const pollutants = pollutantFocus(normalizedQuery, profile);
  const expandedTerms: string[] = [];
  const pinnedStandards: string[] = [];
  const standardClusters: string[] = [];
  const rankingSignals: string[] = [];
  const factTypeBoosts: Record<string, number> = {};
  const documentRoleBoosts: Record<string, number> = {};
  const evidenceRoleBoosts: Record<string, number> = {};
  const chunkTermBoosts: Record<string, number> = {};
  const routePolicies: Array<"knowledge" | "data" | "both" | "defer"> = [];
  const matchedIntentRules: string[] = [];

  if (standardRefs.length) {
    pinnedStandards.push(...standardRefs.map((ref) => ref.normalized));
    expandedTerms.push(
      ...standardRefs.map((ref) => canonicalTitleForStandard(ref, profile)).filter((item): item is string => Boolean(item))
    );
    rankingSignals.push("explicit_standard_reference");
  }

  for (const rule of [...profile.intentRules].sort((left, right) => right.priority - left.priority)) {
    const textMatched = !rule.anyText?.length || includesAnyTerm(normalizedQuery, rule.anyText);
    const allMatched = !rule.allText?.length || rule.allText.every((term) => includesAnyTerm(normalizedQuery, [term]));
    const groupMatched =
      !rule.anyTermGroups?.length ||
      rule.anyTermGroups.some((group) => group.length > 0 && group.every((term) => includesAnyTerm(normalizedQuery, [term])));
    const pollutantMatched = rule.anyPollutant !== true || pollutants.length > 0;
    if (!textMatched || !allMatched || !groupMatched || !pollutantMatched) {
      continue;
    }
    expandedTerms.push(...(rule.expandedTerms ?? []));
    pinnedStandards.push(...(rule.pinnedStandards ?? []));
    standardClusters.push(...(rule.standardClusters ?? []));
    pinnedStandards.push(...standardsForClusters(profile, rule.standardClusters ?? []));
    rankingSignals.push(...(rule.rankingSignals ?? []));
    mergeBoosts(factTypeBoosts, rule.factTypeBoosts);
    mergeBoosts(documentRoleBoosts, rule.documentRoleBoosts);
    mergeBoosts(evidenceRoleBoosts, rule.evidenceRoleBoosts);
    mergeBoosts(chunkTermBoosts, rule.chunkTermBoosts);
    if (rule.routePolicy) {
      routePolicies.push(rule.routePolicy);
    }
    matchedIntentRules.push(rule.id);
  }

  const hasScope = (scope: string): boolean => decomposedIntent.objectScopes.includes(scope);
  const hasAction = (action: string): boolean => decomposedIntent.businessActions.includes(action);
  const hasNeed = (need: string): boolean => decomposedIntent.evidenceNeeds.includes(need);
  const addSignal = (input: {
    signal: string;
    standards?: string[];
    clusters?: string[];
    terms?: string[];
    factBoosts?: Record<string, number>;
    documentBoosts?: Record<string, number>;
    evidenceBoosts?: Record<string, number>;
    chunkBoosts?: Record<string, number>;
  }): void => {
    rankingSignals.push(input.signal);
    expandedTerms.push(...(input.terms ?? []));
    pinnedStandards.push(...(input.standards ?? []));
    standardClusters.push(...(input.clusters ?? []));
    pinnedStandards.push(...standardsForClusters(profile, input.clusters ?? []));
    mergeBoosts(factTypeBoosts, input.factBoosts);
    mergeBoosts(documentRoleBoosts, input.documentBoosts);
    mergeBoosts(evidenceRoleBoosts, input.evidenceBoosts);
    mergeBoosts(chunkTermBoosts, input.chunkBoosts);
  };

  if (hasNeed("list_complete")) {
    addSignal({
      signal: "list_complete_question",
      factBoosts: { technical_parameter: 6, method_step: 5, validity_rule: 4 },
      documentBoosts: { standard: 5, monitoring_method: 5, qa_qc: 4, technical_regulation: 4 },
      evidenceBoosts: { current_authority: 4, method: 5 },
      chunkBoosts: { 表: 5, 清单: 4, 项目: 5, 指标: 4, 要求: 3 }
    });
  }

  if (hasScope("ambient_aqi")) {
    addSignal({
      signal: "decomposed_ambient_aqi",
      standards: ["HJ 633", "HJ 633-2026"],
      clusters: ["ambient_quality_core"],
      terms: ["环境空气质量指数", "AQI", "IAQI", "首要污染物", "日报和实时报"],
      factBoosts: { formula: 4, technical_parameter: 3 },
      documentBoosts: { standard: 5, technical_regulation: 5, statistics: 1 }
    });
  }
  if (hasScope("ambient_quality_assessment")) {
    addSignal({
      signal: "decomposed_ambient_quality_assessment",
      standards: ["HJ 663", "HJ 663-2026"],
      clusters: ["ambient_quality_core"],
      terms: ["环境空气质量评价技术规范", "达标评价", "评价项目和评价方法"],
      factBoosts: { validity_rule: 5, formula: 3, limit_value: 2 },
      documentBoosts: { standard: 5, technical_regulation: 4, statistics: 1 }
    });
  }
  if (hasNeed("limit_or_compliance") && (decomposedIntent.pollutants.length > 0 || hasScope("ambient_air"))) {
    addSignal({
      signal: "decomposed_ambient_limit_or_compliance",
      standards: ["GB 3095", "GB 3095-2026"],
      clusters: ["ambient_quality_core"],
      terms: ["环境空气质量标准", "环境空气质量标准限值"],
      factBoosts: { limit_value: 6, formula: 2 },
      documentBoosts: { standard: 6, statistics: 1 }
    });
  }

  if (hasScope("ambient_air_auto_monitoring") || hasScope("particulate_monitoring") || hasScope("gas_monitoring")) {
    if (hasScope("particulate_monitoring")) {
      if (hasAction("reference_method")) {
        addSignal({
          signal: "decomposed_particulate_reference_method",
          standards: ["HJ 618", "HJ 618-2011", "HJ 653"],
          clusters: ["ambient_manual_sampling_analysis"],
          terms: ["重量法", "参比方法", "手工采样", "滤膜称量"],
          factBoosts: { method_step: 5, technical_parameter: 4 },
          documentBoosts: { monitoring_method: 5, standard: 4 }
        });
      }
      if (hasAction("installation_acceptance")) {
        addSignal({
          signal: "decomposed_particulate_installation_acceptance",
          standards: ["HJ 655"],
          clusters: ["ambient_auto_monitoring_acceptance"],
          terms: ["颗粒物连续自动监测系统安装和验收技术规范", "安装验收", "验收检查"],
          factBoosts: { technical_parameter: 4, method_step: 4 },
          documentBoosts: { monitoring_method: 5, qa_qc: 4 }
        });
      }
      if (hasAction("technical_test_method") || (hasNeed("list_complete") && !hasAction("operation_qaqc"))) {
        addSignal({
          signal: "decomposed_particulate_technical_test_method",
          standards: ["HJ 653"],
          terms: ["颗粒物连续自动监测系统技术要求及检测方法", "性能指标", "检测方法"],
          factBoosts: { technical_parameter: 7, method_step: 5 },
          documentBoosts: { monitoring_method: 6, standard: 4 },
          chunkBoosts: { 性能指标: 6, 检测项目: 6, 检测方法: 4 }
        });
      }
      if (hasAction("operation_qaqc") && !hasAction("reference_method")) {
        addSignal({
          signal: "decomposed_particulate_operation_qaqc",
          standards: ["HJ 817"],
          clusters: ["ambient_auto_monitoring_operation_qaqc"],
          terms: ["颗粒物连续自动监测系统运行和质控技术规范", "运行质控", "质量控制"],
          factBoosts: { technical_parameter: 5, validity_rule: 5, method_step: 4 },
          documentBoosts: { qa_qc: 6, monitoring_method: 4 }
        });
      }
    }
    if (hasScope("gas_monitoring")) {
      if (hasAction("installation_acceptance")) {
        addSignal({
          signal: "decomposed_gas_installation_acceptance",
          standards: ["HJ 193", "HJ 654"],
          clusters: ["ambient_auto_monitoring_acceptance"],
          terms: ["气态污染物连续自动监测系统安装验收", "调试检测"],
          factBoosts: { technical_parameter: 4, method_step: 4 },
          documentBoosts: { monitoring_method: 5, qa_qc: 4 }
        });
      }
      if (hasAction("technical_test_method")) {
        addSignal({
          signal: "decomposed_gas_technical_test_method",
          standards: ["HJ 654"],
          terms: ["气态污染物连续自动监测系统技术要求及检测方法", "气态仪器性能指标"],
          factBoosts: { technical_parameter: 6, method_step: 5 },
          documentBoosts: { monitoring_method: 6, standard: 4 }
        });
      }
      if (hasAction("operation_qaqc") || /转换炉|转换器|零跨|零点|跨度/u.test(normalizedQuery)) {
        addSignal({
          signal: "decomposed_gas_operation_qaqc",
          standards: ["HJ 818", "HJ 654"],
          clusters: ["ambient_auto_monitoring_operation_qaqc"],
          terms: ["气态污染物连续自动监测系统运行和质控技术规范", "运行质控", "转换炉效率", "零点跨度"],
          factBoosts: { technical_parameter: 6, validity_rule: 4, method_step: 4 },
          documentBoosts: { qa_qc: 6, monitoring_method: 4 }
        });
      }
      if (/化学发光法|氮氧化物|NOx/iu.test(normalizedQuery)) {
        addSignal({
          signal: "decomposed_gas_measurement_method",
          standards: ["HJ 1043"],
          clusters: ["ambient_gas_measurement_methods"],
          terms: ["氮氧化物自动测定", "化学发光法"],
          factBoosts: { method_step: 5, technical_parameter: 4 },
          documentBoosts: { monitoring_method: 5 }
        });
      }
    }
  }

  if (hasScope("fixed_source_cems")) {
    if (hasAction("data_transmission")) {
      addSignal({
        signal: "decomposed_fixed_source_cems_data_transmission",
        standards: ["HJ 212", "HJ 212-2025"],
        clusters: ["fixed_source_cems"],
        terms: ["污染物在线监控系统数据传输标准", "数据传输", "数采仪"],
        factBoosts: { technical_parameter: 5, method_step: 4 },
        documentBoosts: { standard: 5, technical_regulation: 4 },
        chunkBoosts: { 数据传输: 6, 数采仪: 5, 传输协议: 5 }
      });
    } else if (hasAction("technical_test_method")) {
      addSignal({
        signal: "decomposed_fixed_source_cems_technical_test_method",
        standards: ["HJ 76", "HJ 76-2017"],
        clusters: ["fixed_source_cems"],
        terms: ["固定污染源烟气排放连续监测系统技术要求及检测方法", "CEMS技术要求"],
        factBoosts: { technical_parameter: 6, method_step: 5 },
        documentBoosts: { monitoring_method: 5, standard: 5 }
      });
    } else if (hasAction("operation_qaqc") || hasAction("management_responsibility")) {
      addSignal({
        signal: "decomposed_fixed_source_cems_operation_qaqc",
        standards: ["HJ 75", "HJ 75-2017"],
        clusters: ["fixed_source_cems"],
        terms: ["固定污染源烟气排放连续监测技术规范", "CEMS运行维护", "运行质控"],
        factBoosts: { technical_parameter: 5, validity_rule: 5, method_step: 4 },
        documentBoosts: { monitoring_method: 5, standard: 5 }
      });
      if (hasAction("management_responsibility")) {
        addSignal({
          signal: "decomposed_fixed_source_cems_management_boundary",
          standards: ["国家环保总局令第28号"],
          clusters: ["pollution_source_auto_monitoring_enforcement"],
          terms: ["污染源自动监控管理办法", "自动监控设施管理", "停运故障管理"],
          factBoosts: { status_rule: 5, method_step: 4 },
          documentBoosts: { regulation: 6, law: 5, technical_regulation: 3 },
          evidenceBoosts: { current_authority: 6, method: 2 }
        });
      }
    } else {
      addSignal({
        signal: "decomposed_fixed_source_cems",
        standards: ["HJ 75", "HJ 76", "HJ 212"],
        clusters: ["fixed_source_cems"],
        terms: ["固定污染源", "CEMS", "烟气连续监测"]
      });
    }
  }

  if (hasScope("pollution_source_auto_monitoring") && hasAction("data_transmission")) {
    addSignal({
      signal: "decomposed_pollution_source_data_transmission",
      standards: ["HJ 212", "HJ 212-2025"],
      clusters: ["fixed_source_cems"],
      terms: ["污染物在线监控系统数据传输标准", "数据传输", "报文", "通信", "数采仪"],
      factBoosts: { technical_parameter: 5, method_step: 4 },
      documentBoosts: { standard: 5, technical_regulation: 4 },
      evidenceBoosts: { current_authority: 4, method: 5 },
      chunkBoosts: { 数据传输: 6, 报文: 5, 通信: 5, 数采仪: 5, 传输协议: 5 }
    });
  }

  if (hasScope("pollution_source_auto_monitoring")) {
    const wantsInspection = hasAction("enforcement_inspection");
    const wantsManagement = hasAction("management_responsibility") || !wantsInspection;
    addSignal({
      signal: "decomposed_pollution_source_auto_monitoring",
      standards: [...(wantsInspection ? ["环境保护部令第19号"] : []), ...(wantsManagement ? ["国家环保总局令第28号"] : [])],
      clusters: ["pollution_source_auto_monitoring_enforcement"],
      terms: ["污染源自动监控", "现场监督检查", "管理办法"],
      factBoosts: { status_rule: 4, method_step: 4, technical_parameter: 2 },
      documentBoosts: { regulation: 6, law: 5, technical_regulation: 4 },
      evidenceBoosts: { current_authority: 6, method: 2 }
    });
  }

  if (hasScope("heavy_pollution_weather")) {
    addSignal({
      signal: "decomposed_heavy_pollution_weather",
      clusters: ["heavy_pollution_weather_policy"],
      terms: ["重污染天气", "应急预警", "应急减排", "绩效分级", "秋冬季攻坚"],
      documentBoosts: { policy: 5, technical_guide: 4, regulation: 4, research_literature: 1, statistics: 1 },
      evidenceBoosts: { current_authority: 4, method: 3, research: 1, statistics: 1 }
    });
  }

  const temporalIntent = inferEnvAirTemporalIntent(normalizedQuery, options, profile);
  if (temporalIntent.mode === "evaluation_period") {
    rankingSignals.push("evaluation_period_question");
  } else if (temporalIntent.mode === "historical_as_of") {
    rankingSignals.push("historical_as_of_question");
  }

  return {
    normalizedQuery,
    standardRefs,
    decomposedIntent,
    expandedTerms: uniqueCompact(expandedTerms),
    pinnedStandards: uniqueCompact(pinnedStandards),
    standardClusters: uniqueCompact(standardClusters),
    rankingSignals: uniqueCompact(rankingSignals),
    factTypeBoosts,
    documentRoleBoosts,
    evidenceRoleBoosts,
    chunkTermBoosts,
    routePolicies: uniqueCompact(routePolicies) as Array<"knowledge" | "data" | "both" | "defer">,
    matchedIntentRules: uniqueCompact(matchedIntentRules),
    currentBasisIntent: inferCurrentBasisIntent(normalizedQuery, profile),
    temporalIntent,
    dataToolHints: buildEnvironmentDataToolHints(normalizedQuery, profile),
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

export function classifyEnvAirToolRouting(question: string, profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE): ToolRoutingDecision {
  const normalizedQuestion = question
    .replace(STANDARD_DASH_PATTERN, "-")
    .replace(/\bpm\s*2\s*\.?\s*5\b/gi, "PM2.5")
    .replace(/\bpm\s*1\s*0\b/gi, "PM10")
    .trim();
  const pollutants = pollutantFocus(normalizedQuestion, profile);
  const routePolicies: Array<"knowledge" | "data" | "both" | "defer"> = [];
  for (const rule of [...profile.intentRules].sort((left, right) => right.priority - left.priority)) {
    const textMatched = !rule.anyText?.length || includesAnyTerm(normalizedQuestion, rule.anyText);
    const allMatched = !rule.allText?.length || rule.allText.every((term) => includesAnyTerm(normalizedQuestion, [term]));
    const groupMatched =
      !rule.anyTermGroups?.length ||
      rule.anyTermGroups.some((group) => group.length > 0 && group.every((term) => includesAnyTerm(normalizedQuestion, [term])));
    const pollutantMatched = rule.anyPollutant !== true || pollutants.length > 0;
    if (textMatched && allMatched && groupMatched && pollutantMatched && rule.routePolicy) {
      routePolicies.push(rule.routePolicy);
    }
  }
  const dataObjects = matchedTerms(question, profile.dataObjectTerms);
  const dataTimes = matchedTerms(question, profile.dataTimeTerms);
  const dataLocations = matchedTerms(question, profile.dataLocationTerms);
  const dataOperations = matchedTerms(question, profile.dataOperationTerms);
  const explicitDataTools = matchedTerms(question, profile.explicitDataToolTerms);
  const basisOnlySignals = matchedTerms(question, profile.basisOnlyTerms);
  const standardReferences = extractStandardReferences(question);
  const knowledgeSignals = uniqueCompact([
    ...matchedTerms(question, profile.knowledgeHints),
    ...matchedTerms(question, profile.knowledgeOperationTerms),
    ...standardReferences.map((ref) => ref.normalized)
  ]);
  const dataSignals = uniqueCompact([...dataObjects, ...dataTimes, ...dataLocations, ...dataOperations, ...explicitDataTools]);
  const hasExplicitDataTool = explicitDataTools.length > 0;
  const hasConcreteDataObject = dataObjects.length > 0;
  const hasDataFrame = dataTimes.length > 0 || dataLocations.length > 0;
  const hasDataOperation = dataOperations.length > 0;
  const hasBoundaryQuestion =
    /(能否|能不能|是否可以|可否|能不能直接|能否直接|是否能|是否属于).{0,18}(作为|替代|用于|执行|处罚|依据|结论|法定义务)|边界|区别/u.test(
      question
    );
  const hasReportDraftRequest = /(写|撰写|生成|起草).{0,12}(月报|年报|公报|报告|分析|汇报)|月报分析|报告分析/u.test(question);
  const hasStandardKnowledgeContext =
    standardReferences.length > 0 ||
    /(标准|规范|导则|指南|依据|限值|评价方法|技术要求|质控要求|验收要求|合格要求|频次|多久)/u.test(question);
  const hasAirQualityStatus = /(空气质量|污染|优良|轻度|中度|重度|严重|aqi|iaqi|浓度|超标|达标)/iu.test(question);
  const hasTimeLocationStatus = dataTimes.length > 0 && dataLocations.length > 0 && hasAirQualityStatus;
  const actualDataAction =
    hasExplicitDataTool ||
    hasTimeLocationStatus ||
    (!hasBoundaryQuestion &&
      hasDataFrame &&
      /(是否超标|排名|同比|环比|过程分析|异常|查询|统计|计算|第\s*90\s*百分位|百分位|MDA8)/u.test(question)) ||
    (!hasBoundaryQuestion && !hasStandardKnowledgeContext && /实测|实际监测|监测数据|原始数据|站点数据/u.test(question));
  const basisOnlyQuestion = basisOnlySignals.length > 0 && !actualDataAction;
  const ruleWantsData = routePolicies.includes("data") || routePolicies.includes("both");
  const ruleWantsKnowledge = routePolicies.includes("knowledge") || routePolicies.includes("both");
  const wantsData =
    !basisOnlyQuestion &&
    !hasBoundaryQuestion &&
    (ruleWantsData ||
      hasExplicitDataTool ||
      hasTimeLocationStatus ||
      (actualDataAction && hasConcreteDataObject) ||
      (hasDataFrame && hasDataOperation));
  const wantsKnowledge = hasBoundaryQuestion || hasReportDraftRequest || ruleWantsKnowledge || knowledgeSignals.length > 0;
  const reasons: string[] = [];
  if (wantsKnowledge) {
    reasons.push("knowledge_signals_present");
  }
  if (hasExplicitDataTool) {
    reasons.push("explicit_environment_data_mcp_request");
  } else if (hasBoundaryQuestion) {
    reasons.push("authority_boundary_question");
  } else if (hasReportDraftRequest) {
    reasons.push("report_analysis_request");
  } else if (basisOnlyQuestion) {
    reasons.push("basis_only_question");
  } else if (hasTimeLocationStatus) {
    reasons.push("time_location_air_quality_status_request");
  } else if (hasConcreteDataObject) {
    reasons.push("monitoring_data_object_present");
  } else if (hasDataFrame && hasDataOperation) {
    reasons.push("data_time_or_location_plus_operation");
  } else if (hasDataFrame) {
    reasons.push("temporal_context_without_data_request");
  }
  if (!wantsData && dataSignals.length) {
    reasons.push("data_terms_without_concrete_monitoring_request");
  }
  const finalNextTool: RecommendedNextTool =
    hasReportDraftRequest && !hasExplicitDataTool
      ? "both"
      : wantsData && wantsKnowledge
        ? "both"
        : wantsData
          ? "environment_data_mcp"
          : "knowledge_base";
  const confidence =
    hasExplicitDataTool || basisOnlyQuestion || hasBoundaryQuestion || hasTimeLocationStatus
      ? 0.95
      : wantsData || wantsKnowledge
        ? 0.75
        : 0.45;
  return {
    deterministicNextTool: finalNextTool,
    finalNextTool,
    reasons,
    dataSignals,
    knowledgeSignals,
    knowledgeNeeded: wantsKnowledge || finalNextTool === "both",
    dataNeeded: wantsData || finalNextTool === "both" || finalNextTool === "environment_data_mcp",
    confidence,
    matchedSignals: {
      time: dataTimes,
      location: dataLocations,
      dataObject: dataObjects,
      operation: dataOperations,
      basisOnly: basisOnlySignals,
      knowledge: knowledgeSignals
    },
    conflictResolvedBy: "deterministic_policy"
  };
}

export function buildEnvironmentDataToolHints(question: string, profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE): string[] {
  const routing = classifyEnvAirToolRouting(question, profile);
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

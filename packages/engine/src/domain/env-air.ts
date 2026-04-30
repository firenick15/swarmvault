import type { ToolRoutingDecision } from "../types.js";

export interface StandardReference {
  raw: string;
  family: string;
  number: string;
  year?: string;
  normalized: string;
  compact: string;
}

export interface EnvAirStandardCatalogEntry {
  identity: string;
  family: string;
  number: string;
  current?: string;
  title: string;
  aliases: string[];
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

export const ENV_AIR_STANDARD_CATALOG: EnvAirStandardCatalogEntry[] = [
  {
    identity: "GB 3095",
    family: "GB",
    number: "3095",
    current: "GB 3095-2026",
    title: "环境空气质量标准",
    aliases: ["GB 3095", "GB3095", "GB 3095-2026", "GB30952026", "环境空气质量标准", "环境空气标准", "空气质量标准"]
  },
  {
    identity: "HJ 663",
    family: "HJ",
    number: "663",
    current: "HJ 663-2026",
    title: "环境空气质量评价技术规范",
    aliases: ["HJ 663", "HJ663", "HJ 663-2026", "HJ6632026", "环境空气质量评价技术规范", "达标评价技术规范"]
  },
  {
    identity: "HJ 633",
    family: "HJ",
    number: "633",
    current: "HJ 633-2026",
    title: "环境空气质量指数(AQI)技术规定",
    aliases: ["HJ 633", "HJ633", "HJ 633-2026", "HJ6332026", "AQI技术规定", "空气质量指数技术规定", "日报和实时报技术规定"]
  },
  {
    identity: "HJ 655",
    family: "HJ",
    number: "655",
    title: "环境空气颗粒物连续自动监测系统安装和验收技术规范",
    aliases: ["HJ 655", "HJ655", "颗粒物连续自动监测系统", "安装和验收技术规范"]
  },
  {
    identity: "HJ 664",
    family: "HJ",
    number: "664",
    title: "环境空气质量监测点位布设技术规范",
    aliases: ["HJ 664", "HJ664", "监测点位布设", "环境空气质量监测点位"]
  },
  {
    identity: "HJ 818",
    family: "HJ",
    number: "818",
    title: "环境空气气态污染物连续自动监测系统运行和质控技术规范",
    aliases: ["HJ 818", "HJ818", "气态污染物连续自动监测系统", "运行和质控技术规范"]
  }
];

const ENV_AIR_TERMS = [
  "环境空气",
  "空气质量",
  "环境空气质量",
  "自动监测",
  "连续自动监测",
  "监测系统",
  "监测方法",
  "参比方法",
  "手工监测",
  "比对测试",
  "平行性",
  "零点噪声",
  "量程噪声",
  "示值误差",
  "转换炉效率",
  "数据有效性",
  "有效数据",
  "负值数据",
  "负值",
  "质量保证",
  "质量控制",
  "运行维护",
  "运维",
  "标准限值",
  "执行依据",
  "现行标准",
  "强制标准",
  "推荐标准",
  "地方标准",
  "国家标准",
  "技术指南",
  "技术规范",
  "编制说明",
  "征求意见稿",
  "修改单",
  "历史版本",
  "废止",
  "替代",
  "重污染天气",
  "应急减排",
  "绩效分级",
  "达标评价",
  "污染过程",
  "来源解析",
  "协同控制",
  "臭氧",
  "细颗粒物",
  "颗粒物",
  "挥发性有机物",
  "非甲烷总烃",
  "氮氧化物",
  "二氧化硫",
  "二氧化氮",
  "一氧化碳"
];

const TERM_ALIASES: Record<string, string[]> = {
  "PM2.5": ["pm2.5", "pm 2.5", "pm25", "细颗粒物"],
  PM10: ["pm10", "pm 10", "可吸入颗粒物"],
  O3: ["o3", "o₃", "臭氧"],
  SO2: ["so2", "so₂", "s o 2", "二氧化硫"],
  NO2: ["no2", "no₂", "n o 2", "二氧化氮"],
  CO: ["co", "一氧化碳"],
  VOCs: ["vocs", "挥发性有机物"],
  NMHC: ["nmhc", "非甲烷总烃"],
  AQI: ["aqi", "空气质量指数"],
  IAQI: ["iaqi", "分指数"]
};

const POLLUTANT_FOCUS_TERMS: Record<string, string[]> = {
  "PM2.5": ["PM2.5", "PM 2.5", "PM25", "细颗粒物", "年平均", "日平均", "浓度限值", "一级", "二级"],
  PM10: ["PM10", "PM 10", "可吸入颗粒物", "年平均", "日平均", "浓度限值", "一级", "二级"],
  O3: ["O3", "O₃", "臭氧", "日最大8小时平均", "8小时平均", "1小时平均", "浓度限值", "一级", "二级"],
  SO2: ["SO2", "SO₂", "二氧化硫", "年平均", "日平均", "1小时平均", "浓度限值", "一级", "二级"],
  NO2: ["NO2", "NO₂", "二氧化氮", "年平均", "日平均", "1小时平均", "浓度限值", "一级", "二级"],
  CO: ["CO", "一氧化碳", "日平均", "1小时平均", "浓度限值", "一级", "二级"]
};

const DATA_OBJECT_TERMS = ["监测数据", "实测", "站点数据", "原始数据", "连续监测", "小时值", "日均值", "月均值", "年均值"];
const DATA_TIME_TERMS = [
  "今天",
  "今日",
  "昨日",
  "昨天",
  "本周",
  "上周",
  "本月",
  "上月",
  "今年",
  "去年",
  "小时",
  "日均",
  "月均",
  "年均",
  "时段",
  "期间",
  "过程"
];
const DATA_LOCATION_TERMS = ["站点", "国控站", "省控站", "城市", "区域", "区县", "省", "市"];
const DATA_OPERATION_TERMS = ["查询", "统计", "排名", "同比", "环比", "趋势", "过程分析", "达标率", "超标天数", "连续负值", "异常诊断"];
const EXPLICIT_DATA_TOOL_TERMS = ["数据mcp", "环境数据mcp", "监测数据mcp", "调用数据"];
const KNOWLEDGE_OPERATION_TERMS = [
  "标准",
  "规范",
  "指南",
  "依据",
  "限值",
  "浓度限值",
  "评价方法",
  "计算公式",
  "技术规定",
  "适用范围",
  "修订",
  "修改单",
  "关系",
  "口径",
  "编制说明",
  "法律",
  "办法"
];

const KNOWLEDGE_HINTS = ["知识库", "标准", "规范", "指南", "依据", "限值", "要求", "方法", "解释", "编制说明", "法律", "办法"];

const CURRENT_BASIS_HINTS = [
  "现行",
  "按什么执行",
  "执行依据",
  "限值",
  "标准",
  "依据",
  "评价报告",
  "报告依据",
  "依据说明",
  "达标评价",
  "评价技术规范",
  "分工",
  "作用",
  "current basis",
  "what standard"
];
const LIMIT_HINTS = ["限值", "浓度限值", "一级", "二级", "年平均", "日平均", "小时平均", "日最大", "8小时", "达标", "超标", "评价"];
const AQI_HINTS = ["AQI", "IAQI", "空气质量指数", "日报", "实时报", "日报和实时报", "日报技术规定"];
const MONITORING_METHOD_HINTS = ["监测方法", "采样", "分析方法", "测定", "检出限", "公式", "校准", "质控", "质量控制"];
const AUTHORITY_BOUNDARY_HINTS = [
  "研究论文",
  "论文",
  "文献",
  "报告",
  "公报",
  "白皮书",
  "征求意见稿",
  "编制说明",
  "能否作为执法依据",
  "直接执行",
  "要求企业执行",
  "是否强制"
];

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

  if (
    includesAnyTerm(normalizedQuery, LIMIT_HINTS) &&
    pollutants.some((item) => ["PM2.5", "PM10", "O3", "SO2", "NO2", "CO"].includes(item))
  ) {
    expandedTerms.push("GB 3095", "GB 3095-2026", "GB 3095-2012", "环境空气质量标准", "环境空气质量标准限值", "一级", "二级");
    pinnedStandards.push("GB 3095", "GB 3095-2026");
    rankingSignals.push("ambient_air_quality_limit_question");
  }

  if (includesAnyTerm(normalizedQuery, AQI_HINTS)) {
    expandedTerms.push("HJ 633", "HJ 633-2026", "HJ 633-2012", "环境空气质量指数", "空气质量日报", "空气质量实时报");
    pinnedStandards.push("HJ 633", "HJ 633-2026");
    rankingSignals.push("aqi_reporting_question");
  }

  if (includesAnyTerm(normalizedQuery, ["评价技术规范", "达标评价", "评价报告", "报告依据", "空气质量评价"])) {
    expandedTerms.push("HJ 663", "HJ 663-2026", "环境空气质量评价技术规范", "达标评价技术规范");
    pinnedStandards.push("HJ 663", "HJ 663-2026");
    rankingSignals.push("ambient_air_quality_assessment_question");
  }

  if (includesAnyTerm(normalizedQuery, MONITORING_METHOD_HINTS)) {
    expandedTerms.push("环境空气监测方法", "环境空气质量监测规范", "采样", "质量保证", "质量控制");
    rankingSignals.push("monitoring_method_question");
  }

  if (inferAuthorityBoundaryIntent(normalizedQuery)) {
    expandedTerms.push("执行依据", "强制标准", "推荐标准", "征求意见稿", "编制说明", "研究论文", "技术参考", "法律效力");
    rankingSignals.push("authority_boundary_question");
  }

  if (normalizedQuery.includes("HJ 482") || normalizedQuery.includes("HJ482") || normalizedQuery.includes("副玫瑰苯胺")) {
    expandedTerms.push("HJ 482", "HJ 482-2009", "修改单", "甲醛吸收", "副玫瑰苯胺分光光度法");
    pinnedStandards.push("HJ 482");
    rankingSignals.push("hj482_amendment_question");
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

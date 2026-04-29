export interface StandardReference {
  raw: string;
  family: string;
  number: string;
  year?: string;
  normalized: string;
  compact: string;
}

export type RecommendedNextTool = "knowledge_base" | "environment_data_mcp" | "both";

const STANDARD_REFERENCE_PATTERN =
  /\b(?<family>GB\/T|GB|HJ\/T|HJ|DB[0-9]{2}\/T|DB[0-9]{2})\s*(?:[- ]|\/)?\s*(?<number>[0-9]{2,6})(?:\s*(?:[- ]|:)\s*(?<year>[0-9]{2,4}))?\b/gi;

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
  "PM2.5": ["pm2.5", "pm25", "细颗粒物"],
  PM10: ["pm10", "可吸入颗粒物"],
  O3: ["o3", "臭氧"],
  SO2: ["so2", "二氧化硫"],
  NO2: ["no2", "二氧化氮"],
  CO: ["co", "一氧化碳"],
  VOCs: ["vocs", "挥发性有机物"],
  NMHC: ["nmhc", "非甲烷总烃"],
  AQI: ["aqi", "空气质量指数"],
  IAQI: ["iaqi", "分指数"]
};

const DATA_TOOL_HINTS = [
  "监测数据",
  "小时值",
  "日均值",
  "月均值",
  "年均值",
  "浓度",
  "站点",
  "城市",
  "同比",
  "环比",
  "排名",
  "污染过程",
  "超标",
  "达标率",
  "计算",
  "分析"
];

const KNOWLEDGE_HINTS = ["标准", "规范", "指南", "依据", "限值", "要求", "方法", "解释", "编制说明", "法律", "办法"];

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
    const compact = normalized.replace(/[\s/-]/g, "").toUpperCase();
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

export function classifyRecommendedNextTool(question: string): RecommendedNextTool {
  const compact = question.toLowerCase().replace(/\s+/g, "");
  const wantsData = DATA_TOOL_HINTS.some((hint) => compact.includes(hint.toLowerCase().replace(/\s+/g, "")));
  const wantsKnowledge =
    KNOWLEDGE_HINTS.some((hint) => compact.includes(hint.toLowerCase().replace(/\s+/g, ""))) ||
    extractStandardReferences(question).length > 0;
  if (wantsData && wantsKnowledge) {
    return "both";
  }
  if (wantsData) {
    return "environment_data_mcp";
  }
  return "knowledge_base";
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

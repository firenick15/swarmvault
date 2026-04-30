import { buildEnvAirSearchText, normalizePollutantName, type StandardReference } from "./env-air.js";

export interface EnvAirStructuredFact {
  id: string;
  type: "limit_value" | "formula" | "definition" | "technical_parameter" | "other";
  tableName?: string;
  pollutant?: string;
  metric?: string;
  averagingPeriod?: string;
  value?: string;
  unit?: string;
  standardCode?: string;
  rawText: string;
  searchText: string;
}

const POLLUTANT_PATTERN =
  /\b(PM\s*2\.?5|PM\s*10|O\s*3|SO\s*2|NO\s*2|CO|AQI|IAQI)\b|细颗粒物|可吸入颗粒物|臭氧|二氧化硫|二氧化氮|一氧化碳/iu;
const VALUE_PATTERN =
  /([0-9]+(?:\.[0-9]+)?(?:\s*[-~至]\s*[0-9]+(?:\.[0-9]+)?)?)\s*(μg\/m3|µg\/m3|mg\/m3|μg\/m³|µg\/m³|mg\/m³|ug\/m3|%|分贝|dB)?/iu;
const PERIOD_PATTERN = /(年平均|24小时平均|日平均|1小时平均|小时平均|日最大8小时平均|8小时平均|月平均|季平均|算术平均|第[0-9]+百分位数)/u;

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitMarkdownRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map(stripMarkup)
    .filter(Boolean);
}

function markdownTableRows(body: string): Array<{ cells: string[]; heading: string }> {
  const rows: Array<{ cells: string[]; heading: string }> = [];
  let heading = "";
  for (const line of body.split(/\r?\n/)) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      heading = stripMarkup(headingMatch[1] ?? "");
      continue;
    }
    if (!line.includes("|")) {
      continue;
    }
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) {
      continue;
    }
    const cells = splitMarkdownRow(line);
    if (cells.length >= 2) {
      rows.push({ cells, heading });
    }
  }
  return rows;
}

function htmlTableRows(body: string): Array<{ cells: string[]; heading: string }> {
  const rows: Array<{ cells: string[]; heading: string }> = [];
  for (const tableMatch of body.matchAll(/<table[\s\S]*?<\/table>/giu)) {
    const table = tableMatch[0];
    const caption = stripMarkup(table.match(/<caption[^>]*>([\s\S]*?)<\/caption>/iu)?.[1] ?? "");
    for (const rowMatch of table.matchAll(/<tr[\s\S]*?<\/tr>/giu)) {
      const cells = [...rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/giu)]
        .map((match) => stripMarkup(match[1] ?? ""))
        .filter(Boolean);
      if (cells.length >= 2) {
        rows.push({ cells, heading: caption });
      }
    }
  }
  return rows;
}

function classifyFact(rawText: string): EnvAirStructuredFact["type"] {
  if (/(限值|一级|二级|浓度|标准值|μg\/m|µg\/m|mg\/m|ug\/m)/iu.test(rawText) && POLLUTANT_PATTERN.test(rawText)) {
    return "limit_value";
  }
  if (/(公式|计算|IAQI|AQI|=|按式)/iu.test(rawText)) {
    return "formula";
  }
  if (/(定义|术语|指|是指)/u.test(rawText)) {
    return "definition";
  }
  if (/(检出限|精密度|准确度|示值误差|零点|跨度|量程|平行性|响应时间)/u.test(rawText)) {
    return "technical_parameter";
  }
  return "other";
}

function pollutantFromText(rawText: string): string | undefined {
  const match = rawText.match(POLLUTANT_PATTERN);
  return match ? normalizePollutantName(match[0]) : undefined;
}

function factFromRow(input: {
  rowIndex: number;
  heading: string;
  cells: string[];
  standardRefs: StandardReference[];
  standardCode?: string;
}): EnvAirStructuredFact | undefined {
  const rawText = stripMarkup([input.heading, ...input.cells].filter(Boolean).join(" | "));
  if (rawText.length < 8) {
    return undefined;
  }
  const type = classifyFact(rawText);
  if (type === "other" && !POLLUTANT_PATTERN.test(rawText)) {
    return undefined;
  }
  const pollutant = pollutantFromText(rawText);
  const valueMatch = rawText.match(VALUE_PATTERN);
  const periodMatch = rawText.match(PERIOD_PATTERN);
  const standardCode = input.standardCode || input.standardRefs[0]?.normalized;
  return {
    id: `fact:${input.rowIndex}`,
    type,
    tableName: input.heading || undefined,
    pollutant,
    averagingPeriod: periodMatch?.[1],
    value: valueMatch?.[1],
    unit: valueMatch?.[2],
    standardCode,
    rawText,
    searchText: buildEnvAirSearchText({
      title: input.heading,
      body: rawText,
      standardCode,
      pollutants: pollutant ? [pollutant] : undefined
    })
  };
}

export function extractEnvAirStructuredFacts(input: {
  body: string;
  standardRefs: StandardReference[];
  standardCode?: string;
}): EnvAirStructuredFact[] {
  const rows = [...markdownTableRows(input.body), ...htmlTableRows(input.body)];
  const facts: EnvAirStructuredFact[] = [];
  rows.forEach((row, index) => {
    const fact = factFromRow({
      rowIndex: index + 1,
      heading: row.heading,
      cells: row.cells,
      standardRefs: input.standardRefs,
      standardCode: input.standardCode
    });
    if (fact) {
      facts.push({
        ...fact,
        id: `fact:${index + 1}:${fact.type}`
      });
    }
  });
  return facts;
}

export function renderStructuredFactSnippet(fact: {
  pollutant?: string;
  averaging_period?: string;
  value?: string;
  unit?: string;
  raw_text?: string;
  rawText?: string;
}): string {
  const raw = fact.rawText ?? fact.raw_text ?? "";
  const summary = [
    fact.pollutant ? `pollutant=${fact.pollutant}` : undefined,
    fact.averaging_period ? `period=${fact.averaging_period}` : undefined,
    fact.value ? `value=${fact.value}${fact.unit ?? ""}` : undefined
  ]
    .filter((item): item is string => Boolean(item))
    .join("; ");
  return [summary, raw].filter(Boolean).join("\n");
}

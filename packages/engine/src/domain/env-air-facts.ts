import { extractDocumentStructureBlocks } from "../fact-extraction/document-structure.js";
import { type StructuredFact, structuredFactsFromBlocks } from "../fact-extraction/facts.js";
import { sha256 } from "../utils.js";
import { buildEnvAirSearchText, normalizePollutantName, type StandardReference } from "./env-air.js";

export interface EnvAirStructuredFact {
  id: string;
  ordinal: number;
  stableId: string;
  legacyIds: string[];
  type:
    | "limit_value"
    | "formula"
    | "definition"
    | "technical_parameter"
    | "applicability"
    | "validity_rule"
    | "status_rule"
    | "replacement_relation"
    | "method_step"
    | "other";
  tableName?: string;
  clauseNo?: string;
  tableNo?: string;
  formulaNo?: string;
  sourceSection?: string;
  subject?: string;
  predicate?: string;
  objectValue?: string;
  qualifiers?: Record<string, string>;
  provenance?: string;
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
  /\b(PM\s*2\.?5|PM\s*10|O\s*3|SO\s*2|NO\s*2|CO|AQI|IAQI|NOx|TSP)\b|细颗粒物|可吸入颗粒物|臭氧|二氧化硫|二氧化氮|一氧化碳|氮氧化物|总悬浮颗粒物/iu;
const VALUE_PATTERN =
  /([0-9]+(?:\.[0-9]+)?(?:\s*[-~至]\s*[0-9]+(?:\.[0-9]+)?)?)\s*(μg\/m3|µg\/m3|mg\/m3|μg\/m³|µg\/m³|mg\/m³|ug\/m3|%|分贝|dB)?/iu;
const PERIOD_PATTERN = /(年平均|24小时平均|日平均|1小时平均|小时平均|日最大8小时平均|8小时平均|月平均|季平均|算术平均|第[0-9]+百分位数)/u;

function normalizeFactText(value: string): string {
  return value
    .replace(/\\(?:mathrm|mathsf|mathbf|bf)\s*\{([^}]*)\}/gi, "$1")
    .replace(/\\left|\\right|\\mathrm|\\mathsf|\\mathbf|\\bf/gi, " ")
    .replace(/[_{}$()[\]（）]/g, " ")
    .replace(/\bP\s*M\s*2\s*\.?\s*5\b/gi, "PM2.5")
    .replace(/\bP\s*M\s*1\s*0\b/gi, "PM10")
    .replace(/\bS\s*O\s*2\b/gi, "SO2")
    .replace(/\bN\s*O\s*2\b/gi, "NO2")
    .replace(/\bO\s*3\b/gi, "O3")
    .replace(/\bC\s*O\b/gi, "CO")
    .replace(/\bN\s*O\s*x\b/gi, "NOx")
    .replace(/\s+/g, " ")
    .trim();
}

function pollutantFromText(rawText: string): string | undefined {
  const match = normalizeFactText(rawText).match(POLLUTANT_PATTERN);
  return match ? normalizePollutantName(match[0]) : undefined;
}

function compactText(value: string): string {
  return normalizeFactText(value).replace(/\s+/g, "");
}

function compactStandard(value: string | undefined): string {
  return compactText(value ?? "")
    .replace(/[—–－]/g, "-")
    .toUpperCase();
}

function splitFactCells(value: string | undefined): string[] {
  return (value ?? "")
    .split("|")
    .map((cell) => normalizeFactText(cell))
    .filter(Boolean);
}

function numericCellValue(cell: string): string | undefined {
  const compact = normalizeFactText(cell).replace(/\s+/g, "");
  const match = compact.match(/[0-9]+(?:\.[0-9]+)?/u);
  return match?.[0];
}

function periodAliasText(period: string | undefined): string {
  if (!period) {
    return "";
  }
  if (period === "日平均") {
    return "日平均 24小时平均 日均 24h";
  }
  if (period === "1小时平均" || period === "小时平均") {
    return "1小时平均 小时平均 一小时平均 1h";
  }
  if (period === "日最大8小时平均" || period === "8小时平均") {
    return "日最大8小时平均 8小时平均 MDA8";
  }
  if (period === "年平均") {
    return "年平均 年均";
  }
  return period;
}

function unitForGb3095Pollutant(pollutant: string | undefined, rawText: string): string {
  if (pollutant === "CO" || /mg\s*\/?\s*m\s*\^?\s*3|mg\/m³|mg\/m3/iu.test(rawText)) {
    return "mg/m³";
  }
  return "μg/m³";
}

function derivedFact(
  base: EnvAirStructuredFact,
  role: string,
  overrides: Partial<EnvAirStructuredFact> & { qualifiers?: Record<string, string> }
): EnvAirStructuredFact {
  const stableId = `fact:${sha256(
    [
      base.stableId,
      role,
      overrides.pollutant ?? base.pollutant ?? "",
      overrides.metric ?? base.metric ?? "",
      overrides.averagingPeriod ?? base.averagingPeriod ?? "",
      overrides.value ?? base.value ?? "",
      overrides.unit ?? base.unit ?? "",
      JSON.stringify(overrides.qualifiers ?? {})
    ].join("|")
  ).slice(0, 16)}`;
  const rawText = overrides.rawText ?? base.rawText;
  const qualifiers = {
    ...(base.qualifiers ?? {}),
    ...(overrides.qualifiers ?? {}),
    derived_from: base.id
  };
  const pollutant = overrides.pollutant ?? base.pollutant;
  const metric = overrides.metric ?? base.metric;
  const averagingPeriod = overrides.averagingPeriod ?? base.averagingPeriod;
  const value = overrides.value ?? base.value;
  const unit = overrides.unit ?? base.unit;
  const searchText = buildEnvAirSearchText({
    title: [overrides.sourceSection ?? base.sourceSection ?? "", metric ?? "", averagingPeriod ?? ""].join(" "),
    body: [
      rawText,
      pollutant ?? "",
      metric ?? "",
      averagingPeriod ?? "",
      periodAliasText(averagingPeriod),
      value ? `${value}${unit ?? ""}` : "",
      Object.values(qualifiers).join(" ")
    ].join(" "),
    standardCode: overrides.standardCode ?? base.standardCode,
    pollutants: pollutant ? [pollutant] : undefined
  });
  return {
    ...base,
    ...overrides,
    id: stableId,
    stableId,
    legacyIds: [...(base.legacyIds ?? []), base.id],
    qualifiers,
    pollutant,
    metric,
    averagingPeriod,
    value,
    unit,
    rawText,
    searchText
  };
}

function expandGb3095LimitFacts(base: EnvAirStructuredFact): EnvAirStructuredFact[] {
  if (base.type !== "limit_value" || !compactStandard(base.standardCode).includes("GB3095")) {
    return [];
  }
  const headers = compactText(base.qualifiers?.headers ?? "");
  if (!headers.includes("过渡阶段浓度限值") || !headers.includes("浓度限值")) {
    return [];
  }
  const cells = splitFactCells(base.objectValue);
  const pollutant = base.pollutant ?? pollutantFromText(cells[0] ?? base.rawText);
  if (!pollutant) {
    return [];
  }
  const periodIndex = cells.findIndex((cell) => PERIOD_PATTERN.test(cell));
  if (periodIndex < 0) {
    return [];
  }
  const period = cells[periodIndex]?.match(PERIOD_PATTERN)?.[1];
  if (!period) {
    return [];
  }
  const values = cells
    .slice(periodIndex + 1)
    .map(numericCellValue)
    .filter((item): item is string => Boolean(item));
  if (values.length < 4) {
    return [];
  }
  const unit = unitForGb3095Pollutant(pollutant, base.rawText);
  const rowId = base.qualifiers?.rowIndex ?? "";
  const rows = [
    {
      value: values[0],
      metric: "transition_limit_level_1",
      label: "过渡阶段浓度限值 一级",
      concentrationType: "transition_limit",
      grade: "level_1"
    },
    {
      value: values[1],
      metric: "transition_limit_level_2",
      label: "过渡阶段浓度限值 二级",
      concentrationType: "transition_limit",
      grade: "level_2"
    },
    {
      value: values[2],
      metric: "final_limit_level_1",
      label: "浓度限值 一级",
      concentrationType: "final_limit",
      grade: "level_1"
    },
    {
      value: values[3],
      metric: "final_limit_level_2",
      label: "浓度限值 二级",
      concentrationType: "final_limit",
      grade: "level_2"
    }
  ];
  return rows.map((entry) =>
    derivedFact(base, `gb3095:${pollutant}:${period}:${entry.metric}`, {
      metric: entry.metric,
      pollutant,
      averagingPeriod: period,
      value: entry.value,
      unit,
      rawText: [
        `GB 3095—2026 表1结构化限值：污染物 ${pollutant}；平均时间 ${period}；${entry.label} ${entry.value}${unit}。`,
        `原表行：${base.rawText}`
      ].join(" "),
      qualifiers: {
        structured_fact: "gb3095_limit_row",
        concentration_type: entry.concentrationType,
        grade: entry.grade,
        row_id: rowId
      }
    })
  );
}

function expandHj663EvaluationFacts(base: EnvAirStructuredFact): EnvAirStructuredFact[] {
  if (!compactStandard(base.standardCode).includes("HJ663")) {
    return [];
  }
  const raw = normalizeFactText(base.rawText);
  if (!/(年评价|年评价时|年平均|百分位数|单项指数)/u.test(raw)) {
    return [];
  }
  const rules = [
    {
      pollutant: "O3",
      metric: "annual_evaluation_percentile_90_mda8",
      averagingPeriod: "日最大8小时平均",
      percentile: "90",
      label: "O3 日最大8小时平均第90百分位数",
      pattern: /O3.*日最大8小时平均.*第\s*90\s*百分位数|O3.*日最大\s*8\s*小时.*第\s*90\s*百分位数/iu
    },
    {
      pollutant: "CO",
      metric: "annual_evaluation_percentile_95_daily",
      averagingPeriod: "日平均",
      percentile: "95",
      label: "CO 日平均第95百分位数",
      pattern: /CO.*日平均.*第\s*95\s*百分位数|CO.*日均.*第\s*95\s*百分位数/iu
    },
    {
      pollutant: "PM10",
      metric: "annual_evaluation_percentile_95_daily",
      averagingPeriod: "日平均",
      percentile: "95",
      label: "PM10 日平均第95百分位数",
      pattern: /PM10.*日平均.*第\s*95\s*百分位数/iu
    },
    {
      pollutant: "PM2.5",
      metric: "annual_evaluation_percentile_95_daily",
      averagingPeriod: "日平均",
      percentile: "95",
      label: "PM2.5 日平均第95百分位数",
      pattern: /PM2\.5.*日平均.*第\s*95\s*百分位数/iu
    },
    {
      pollutant: "SO2",
      metric: "annual_evaluation_percentile_98_daily",
      averagingPeriod: "日平均",
      percentile: "98",
      label: "SO2 日平均第98百分位数",
      pattern: /SO2.*日平均.*第\s*98\s*百分位数/iu
    },
    {
      pollutant: "NO2",
      metric: "annual_evaluation_percentile_98_daily",
      averagingPeriod: "日平均",
      percentile: "98",
      label: "NO2 日平均第98百分位数",
      pattern: /NO2.*日平均.*第\s*98\s*百分位数/iu
    }
  ];
  return rules
    .filter((rule) => rule.pattern.test(raw))
    .map((rule) =>
      derivedFact(base, `hj663:${rule.metric}:${rule.pollutant}`, {
        type: "validity_rule",
        metric: rule.metric,
        pollutant: rule.pollutant,
        averagingPeriod: rule.averagingPeriod,
        value: rule.percentile,
        unit: "percentile",
        rawText: [`HJ 663—2026 结构化年评价指标：污染物 ${rule.pollutant}；统计指标 ${rule.label}。`, `原文：${base.rawText}`].join(" "),
        qualifiers: {
          structured_fact: "hj663_annual_evaluation_metric",
          statistic: rule.metric,
          percentile: rule.percentile
        }
      })
    );
}

function expandHj633RoundingFacts(base: EnvAirStructuredFact): EnvAirStructuredFact[] {
  if (!compactStandard(base.standardCode).includes("HJ633")) {
    return [];
  }
  const raw = normalizeFactText(base.rawText);
  if (!/(AQI|IAQI|空气质量指数|空气质量分指数)/iu.test(raw) || !/向上进位取整数|不保留小数/u.test(raw)) {
    return [];
  }
  return [
    derivedFact(base, "hj633:aqi_iaqi_rounding", {
      type: "formula",
      pollutant: base.pollutant ?? "AQI",
      metric: "aqi_iaqi_rounding_rule",
      value: "",
      unit: "",
      rawText: [`HJ 633—2026 结构化计算规则：AQI 和 IAQI 计算结果应全部向上进位取整数，不保留小数。`, `原文：${base.rawText}`].join(" "),
      qualifiers: {
        structured_fact: "hj633_rounding_rule"
      }
    })
  ];
}

function expandDomainFacts(base: EnvAirStructuredFact): EnvAirStructuredFact[] {
  return [base, ...expandGb3095LimitFacts(base), ...expandHj663EvaluationFacts(base), ...expandHj633RoundingFacts(base)];
}

function normalizeStructuredFact(fact: StructuredFact): EnvAirStructuredFact | undefined {
  const normalizedRawText = normalizeFactText(fact.rawText);
  const pollutant = pollutantFromText(normalizedRawText);
  const valueMatch = normalizedRawText.match(VALUE_PATTERN);
  const periodMatch = normalizedRawText.match(PERIOD_PATTERN);
  if (fact.kind === "other" && !pollutant) {
    return undefined;
  }
  return {
    id: fact.id,
    ordinal: fact.ordinal,
    stableId: fact.stableId,
    legacyIds: fact.legacyIds,
    type: fact.kind,
    tableName: fact.sourceSection,
    clauseNo: fact.clauseNo,
    tableNo: fact.tableNo,
    formulaNo: fact.formulaNo,
    sourceSection: fact.sourceSection,
    subject: fact.subject,
    predicate: fact.predicate,
    objectValue: fact.objectValue,
    qualifiers: fact.qualifiers,
    provenance: fact.provenance,
    pollutant,
    averagingPeriod: periodMatch?.[1],
    value: valueMatch?.[1],
    unit: valueMatch?.[2],
    standardCode: fact.standardCode,
    rawText: normalizedRawText,
    searchText: buildEnvAirSearchText({
      title: fact.sourceSection ?? fact.subject ?? "",
      body: fact.rawText,
      standardCode: fact.standardCode,
      pollutants: pollutant ? [pollutant] : undefined
    })
  };
}

export function extractEnvAirStructuredFacts(input: {
  body: string;
  standardRefs: StandardReference[];
  standardCode?: string;
  sourceId?: string;
}): EnvAirStructuredFact[] {
  const sourceId = input.sourceId ?? "source";
  const blocks = extractDocumentStructureBlocks({ sourceId, text: input.body });
  return structuredFactsFromBlocks({
    sourceId,
    blocks,
    standardRefs: input.standardRefs,
    standardCode: input.standardCode
  })
    .map(normalizeStructuredFact)
    .filter((fact): fact is EnvAirStructuredFact => Boolean(fact))
    .flatMap(expandDomainFacts);
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

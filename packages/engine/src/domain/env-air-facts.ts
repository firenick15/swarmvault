import { extractDocumentStructureBlocks } from "../fact-extraction/document-structure.js";
import { type StructuredFact, structuredFactsFromBlocks } from "../fact-extraction/facts.js";
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

function pollutantFromText(rawText: string): string | undefined {
  const match = rawText.match(POLLUTANT_PATTERN);
  return match ? normalizePollutantName(match[0]) : undefined;
}

function normalizeStructuredFact(fact: StructuredFact): EnvAirStructuredFact | undefined {
  const pollutant = pollutantFromText(fact.rawText);
  const valueMatch = fact.rawText.match(VALUE_PATTERN);
  const periodMatch = fact.rawText.match(PERIOD_PATTERN);
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
    rawText: fact.rawText,
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
    .filter((fact): fact is EnvAirStructuredFact => Boolean(fact));
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

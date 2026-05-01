import { extractStandardReferences, type StandardReference, standardIdentityKey } from "../domain/env-air.js";
import { sha256 } from "../utils.js";
import type { DocumentStructureBlock } from "./document-structure.js";

export type StructuredFactKind =
  | "limit_value"
  | "formula"
  | "definition"
  | "applicability"
  | "validity_rule"
  | "status_rule"
  | "replacement_relation"
  | "technical_parameter"
  | "method_step"
  | "other";

export interface StructuredFact {
  id: string;
  ordinal: number;
  stableId: string;
  legacyIds: string[];
  kind: StructuredFactKind;
  sourceId: string;
  standardCode?: string;
  standardIdentity?: string;
  clauseNo?: string;
  tableNo?: string;
  formulaNo?: string;
  sourceSection?: string;
  subject?: string;
  predicate?: string;
  objectValue?: string;
  qualifiers: Record<string, string>;
  rawText: string;
  searchText: string;
  provenance: "raw_text" | "table" | "formula" | "clause" | "metadata" | "llm_repair";
}

function classifyFactKind(block: DocumentStructureBlock): StructuredFactKind {
  const text = block.normalizedText;
  if (block.kind === "definition" || /(定义|术语|是指|指\s*)/u.test(text)) {
    return "definition";
  }
  if (block.kind === "formula" || /(公式|计算|按式|=|＝)/u.test(text)) {
    return "formula";
  }
  if (/(限值|标准值|浓度|一级|二级|μg\/m|µg\/m|ug\/m|mg\/m)/iu.test(text)) {
    return "limit_value";
  }
  if (/(有效性|有效数据|缺测|百分位|评价项目|评价方法)/u.test(text)) {
    return "validity_rule";
  }
  if (/(适用范围|适用于|不适用于)/u.test(text)) {
    return "applicability";
  }
  if (/(实施|废止|替代|代替|发布|修订)/u.test(text)) {
    return "status_rule";
  }
  if (/(检出限|精密度|准确度|示值误差|零点|跨度|量程|平行性|响应时间)/u.test(text)) {
    return "technical_parameter";
  }
  if (/(步骤|按以下|应按|测定|采样|校准|质控)/u.test(text)) {
    return "method_step";
  }
  return "other";
}

function provenanceForBlock(block: DocumentStructureBlock): StructuredFact["provenance"] {
  if (block.kind === "table" || block.kind === "table_row") {
    return "table";
  }
  if (block.kind === "formula") {
    return "formula";
  }
  if (block.kind === "clause" || block.kind === "definition") {
    return "clause";
  }
  return "raw_text";
}

function rowSignature(block: DocumentStructureBlock): string {
  return [block.tableNo ?? "", block.rowIndex ?? "", ...(block.headers ?? []), ...(block.cells ?? []), block.normalizedText]
    .join("|")
    .replace(/\s+/g, "");
}

function stableFactId(input: { sourceId: string; block: DocumentStructureBlock; standardCode?: string; ordinal: number }): string {
  return `fact:${sha256(
    [
      input.sourceId,
      input.standardCode ?? "",
      input.block.clauseNo ?? "",
      input.block.tableNo ?? "",
      input.block.formulaNo ?? "",
      rowSignature(input.block)
    ].join("|")
  ).slice(0, 16)}`;
}

export function structuredFactsFromBlocks(input: {
  sourceId: string;
  blocks: DocumentStructureBlock[];
  standardRefs?: StandardReference[];
  standardCode?: string;
  searchTextForFact?: (fact: StructuredFact) => string;
}): StructuredFact[] {
  const standardCode =
    input.standardCode || input.standardRefs?.[0]?.normalized || extractStandardReferences(input.blocks[0]?.rawText ?? "")[0]?.normalized;
  const standardIdentity = standardCode ? standardIdentityKey(standardCode) : undefined;
  const facts: StructuredFact[] = [];
  const seenStableIds = new Set<string>();
  input.blocks.forEach((block) => {
    const kind = classifyFactKind(block);
    if (kind === "other" && block.kind !== "table_row" && block.kind !== "formula") {
      return;
    }
    const stableId = stableFactId({ sourceId: input.sourceId, block, standardCode, ordinal: facts.length + 1 });
    if (seenStableIds.has(stableId)) {
      return;
    }
    seenStableIds.add(stableId);
    const ordinal = facts.length + 1;
    const fact: StructuredFact = {
      id: stableId,
      ordinal,
      stableId,
      legacyIds: [`fact:${ordinal}`, `fact:${ordinal}:${kind}`],
      kind,
      sourceId: input.sourceId,
      standardCode,
      standardIdentity,
      clauseNo: block.clauseNo,
      tableNo: block.tableNo,
      formulaNo: block.formulaNo,
      sourceSection: block.sectionPath.join(" > ") || block.heading,
      subject: block.cells?.[0] ?? block.heading,
      predicate: kind,
      objectValue: block.cells?.slice(1).join(" | "),
      qualifiers: {
        ...(block.rowIndex !== undefined ? { rowIndex: String(block.rowIndex) } : {}),
        ...(block.headers?.length ? { headers: block.headers.join(" | ") } : {})
      },
      rawText: block.normalizedText,
      searchText: "",
      provenance: provenanceForBlock(block)
    };
    fact.searchText = input.searchTextForFact
      ? input.searchTextForFact(fact)
      : [fact.sourceSection, fact.rawText, kind].filter(Boolean).join(" ");
    facts.push(fact);
  });
  return facts;
}

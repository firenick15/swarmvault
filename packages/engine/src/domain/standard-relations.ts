import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { GraphPage } from "../types.js";
import { writeFileIfChanged } from "../utils.js";
import { extractStandardReferences, normalizeStandardCode } from "./env-air.js";

export interface StandardRelationReport {
  inspectedPages: number;
  supersededPages: number;
  amendedPages: number;
  futureReplacementPages: number;
  skippedReplacementPages: number;
  warnings: string[];
}

interface StandardPageRecord {
  page: GraphPage;
  absolutePath: string;
  parsed: ReturnType<typeof matter>;
  standardCode: string;
  effectiveDate?: string;
  replaces: string[];
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function inferStandardCode(page: GraphPage, data: Record<string, unknown>, content: string): string {
  if (typeof data.standard_code === "string" && data.standard_code.trim()) {
    return normalizeStandardCode(data.standard_code);
  }
  const first = extractStandardReferences(`${page.title}\n${content}`)[0];
  return first?.normalized ?? "";
}

function normalizedReplacementCodes(value: unknown): string[] {
  return asStringArray(value)
    .map((item) => normalizeStandardCode(item))
    .filter(Boolean);
}

function metadataString(record: StandardPageRecord, key: string): string {
  const value = record.parsed.data[key];
  return typeof value === "string" ? value.trim() : "";
}

function hasPlaceholderStandardCode(value: string): boolean {
  return /[□]{2,}|X{2,}|待定|TBD|20□□/i.test(value);
}

function isHumanVerified(record: StandardPageRecord): boolean {
  return metadataString(record, "metadata_source") === "sidecar" && metadataString(record, "verification_state") === "human_verified";
}

function isAuthoritativeReplacementRecord(record: StandardPageRecord): boolean {
  if (!record.standardCode || hasPlaceholderStandardCode(record.standardCode)) {
    return false;
  }
  const legalStatus = metadataString(record, "legal_status");
  const documentRole = metadataString(record, "document_role");
  const authorityLayer = metadataString(record, "authority_layer");
  if (["draft_consultation", "explanation_only", "time_scoped_evidence", "unknown"].includes(legalStatus)) {
    return false;
  }
  if (
    [
      "draft",
      "compilation_explanation",
      "official_explanation",
      "whitepaper",
      "research_literature",
      "statistics",
      "technical_guide",
      "local_reference",
      "international_reference"
    ].includes(documentRole)
  ) {
    return false;
  }
  return authorityLayer !== "evolution" || documentRole === "amendment";
}

const NON_AUTHORITATIVE_REPLACEMENT_TARGET_ROLES = new Set([
  "draft",
  "compilation_explanation",
  "official_explanation",
  "whitepaper",
  "research_literature",
  "statistics",
  "technical_guide",
  "local_reference",
  "international_reference"
]);

const AUTHORITATIVE_REPLACEMENT_TARGET_ROLES = new Set([
  "law",
  "regulation",
  "policy",
  "standard",
  "technical_standard",
  "technical_regulation",
  "monitoring_method",
  "qa_qc",
  "emission_standard",
  "amendment"
]);

function hasBackgroundMaterialMarker(record: StandardPageRecord): boolean {
  const haystack = `${record.page.title}\n${record.page.path}\n${record.parsed.content.slice(0, 1200)}`;
  return /月报|年报|公报|白皮书|蓝皮书|研究|论文|综述|技术指南|指南|手册|编制说明|释义|解读|征求意见|草案|draft|consultation/i.test(
    haystack
  );
}

function isAuthoritativeReplacementTarget(record: StandardPageRecord): boolean {
  if (!record.standardCode || hasPlaceholderStandardCode(record.standardCode)) {
    return false;
  }
  const legalStatus = metadataString(record, "legal_status");
  const documentRole = metadataString(record, "document_role");
  const authorityLayer = metadataString(record, "authority_layer");
  if (["draft_consultation", "explanation_only", "time_scoped_evidence"].includes(legalStatus)) {
    return false;
  }
  if (NON_AUTHORITATIVE_REPLACEMENT_TARGET_ROLES.has(documentRole) || hasBackgroundMaterialMarker(record)) {
    return false;
  }
  if (AUTHORITATIVE_REPLACEMENT_TARGET_ROLES.has(documentRole)) {
    return true;
  }
  return (
    (documentRole === "" || documentRole === "unknown") &&
    ["core", "method", "local"].includes(authorityLayer) &&
    !hasBackgroundMaterialMarker(record)
  );
}

function isPartialReplacement(record: StandardPageRecord): boolean {
  const haystack = `${record.page.title}\n${record.parsed.content.slice(0, 2400)}`;
  if (/(全文|全部|整体)(代替|替代)|代替.*(全部|全文)/.test(haystack)) {
    return false;
  }
  return /(部分(代替|替代)|替代.*(附录|条款|表\d+|第[一二三四五六七八九十0-9]+章)|附录[A-ZＡ-Ｚ]?\s*(内容)?)/.test(haystack);
}

export async function applyStandardRelationOverrides(
  wikiDir: string,
  pages: GraphPage[],
  now = new Date()
): Promise<StandardRelationReport> {
  const report: StandardRelationReport = {
    inspectedPages: 0,
    supersededPages: 0,
    amendedPages: 0,
    futureReplacementPages: 0,
    skippedReplacementPages: 0,
    warnings: []
  };
  const records: StandardPageRecord[] = [];

  for (const page of pages.filter((item) => item.kind === "source" || item.kind === "module")) {
    const absolutePath = path.join(wikiDir, page.path);
    try {
      const content = await fs.readFile(absolutePath, "utf8");
      const parsed = matter(content);
      const standardCode = inferStandardCode(page, parsed.data, parsed.content);
      if (!standardCode) {
        continue;
      }
      records.push({
        page,
        absolutePath,
        parsed,
        standardCode,
        effectiveDate: typeof parsed.data.effective_date === "string" ? parsed.data.effective_date : undefined,
        replaces: normalizedReplacementCodes(parsed.data.replaces)
      });
    } catch (error) {
      report.warnings.push(`${page.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  report.inspectedPages = records.length;
  const byCode = new Map<string, StandardPageRecord[]>();
  for (const record of records) {
    const list = byCode.get(record.standardCode) ?? [];
    list.push(record);
    byCode.set(record.standardCode, list);
  }

  const nowTime = now.getTime();
  for (const replacement of records) {
    if (!replacement.replaces.length) {
      continue;
    }
    if (!isAuthoritativeReplacementRecord(replacement)) {
      report.skippedReplacementPages += 1;
      continue;
    }
    const effectiveTime = parseDate(replacement.effectiveDate);
    const isFuture = typeof effectiveTime === "number" && effectiveTime > nowTime;
    const partialReplacement = isPartialReplacement(replacement);
    for (const replacedCode of replacement.replaces) {
      for (const replaced of byCode.get(replacedCode) ?? []) {
        if (replacement.absolutePath === replaced.absolutePath || !isAuthoritativeReplacementTarget(replaced)) {
          report.skippedReplacementPages += 1;
          continue;
        }
        if (isHumanVerified(replaced)) {
          report.warnings.push(
            `${replaced.page.path}: human-verified status was not overridden by ${replacement.standardCode}; update sidecar metadata if the replacement is confirmed.`
          );
          continue;
        }
        const data = replaced.parsed.data;
        const relationField = isFuture ? "future_replaced_by" : partialReplacement ? "amended_by" : "replaced_by";
        const existing = new Set(asStringArray(data[relationField]));
        existing.add(replacement.standardCode);
        data[relationField] = [...existing].sort();
        if (!isFuture) {
          if (partialReplacement) {
            data.legal_status = "amended";
            report.amendedPages += 1;
          } else {
            data.legal_status = "superseded";
            report.supersededPages += 1;
          }
        } else {
          report.futureReplacementPages += 1;
        }
        await writeFileIfChanged(replaced.absolutePath, matter.stringify(replaced.parsed.content, data));
      }
    }
  }

  return report;
}

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { GraphPage } from "../types.js";
import { writeFileIfChanged } from "../utils.js";
import { extractStandardReferences, normalizeStandardCode } from "./env-air.js";

export interface StandardRelationReport {
  inspectedPages: number;
  supersededPages: number;
  futureReplacementPages: number;
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

export async function applyStandardRelationOverrides(
  wikiDir: string,
  pages: GraphPage[],
  now = new Date()
): Promise<StandardRelationReport> {
  const report: StandardRelationReport = {
    inspectedPages: 0,
    supersededPages: 0,
    futureReplacementPages: 0,
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
    const effectiveTime = parseDate(replacement.effectiveDate);
    const isFuture = typeof effectiveTime === "number" && effectiveTime > nowTime;
    for (const replacedCode of replacement.replaces) {
      for (const replaced of byCode.get(replacedCode) ?? []) {
        const data = replaced.parsed.data;
        const relationField = isFuture ? "future_replaced_by" : "replaced_by";
        const existing = new Set(asStringArray(data[relationField]));
        existing.add(replacement.standardCode);
        data[relationField] = [...existing].sort();
        if (!isFuture) {
          data.legal_status = "superseded";
          report.supersededPages += 1;
        } else {
          report.futureReplacementPages += 1;
        }
        await writeFileIfChanged(replaced.absolutePath, matter.stringify(replaced.parsed.content, data));
      }
    }
  }

  return report;
}

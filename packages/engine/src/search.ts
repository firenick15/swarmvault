import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import {
  buildEnvAirSearchText,
  type EnvAirQueryPlan,
  extractStandardReferences,
  normalizeStandardCode,
  pollutantFocusTermsForQuery,
  searchLikeTerms,
  standardIdentityKey,
  standardRefsForExactRetrieval
} from "./domain/env-air.js";
import { extractEnvAirStructuredFacts, renderStructuredFactSnippet } from "./domain/env-air-facts.js";
import { normalizeEnvAirLegalStatus } from "./domain/env-air-status.js";
import { buildDomainQueryPlan } from "./domain/intents.js";
import type { LoadedDomainProfile } from "./domain/profile-loader.js";
import { searchTokens } from "./tokenize.js";
import type {
  GraphPage,
  PageKind,
  PageStatus,
  QueryIntent,
  SearchResult,
  SourceCaptureType,
  SourceClass,
  SourceManifest
} from "./types.js";
import { ensureDir } from "./utils.js";

export interface SearchPageFilters {
  kind?: string;
  status?: string;
  project?: string;
  sourceType?: string;
  sourceClass?: string;
  authorityLayer?: string | string[];
  legalStatus?: string | string[];
  documentRole?: string | string[];
  jurisdiction?: string;
  region?: string;
  pollutant?: string;
  scope?: "public_only" | "tenant_only" | "project_only" | "mixed_public_private";
  visibility?: "public" | "tenant" | "project";
  tenantId?: string;
  includeDrafts?: boolean;
  includeSuperseded?: boolean;
  intent?: QueryIntent;
  requireCurrentBasis?: boolean;
  strictGrounding?: boolean;
}

export interface SearchQueryOptions extends SearchPageFilters {
  limit?: number;
  domainProfile?: LoadedDomainProfile;
  chunking?: {
    enabled?: boolean;
    maxChars?: number;
    overlapChars?: number;
  };
}

type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;

function warningMessage(warning: string | Error): string {
  return warning instanceof Error ? warning.message : String(warning);
}

function warningType(warning: string | Error, type?: string): string | undefined {
  if (warning instanceof Error) {
    return warning.name;
  }
  return typeof type === "string" ? type : undefined;
}

function isSqliteExperimentalWarning(warning: string | Error, type?: string): boolean {
  return warningType(warning, type) === "ExperimentalWarning" && warningMessage(warning).includes("SQLite is an experimental feature");
}

function withSuppressedSqliteExperimentalWarning<T>(run: () => T): T {
  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, options?: string | Error | Record<string, unknown>, ...args: unknown[]) => {
    const type =
      typeof options === "string"
        ? options
        : typeof (options as { type?: unknown } | undefined)?.type === "string"
          ? ((options as { type?: string }).type ?? undefined)
          : undefined;
    if (isSqliteExperimentalWarning(warning, type)) {
      return;
    }
    return originalEmitWarning(warning as never, options as never, ...(args as never[]));
  }) as typeof process.emitWarning;
  try {
    return run();
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

function getDatabaseSync(): DatabaseSyncCtor {
  const builtin = withSuppressedSqliteExperimentalWarning(
    () => process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined
  );
  if (!builtin?.DatabaseSync) {
    throw new Error("node:sqlite is unavailable in this Node runtime.");
  }
  return builtin.DatabaseSync;
}

function sqliteImmutableReadOnlyUri(dbPath: string): string {
  const url = pathToFileURL(path.resolve(dbPath));
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return url.href;
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function toFtsQuery(query: string): string {
  return searchTokens(query).map(quoteFtsToken).join(" OR ");
}

function normalizeKind(value: unknown): PageKind | undefined {
  return value === "index" ||
    value === "source" ||
    value === "module" ||
    value === "concept" ||
    value === "entity" ||
    value === "output" ||
    value === "insight" ||
    value === "memory_task" ||
    value === "graph_report" ||
    value === "community_summary"
    ? value
    : undefined;
}

function normalizeStatus(value: unknown): PageStatus | undefined {
  return value === "draft" ||
    value === "candidate" ||
    value === "active" ||
    value === "blocked" ||
    value === "completed" ||
    value === "archived"
    ? value
    : undefined;
}

function normalizeSourceType(value: unknown): SourceCaptureType | undefined {
  return value === "arxiv" || value === "doi" || value === "tweet" || value === "article" || value === "url" ? value : undefined;
}

function normalizeSourceClass(value: unknown): SourceClass | undefined {
  return value === "first_party" || value === "third_party" || value === "resource" || value === "generated" ? value : undefined;
}

function normalizeChunkKind(value: unknown): SearchResult["chunkKind"] | undefined {
  return value === "paragraph" || value === "table" || value === "formula" || value === "heading" ? value : undefined;
}

function normalizeRetrievalStage(value: unknown): SearchResult["retrievalStage"] | undefined {
  return value === "source_alias" ||
    value === "standard_exact" ||
    value === "structured_fact" ||
    value === "fts" ||
    value === "chunk_fts" ||
    value === "like" ||
    value === "semantic" ||
    value === "rerank"
    ? value
    : undefined;
}

function normalizeEvidenceRole(value: unknown): SearchResult["evidenceRole"] | undefined {
  return value === "current_authority" ||
    value === "method" ||
    value === "official_explanation" ||
    value === "statistics" ||
    value === "research" ||
    value === "local_adaptation" ||
    value === "evolution" ||
    value === "background"
    ? value
    : undefined;
}

function parseJsonStringList(value: unknown): string[] | undefined {
  const raw = typeof value === "string" ? value : "";
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(value: unknown): Record<string, string> | undefined {
  const raw = typeof value === "string" ? value : "";
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return undefined;
  }
}

function uniqueCompact(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
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

function normalizeAliasText(value: string): string {
  return value
    .replace(/\\(?:mathrm|mathsf|mathbf|bf)\s*\{([^}]*)\}/gi, "$1")
    .replace(/\\left|\\right|\\mathrm|\\mathsf|\\mathbf|\\bf/gi, " ")
    .replace(/[_{}$()[\]（）《》“”"']/g, " ")
    .replace(/[，、；;:：/\\|-]+/g, " ")
    .replace(/\bP\s*M\s*2\s*\.?\s*5\b/gi, "PM2.5")
    .replace(/\bP\s*M\s*1\s*0\b/gi, "PM10")
    .replace(/\bS\s*O\s*2\b/gi, "SO2")
    .replace(/\bN\s*O\s*2\b/gi, "NO2")
    .replace(/\bO\s*3\b/gi, "O3")
    .replace(/\bN\s*O\s*x\b/gi, "NOx")
    .replace(/\s+/g, " ")
    .trim();
}

function compactAliasText(value: string): string {
  return normalizeAliasText(value).toLowerCase().replace(/\s+/g, "");
}

function fileStemAliases(sourcePath: string): string[] {
  if (!sourcePath) {
    return [];
  }
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const cleaned = normalizeAliasText(stem.replace(/[_-]+/g, " "));
  return uniqueCompact([
    stem,
    cleaned,
    cleaned.replace(/\b(19|20)\d{2}\b/g, "").trim(),
    ...cleaned.split(/\s+/).filter((part) => /[\p{Script=Han}]{4,}|[A-Z]{1,4}\s*\d{2,6}|\d+号/u.test(part))
  ]);
}

function quotedTitleAliases(text: string): string[] {
  return uniqueCompact(
    [...text.matchAll(/[《「“"]([^》」”"]{4,80})[》」”"]/gu)].map((match) => normalizeAliasText(match[1] ?? "")).filter(Boolean)
  ).slice(0, 12);
}

function documentNumberAliases(value: string): string[] {
  const normalized = normalizeAliasText(value);
  const aliases = new Set<string>();
  const add = (item: string | undefined): void => {
    const cleaned = normalizeAliasText(item ?? "");
    if (cleaned) {
      aliases.add(cleaned);
    }
  };
  add(normalized);
  for (const match of normalized.matchAll(/(?:第\s*)?([0-9一二三四五六七八九十百]+)\s*号/gu)) {
    add(`${match[1]}号`);
    add(`第${match[1]}号`);
  }
  for (const match of normalized.matchAll(/([\u4e00-\u9fa5]{1,8})\s*发\s*〔?\s*((?:19|20)\d{2})\s*〕?\s*([0-9]+)\s*号/gu)) {
    add(`${match[1]}发〔${match[2]}〕${match[3]}号`);
    add(`${match[1]}发${match[2]}${match[3]}号`);
  }
  return [...aliases];
}

function frontmatterAliases(data: Record<string, unknown>): string[] {
  const values: string[] = [];
  const addValue = (value: unknown): void => {
    if (typeof value === "string") {
      values.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        addValue(item);
      }
    }
  };
  for (const key of ["title", "canonical_title", "canonicalTitle", "aliases", "standard_code", "document_number", "documentNumber"]) {
    addValue(data[key]);
  }
  return uniqueCompact(values.flatMap((value) => [value, ...documentNumberAliases(value), ...quotedTitleAliases(value)]));
}

function buildSourceCanonicalAliases(input: {
  page: GraphPage;
  parsedData: Record<string, unknown>;
  sourcePath: string;
  standardCode: string;
  rawSourceText: string;
  body: string;
}): string[] {
  const aliasText = [input.page.title, input.standardCode, input.sourcePath].join("\n");
  return uniqueCompact([
    input.page.id,
    input.page.title,
    path.basename(input.page.path, path.extname(input.page.path)),
    ...frontmatterAliases(input.parsedData),
    ...fileStemAliases(input.sourcePath),
    ...documentNumberAliases(input.standardCode),
    ...quotedTitleAliases(aliasText)
  ]).slice(0, 80);
}

function sourceAliasQueryTerms(query: string): string[] {
  const normalized = normalizeAliasText(query);
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[\p{Script=Han}]{4,40}/gu)) {
    const rawValue = match[0];
    const actionSplit = rawValue
      .split(/(?:什么时候|何时|多久|怎么|如何|应该|能否|是否|可否|规定|要求|引用|作为|主要|管理|报告|里|在)/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 6);
    const candidates = actionSplit.length ? actionSplit : [rawValue];
    for (const value of candidates) {
      if (value.length >= 10) {
        terms.add(value);
      }
      for (let size = Math.min(22, value.length); size >= 10; size -= 2) {
        for (let index = 0; index + size <= value.length; index += Math.max(1, Math.floor(size / 2))) {
          terms.add(value.slice(index, index + size));
        }
      }
    }
  }
  for (const match of normalized.matchAll(
    /(?:国发|环发|环办|生态环境部令|环境保护部令)\s*〔?\s*(?:19|20)\d{2}\s*〕?\s*[0-9]+\s*号|[\p{Script=Han}]{2,12}\s*[0-9一二三四五六七八九十百]+\s*号令?|(?:第\s*)?[0-9一二三四五六七八九十百]+\s*号/gu
  )) {
    terms.add(match[0]);
  }
  return uniqueCompact([...terms]).slice(0, 36);
}

function sourceIdentityQueryTerms(plan: EnvAirQueryPlan): string[] {
  const generic = new Set(["技术要求", "检测方法", "运行质控", "质量控制", "质量保证", "数据传输", "统计期", "评价城市", "城市数量"]);
  return uniqueCompact([...plan.pinnedStandards, ...plan.expandedTerms])
    .filter((term) => term.length >= 4 && term.length <= 64)
    .filter((term) => !generic.has(term))
    .filter(
      (term) =>
        /号令|令第|管理办法|现场监督检查办法|现场检查|自动监控|在线监控|在线监控数据|污染源自动监控|CEMS离线|弄虚作假|全国城市空气质量报告|城市空气质量排名|环境空气质量月报|环境空气质量公报|环境空气质量标准/u.test(
          term
        ) || /重污染天气|应急减排|应急预警|应急响应|绩效分级|秋冬季攻坚/u.test(term)
    )
    .filter((term) => /[\p{Script=Han}A-Za-z0-9]/u.test(term))
    .slice(0, 24);
}

function normalizedStandardQuery(query: string): string {
  return query
    .replace(/\bgb\s*\/\s*t\s*[- ]?([0-9]{2,6})(?:\s*[- ]\s*([0-9]{2,4}))?\b/gi, (_match, number, year) =>
      year ? `GB/T ${number}-${year}` : `GB/T ${number}`
    )
    .replace(/\bgb\s*[- ]?([0-9]{3,5})\b/gi, "gb $1")
    .replace(/\bhj\s*\/\s*t\s*[- ]?([0-9]{2,6})(?:\s*[- ]\s*([0-9]{2,4}))?\b/gi, (_match, number, year) =>
      year ? `HJ/T ${number}-${year}` : `HJ/T ${number}`
    )
    .replace(/\bhj\s*[- ]?([0-9]{3,5})\b/gi, "hj $1")
    .replace(/\bdb\s*([0-9]{2})\s*\/?\s*t?\s*[- ]?([0-9]{2,6})(?:\s*[- ]\s*([0-9]{2,4}))?\b/gi, (_match, region, number, year) =>
      year ? `DB${region}/T ${number}-${year}` : `DB${region}/T ${number}`
    )
    .replace(/[-‐‑‒–—―]/g, "-")
    .replace(/\bpm\s*2\s*\.?\s*5\b/gi, "pm2.5")
    .replace(/\bpm\s*1\s*0\b/gi, "pm10")
    .trim();
}

function shouldExtractEnvAirFacts(input: {
  kind: PageKind;
  title: string;
  body: string;
  standardCode: string;
  standardRefCount: number;
}): boolean {
  if (input.kind !== "source" && input.kind !== "module") {
    return false;
  }
  if (input.standardCode || input.standardRefCount > 0) {
    return true;
  }
  return /(环境空气|空气质量|大气污染|PM\s*2\.?5|PM\s*10|臭氧|二氧化硫|二氧化氮|一氧化碳|VOCs|非甲烷总烃|AQI|IAQI)/i.test(
    `${input.title}\n${input.body.slice(0, 5000)}`
  );
}

interface SearchChunk {
  chunkId: string;
  ordinal: number;
  heading: string;
  kind: "paragraph" | "table" | "formula" | "heading";
  location: string;
  text: string;
  searchTerms: string;
}

function classifyChunkKind(text: string): SearchChunk["kind"] {
  const trimmed = text.trim();
  const markdownTableLineCount = trimmed.split(/\r?\n/).filter((line) => line.includes("|") && /\|.*\|/.test(line)).length;
  if (markdownTableLineCount >= 2 || /<table[\s>]/i.test(trimmed)) {
    return "table";
  }
  if (/^#{1,6}\s/.test(trimmed)) {
    if (/(^#{1,6}\s*表\s*[0-9一二三四五六七八九十]|浓度限值|限值表)/.test(trimmed)) {
      return "table";
    }
    if (/(^#{1,6}\s*公式|计算公式)/.test(trimmed)) {
      return "formula";
    }
    return "heading";
  }
  if (/[=＝]/.test(trimmed) && /(公式|计算|浓度|限值|平均|mg\/m3|μg\/m3|ug\/m3|μg\/m³|ug\/m³)/i.test(trimmed)) {
    return "formula";
  }
  return "paragraph";
}

function sourceExcerptBody(text: string): string {
  const marker = "## Source Excerpt";
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    return text;
  }
  const excerpt = text.slice(markerIndex + marker.length).trim();
  return excerpt || text;
}

function stripGeneratedSourceSections(text: string): string {
  const generatedHeadings = new Set(["Concepts", "Entities", "Claims", "Questions", "Analysis Warnings", "Code Module"]);
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/)?.[1];
    if (heading) {
      skipping = generatedHeadings.has(heading);
      if (skipping) {
        continue;
      }
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  return kept.join("\n").trim();
}

function includesFocusTerm(text: string, focusTerms: string[]): boolean {
  const compact = compactAliasText(text);
  return focusTerms.some((term) => compact.includes(compactAliasText(term)));
}

function requiredAmbientPeriodGroups(query: string): string[][] {
  const compact = query.toLowerCase().replace(/\s+/g, "");
  const groups: string[][] = [];
  if (/日最大8小时|8小时|mda8/.test(compact)) {
    groups.push(["日最大8小时平均", "8小时平均", "8小时", "MDA8"]);
  }
  if (/1小时|一小时/.test(compact)) {
    groups.push(["1小时平均", "1小时", "一小时"]);
  }
  if (/24小时|日平均|日均/.test(compact)) {
    groups.push(["24小时平均", "24小时", "日平均", "日均"]);
  }
  if (/年平均|年均/.test(compact)) {
    groups.push(["年平均", "年均"]);
  }
  return groups;
}

function focusedTableRowsSnippet(text: string, focusTerms: string[], maxChars = 2200): string {
  const sourceText = sourceExcerptBody(text).trim();
  const htmlRows = sourceText.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (htmlRows.length) {
    const selected = new Set<number>();
    const pollutantTerms = focusTerms.filter((term) => !/(平均|限值|一级|二级|表)/.test(term));
    htmlRows.forEach((row, index) => {
      if (includesFocusTerm(row, pollutantTerms)) {
        selected.add(index - 1);
        selected.add(index);
        selected.add(index + 1);
        selected.add(index + 2);
      } else if (includesFocusTerm(row, focusTerms)) {
        selected.add(index);
      }
    });
    const selectedRows = [...selected].filter((index) => index >= 0 && index < htmlRows.length).sort((left, right) => left - right);
    if (selectedRows.length) {
      return [...htmlRows.slice(0, Math.min(2, htmlRows.length)), ...selectedRows.map((index) => htmlRows[index])]
        .filter((row, index, all) => all.indexOf(row) === index)
        .join("\n")
        .slice(0, maxChars)
        .trim();
    }
  }

  const tableLines = sourceText.split(/\r?\n/).filter((line) => line.includes("|"));
  if (tableLines.length >= 2) {
    const selected = new Set<number>();
    tableLines.forEach((line, index) => {
      if (includesFocusTerm(line, focusTerms)) {
        selected.add(index - 1);
        selected.add(index);
        selected.add(index + 1);
      }
    });
    const selectedRows = [...selected].filter((index) => index >= 0 && index < tableLines.length).sort((left, right) => left - right);
    if (selectedRows.length) {
      return [...tableLines.slice(0, 2), ...selectedRows.map((index) => tableLines[index])]
        .filter((line, index, all) => all.indexOf(line) === index)
        .join("\n")
        .slice(0, maxChars)
        .trim();
    }
  }
  return "";
}

function focusedChunkSnippet(text: string, focusTerms: string[], maxChars = 1800, options: { preserveTableRows?: boolean } = {}): string {
  const sourceText = sourceExcerptBody(text).trim();
  if (
    options.preserveTableRows &&
    (/<table[\s>]/i.test(sourceText) || sourceText.includes("|") || /(^|\n)\s*表\s*[0-9A-Z一二三四五六七八九十]/u.test(sourceText))
  ) {
    return sourceText.slice(0, maxChars).trim();
  }
  if (/<table[\s>]/i.test(sourceText) || sourceText.includes("|")) {
    const tableSnippet = focusedTableRowsSnippet(sourceText, focusTerms, maxChars);
    if (tableSnippet) {
      return tableSnippet;
    }
  }
  let firstPosition = -1;
  for (const term of focusTerms) {
    const position = sourceText.indexOf(term);
    if (position >= 0) {
      firstPosition = position;
      break;
    }
  }
  if (firstPosition < 0) {
    firstPosition = 0;
  }
  if (/<table[\s>]/i.test(sourceText) && firstPosition > 900) {
    const header = sourceText.slice(0, 700).trim();
    const focused = sourceText.slice(Math.max(0, firstPosition - 260), firstPosition + 900).trim();
    return `${header}\n...\n${focused}`.slice(0, maxChars).trim();
  }
  const start = Math.max(0, firstPosition - 80);
  return sourceText.slice(start, start + maxChars).trim();
}

function listCompletenessItemHitCount(text: string): number {
  const labels = [
    "示值误差",
    "影响测试",
    "流量测试",
    "参比方法比对",
    "有效数据率",
    "平行性",
    "检出限",
    "校准",
    "比对",
    "验收",
    "质控",
    "评价项目",
    "监测项目"
  ];
  const hits = new Set<string>();
  for (const label of labels) {
    if (text.includes(label)) {
      hits.add(label);
    }
  }
  return hits.size;
}

function hasUsefulAmbientLimitSnippet(snippet: string, query: string): boolean {
  const focusTerms = pollutantFocusTermsForQuery(query);
  const pollutantTerms = focusTerms.filter((term) => !/(平均|限值|一级|二级|表)/.test(term));
  const hasPollutant = includesFocusTerm(snippet, pollutantTerms.length ? pollutantTerms : focusTerms);
  const hasLimitContext = /(平均|浓度限值|一级|二级)/.test(snippet);
  const hasRequestedPeriods = requiredAmbientPeriodGroups(query).every((group) => includesFocusTerm(snippet, group));
  return hasPollutant && hasLimitContext && hasRequestedPeriods;
}

function hasUsefulAmendmentSnippet(snippet: string): boolean {
  return /(将|修改为|替换|删除|增加|按式|式中|结果表示)/.test(snippet);
}

function meaningfulMetadataValue(value: unknown): string {
  return typeof value === "string" && value.trim() && value.trim() !== "unknown" ? value.trim() : "";
}

function generatedStatusNoticeLegalStatus(text: string): string {
  const match =
    text.match(
      /Normalized legal status:\s*`?\s*(current_effective|issued_not_yet_effective|draft_consultation|superseded|amended|explanation_only|time_scoped_evidence)\s*`?/i
    ) ??
    text.match(
      /legal_status_normalized:[^\n\r]*(current_effective|issued_not_yet_effective|draft_consultation|superseded|amended|explanation_only|time_scoped_evidence)/i
    );
  return match?.[1] ? match[1].toLowerCase() : "";
}

function pathIncludes(sourcePath: string, needle: string): boolean {
  return sourcePath.replace(/\\/g, "/").toLowerCase().includes(needle.toLowerCase());
}

function inferEnvAirMetadata(input: {
  title: string;
  body: string;
  sourcePath: string;
  authorityLayer: string;
  legalStatus: string;
  documentRole: string;
}): { authorityLayer: string; legalStatus: string; documentRole: string } {
  let authorityLayer = meaningfulMetadataValue(input.authorityLayer);
  let legalStatus = meaningfulMetadataValue(input.legalStatus);
  let documentRole = meaningfulMetadataValue(input.documentRole);
  const sourcePath = input.sourcePath.replace(/\\/g, "/");
  const combined = `${input.title}\n${sourcePath}\n${sourceExcerptBody(input.body).slice(0, 1200)}`;
  const statusNoticeLegalStatus = generatedStatusNoticeLegalStatus(input.body);
  if (!legalStatus && statusNoticeLegalStatus) {
    legalStatus = statusNoticeLegalStatus;
  }

  if (!authorityLayer) {
    if (pathIncludes(sourcePath, "/evolution/")) {
      authorityLayer = "evolution";
    } else if (pathIncludes(sourcePath, "/local_references/")) {
      authorityLayer = "local";
    } else if (pathIncludes(sourcePath, "/evidence/")) {
      authorityLayer = "evidence";
    } else if (pathIncludes(sourcePath, "/technical_guides/")) {
      authorityLayer = "method";
    } else if (pathIncludes(sourcePath, "/core/")) {
      authorityLayer = "core";
    }
  }

  if (!documentRole) {
    if (/(修改单|amendment)/i.test(combined)) {
      documentRole = "amendment";
    } else if (/(编制说明|compilation)/i.test(combined)) {
      documentRole = "compilation_explanation";
    } else if (/(征求意见稿|draft|consultation)/i.test(combined)) {
      documentRole = "draft";
    } else if (/(年报|月报|公报)/i.test(combined)) {
      documentRole = "statistics";
    } else if (/(白皮书|蓝皮书|whitepaper|white paper)/i.test(combined)) {
      documentRole = "whitepaper";
    } else if (/(研究|论文|综述|journal|article)/i.test(combined)) {
      documentRole = "research_literature";
    } else if (/(技术指南|technical[_ -]?guide|guide)/i.test(combined)) {
      documentRole = "technical_guide";
    } else if (/(监测方法|monitoring_methods|测定|采样)/i.test(combined)) {
      documentRole = "monitoring_method";
    } else if (/(standards|标准)/i.test(combined)) {
      documentRole = "standard";
    }
  }

  if (!legalStatus) {
    if (/(征求意见稿|draft|consultation)/i.test(combined)) {
      legalStatus = "draft_consultation";
    } else if (/(废止|历史版本|superseded)/i.test(combined)) {
      legalStatus = "superseded";
    } else if (documentRole === "statistics") {
      legalStatus = "time_scoped_evidence";
    } else if (documentRole === "research_literature" || documentRole === "whitepaper" || documentRole === "official_explanation") {
      legalStatus = "explanation_only";
    } else if (documentRole === "amendment" || authorityLayer === "core" || authorityLayer === "method" || authorityLayer === "local") {
      legalStatus = "current_effective";
    }
  }

  const normalizedStatus = normalizeEnvAirLegalStatus({
    title: input.title,
    path: input.sourcePath,
    authorityLayer,
    documentRole,
    legalStatus
  });
  return {
    authorityLayer: normalizedStatus.authorityLayer ?? authorityLayer,
    legalStatus: normalizedStatus.legalStatus,
    documentRole: normalizedStatus.documentRole ?? documentRole
  };
}

function inferEvidenceRole(input: {
  authorityLayer?: string;
  legalStatus?: string;
  documentRole?: string;
}): NonNullable<SearchResult["evidenceRole"]> {
  if (input.documentRole === "statistics" || input.legalStatus === "time_scoped_evidence") {
    return "statistics";
  }
  if (input.documentRole === "research_literature") {
    return "research";
  }
  if (input.authorityLayer === "evolution" || input.documentRole === "draft" || input.documentRole === "compilation_explanation") {
    return "evolution";
  }
  if (input.authorityLayer === "local" || input.documentRole === "local_reference") {
    return "local_adaptation";
  }
  if (input.documentRole === "technical_guide" || input.documentRole === "official_explanation" || input.documentRole === "whitepaper") {
    return "official_explanation";
  }
  if (input.authorityLayer === "method" || input.documentRole === "monitoring_method" || input.documentRole === "qa_qc") {
    return "method";
  }
  if (
    input.authorityLayer === "core" ||
    input.documentRole === "standard" ||
    input.documentRole === "law" ||
    input.documentRole === "regulation" ||
    input.documentRole === "amendment"
  ) {
    return "current_authority";
  }
  return "background";
}

function buildSearchChunks(input: {
  pageId: string;
  title: string;
  body: string;
  standardCode?: string;
  pollutants?: string[];
  maxChars?: number;
  overlapChars?: number;
}): SearchChunk[] {
  const maxChars = Math.max(400, input.maxChars ?? 1600);
  const tableMaxChars = Math.max(maxChars, 6000);
  const overlapChars = Math.max(0, Math.min(input.overlapChars ?? 160, Math.floor(maxChars / 3)));
  const chunks: SearchChunk[] = [];
  let heading = input.title;
  let buffer = "";
  let bufferHeading = heading;
  let ordinal = 1;

  function flush(): void {
    const text = buffer.trim();
    if (!text) {
      buffer = "";
      return;
    }
    const location = bufferHeading ? `heading:${bufferHeading}` : `chunk:${ordinal}`;
    chunks.push({
      chunkId: `${input.pageId}#chunk-${ordinal}`,
      ordinal,
      heading: bufferHeading,
      kind: classifyChunkKind(text),
      location,
      text,
      searchTerms: buildEnvAirSearchText({
        title: `${input.title} ${bufferHeading}`,
        body: text,
        standardCode: input.standardCode,
        pollutants: input.pollutants
      })
    });
    ordinal += 1;
    buffer = overlapChars > 0 ? text.slice(Math.max(0, text.length - overlapChars)) : "";
  }

  for (const block of input.body.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/m);
    if (headingMatch) {
      if (buffer.length > maxChars / 2) {
        flush();
      }
      heading = headingMatch[1].trim();
    }
    const next = buffer ? `${buffer}\n\n${trimmed}` : trimmed;
    const nextKind = classifyChunkKind(next);
    const effectiveMaxChars = nextKind === "table" ? tableMaxChars : maxChars;
    if (next.length > effectiveMaxChars && buffer) {
      flush();
      bufferHeading = heading;
      buffer = trimmed;
    } else {
      bufferHeading = bufferHeading || heading;
      buffer = next;
    }
    if (buffer.length >= effectiveMaxChars) {
      flush();
      bufferHeading = heading;
    }
  }
  flush();
  return chunks;
}

export async function rebuildSearchIndex(
  dbPath: string,
  pages: GraphPage[],
  wikiDir: string,
  options: { chunking?: SearchQueryOptions["chunking"] } = {}
): Promise<void> {
  await ensureDir(path.dirname(dbPath));
  const DatabaseSync = getDatabaseSync();
  const db = withSuppressedSqliteExperimentalWarning(() => new DatabaseSync(dbPath));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    DROP TABLE IF EXISTS page_search;
    DROP TABLE IF EXISTS chunk_search;
    DROP TABLE IF EXISTS fact_search;
    DROP TABLE IF EXISTS facts;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS pages;
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_class TEXT NOT NULL,
      authority_layer TEXT NOT NULL,
      legal_status TEXT NOT NULL,
      document_role TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      region TEXT NOT NULL,
      standard_code TEXT NOT NULL,
      standard_identity TEXT NOT NULL,
      standard_code_normalized TEXT NOT NULL,
      standard_family TEXT NOT NULL,
      standard_number TEXT NOT NULL,
      standard_year TEXT NOT NULL,
      pollutants TEXT NOT NULL,
      evidence_role TEXT NOT NULL,
      reporting_period TEXT NOT NULL,
      evidence_period TEXT NOT NULL,
      visibility TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      source_scope TEXT NOT NULL,
      search_terms TEXT NOT NULL,
      project_ids TEXT NOT NULL,
      project_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      heading TEXT NOT NULL,
      kind TEXT NOT NULL,
      location TEXT NOT NULL,
      text TEXT NOT NULL,
      search_terms TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      fact_ordinal INTEGER NOT NULL,
      fact_stable_id TEXT NOT NULL,
      fact_legacy_ids TEXT NOT NULL,
      fact_type TEXT NOT NULL,
      table_name TEXT NOT NULL,
      clause_no TEXT NOT NULL,
      table_no TEXT NOT NULL,
      formula_no TEXT NOT NULL,
      source_section TEXT NOT NULL,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_value TEXT NOT NULL,
      qualifiers_json TEXT NOT NULL,
      provenance TEXT NOT NULL,
      standard_identity TEXT NOT NULL,
      evidence_role TEXT NOT NULL,
      source_authority_layer TEXT NOT NULL,
      source_document_role TEXT NOT NULL,
      source_legal_status TEXT NOT NULL,
      reporting_period TEXT NOT NULL,
      evidence_period TEXT NOT NULL,
      pollutant TEXT NOT NULL,
      metric TEXT NOT NULL,
      averaging_period TEXT NOT NULL,
      value TEXT NOT NULL,
      unit TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      search_terms TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
      title,
      body,
      search_terms,
      content='pages',
      content_rowid='rowid'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(
      text,
      search_terms,
      content='chunks',
      content_rowid='rowid'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fact_search USING fts5(
      raw_text,
      search_terms,
      content='facts',
      content_rowid='rowid'
    );
    DELETE FROM fact_search;
    DELETE FROM facts;
    DELETE FROM chunk_search;
    DELETE FROM chunks;
    DELETE FROM page_search;
    DELETE FROM pages;
  `);

  const insertPage = db.prepare(
    "INSERT INTO pages (id, path, title, body, kind, status, source_type, source_class, authority_layer, legal_status, document_role, jurisdiction, region, standard_code, standard_identity, standard_code_normalized, standard_family, standard_number, standard_year, pollutants, evidence_role, reporting_period, evidence_period, visibility, tenant_id, source_scope, search_terms, project_ids, project_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, page_id, ordinal, heading, kind, location, text, search_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertFact = db.prepare(
    "INSERT INTO facts (id, page_id, fact_ordinal, fact_stable_id, fact_legacy_ids, fact_type, table_name, clause_no, table_no, formula_no, source_section, subject, predicate, object_value, qualifiers_json, provenance, standard_identity, evidence_role, source_authority_layer, source_document_role, source_legal_status, reporting_period, evidence_period, pollutant, metric, averaging_period, value, unit, raw_text, search_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const rootDir = path.dirname(wikiDir);

  db.exec("BEGIN TRANSACTION;");
  try {
    for (const page of pages) {
      const absolutePath = path.join(wikiDir, page.path);
      const content = await fs.readFile(absolutePath, "utf8");
      const parsed = matter(content);
      let body = parsed.content;
      let rawSourceText = "";
      let sourcePath = "";
      const primarySourceId =
        Array.isArray(parsed.data.source_ids) && typeof parsed.data.source_ids[0] === "string"
          ? parsed.data.source_ids[0]
          : page.sourceIds[0];
      if ((page.kind === "source" || page.kind === "module") && primarySourceId) {
        try {
          const manifest = JSON.parse(
            await fs.readFile(path.join(rootDir, "state", "manifests", `${primarySourceId}.json`), "utf8")
          ) as SourceManifest;
          sourcePath = manifest.originalPath ?? manifest.storedPath ?? manifest.extractedTextPath ?? "";
          const excerptPath = manifest.extractedTextPath ?? manifest.storedPath;
          if (excerptPath) {
            const excerpt = await fs.readFile(path.join(rootDir, excerptPath), "utf8");
            if (excerpt.trim()) {
              rawSourceText = excerpt.trim();
              body = `${body}\n\n## Source Excerpt\n\n${rawSourceText}`.trim();
            }
          }
        } catch {
          // Leave the page searchable via its generated markdown alone when source excerpts are unavailable.
        }
      }
      const standardCode = typeof parsed.data.standard_code === "string" ? parsed.data.standard_code : "";
      const reportingPeriod = typeof parsed.data.reporting_period === "string" ? parsed.data.reporting_period : "";
      const evidencePeriod = typeof parsed.data.evidence_period === "string" ? parsed.data.evidence_period : reportingPeriod;
      const visibility =
        parsed.data.visibility === "tenant" || parsed.data.visibility === "project" || parsed.data.visibility === "public"
          ? parsed.data.visibility
          : page.projectIds.length
            ? "project"
            : "public";
      const tenantId = typeof parsed.data.tenant_id === "string" ? parsed.data.tenant_id : "";
      const sourceScope =
        typeof parsed.data.source_scope === "string"
          ? parsed.data.source_scope
          : visibility === "public"
            ? "public_authority"
            : visibility === "tenant"
              ? "tenant_private"
              : "project_private";
      const inferredMetadata = inferEnvAirMetadata({
        title: page.title,
        body,
        sourcePath,
        authorityLayer: parsed.data.authority_layer,
        legalStatus: parsed.data.legal_status,
        documentRole: parsed.data.document_role
      });
      const standards = extractStandardReferences([page.title, standardCode, body].join("\n"));
      const firstStandard = standards[0];
      const standardIdentity = standardIdentityKey(standardCode || firstStandard);
      const evidenceRole = inferEvidenceRole(inferredMetadata);
      const pollutants = Array.isArray(parsed.data.pollutants)
        ? (parsed.data.pollutants as unknown[]).filter((item): item is string => typeof item === "string")
        : typeof parsed.data.pollutants === "string"
          ? parsed.data.pollutants
              .split("|")
              .map((item) => item.trim())
              .filter(Boolean)
          : [];
      const canonicalAliases = buildSourceCanonicalAliases({
        page,
        parsedData: parsed.data,
        sourcePath,
        standardCode,
        rawSourceText,
        body
      });
      const searchTerms = uniqueCompact([
        buildEnvAirSearchText({ title: page.title, body, standardCode, pollutants }),
        ...canonicalAliases,
        ...canonicalAliases.map((alias) => alias.replace(/\s+/g, "")),
        ...canonicalAliases.map(compactAliasText)
      ]).join(" ");
      insertPage.run(
        page.id,
        page.path,
        page.title,
        body,
        page.kind,
        page.status,
        typeof parsed.data.source_type === "string" ? parsed.data.source_type : "",
        typeof parsed.data.source_class === "string" ? parsed.data.source_class : "",
        inferredMetadata.authorityLayer,
        inferredMetadata.legalStatus,
        inferredMetadata.documentRole,
        typeof parsed.data.jurisdiction === "string" ? parsed.data.jurisdiction : "",
        typeof parsed.data.region === "string" ? parsed.data.region : "",
        standardCode,
        standardIdentity,
        standardCode ? normalizeStandardCode(standardCode) : (firstStandard?.normalized ?? ""),
        firstStandard?.family ?? "",
        firstStandard?.number ?? "",
        firstStandard?.year ?? "",
        pollutants.join("|"),
        evidenceRole,
        reportingPeriod,
        evidencePeriod,
        visibility,
        tenantId,
        sourceScope,
        searchTerms,
        JSON.stringify(page.projectIds),
        page.projectIds.map((projectId) => `|${projectId}|`).join("")
      );
      if (options.chunking?.enabled !== false) {
        for (const chunk of buildSearchChunks({
          pageId: page.id,
          title: page.title,
          body,
          standardCode,
          pollutants,
          maxChars: options.chunking?.maxChars,
          overlapChars: options.chunking?.overlapChars
        })) {
          insertChunk.run(chunk.chunkId, page.id, chunk.ordinal, chunk.heading, chunk.kind, chunk.location, chunk.text, chunk.searchTerms);
        }
      }
      const factBody = rawSourceText || stripGeneratedSourceSections(parsed.content);
      if (
        shouldExtractEnvAirFacts({ kind: page.kind, title: page.title, body: factBody, standardCode, standardRefCount: standards.length })
      ) {
        for (const fact of extractEnvAirStructuredFacts({
          body: factBody,
          standardRefs: standards,
          standardCode,
          sourceId: primarySourceId
        })) {
          insertFact.run(
            `${page.id}:${fact.id}`,
            page.id,
            fact.ordinal,
            fact.stableId,
            JSON.stringify(fact.legacyIds ?? []),
            fact.type,
            fact.tableName ?? "",
            fact.clauseNo ?? "",
            fact.tableNo ?? "",
            fact.formulaNo ?? "",
            fact.sourceSection ?? "",
            fact.subject ?? "",
            fact.predicate ?? "",
            fact.objectValue ?? "",
            JSON.stringify(fact.qualifiers ?? {}),
            fact.provenance ?? "",
            fact.standardCode ? standardIdentityKey(fact.standardCode) : standardIdentity,
            inferEvidenceRole(inferredMetadata),
            inferredMetadata.authorityLayer,
            inferredMetadata.documentRole,
            inferredMetadata.legalStatus,
            reportingPeriod,
            evidencePeriod,
            fact.pollutant ?? "",
            fact.metric ?? "",
            fact.averagingPeriod ?? "",
            fact.value ?? "",
            fact.unit ?? "",
            fact.rawText,
            fact.searchText
          );
        }
      }
    }

    db.exec("INSERT INTO page_search (rowid, title, body, search_terms) SELECT rowid, title, body, search_terms FROM pages;");
    db.exec("INSERT INTO chunk_search (rowid, text, search_terms) SELECT rowid, text, search_terms FROM chunks;");
    db.exec("INSERT INTO fact_search (rowid, raw_text, search_terms) SELECT rowid, raw_text, search_terms FROM facts;");
    db.exec("COMMIT;");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("PRAGMA journal_mode = DELETE;");
  } catch (error) {
    db.exec("ROLLBACK;");
    db.close();
    throw error;
  }
  db.close();
}

/**
 * Merge FTS and semantic results using reciprocal rank fusion (RRF).
 * k=60 is the standard constant from the original RRF paper.
 */
export function mergeSearchResults(
  ftsResults: SearchResult[],
  semanticHits: Array<{ pageId: string; path: string; title: string; kind: string; status: string; score: number }>,
  limit: number
): SearchResult[] {
  const k = 60;
  const scores = new Map<string, number>();
  const resultMap = new Map<string, SearchResult>();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    scores.set(r.pageId, (scores.get(r.pageId) ?? 0) + 1 / (k + i + 1));
    resultMap.set(r.pageId, r);
  }

  for (let i = 0; i < semanticHits.length; i++) {
    const hit = semanticHits[i];
    scores.set(hit.pageId, (scores.get(hit.pageId) ?? 0) + 1 / (k + i + 1));
    if (!resultMap.has(hit.pageId)) {
      resultMap.set(hit.pageId, {
        pageId: hit.pageId,
        path: hit.path,
        title: hit.title,
        snippet: "",
        rank: -hit.score,
        kind: hit.kind as SearchResult["kind"],
        status: hit.status as SearchResult["status"],
        projectIds: [],
        sourceType: undefined,
        sourceClass: undefined,
        retrievalStage: "semantic"
      });
    }
  }

  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([pageId, rrfScore]) => {
      const result = resultMap.get(pageId)!;
      return { ...result, rank: -rrfScore };
    });
}

export function searchPages(dbPath: string, query: string, limitOrOptions: number | SearchQueryOptions = 5): SearchResult[] {
  const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions;
  const domainPlan = buildDomainQueryPlan(query, options.domainProfile);
  const userQueryText = domainPlan.normalizedQuery;
  const expandedQuery = [
    domainPlan.normalizedQuery,
    ...domainPlan.expandedTerms,
    ...domainPlan.pinnedStandards,
    ...domainPlan.standardClusters
  ].join(" ");
  const normalizedQuery = normalizedStandardQuery(expandedQuery);
  const ftsQuery = toFtsQuery(normalizedQuery);
  const likeTerms = searchLikeTerms(normalizedQuery);
  const aliasTerms = sourceAliasQueryTerms(normalizedQuery);
  const identityTerms = sourceIdentityQueryTerms(domainPlan);
  if (!ftsQuery && likeTerms.length === 0 && identityTerms.length === 0) {
    return [];
  }
  const currentBasisIntent =
    domainPlan.currentBasisIntent ||
    options.requireCurrentBasis === true ||
    options.intent === "current_basis" ||
    options.intent === "report_writing";
  const exactStandards = standardRefsForExactRetrieval(domainPlan);
  const explicitStandard = exactStandards[0];
  const hasUserExplicitStandard = domainPlan.standardRefs.length > 0;
  const hasExactStandards = exactStandards.length > 0;
  const explicitStandardCompact = explicitStandard?.compact ?? "";
  const explicitStandardFamily = explicitStandard?.family ?? "";
  const explicitStandardNumber = explicitStandard?.number ?? "";
  const explicitStandardYear = explicitStandard?.year ?? "";
  const ambientLimitIntent =
    domainPlan.rankingSignals.includes("ambient_air_quality_limit_question") ||
    (/(PM2\.5|PM10|O3|SO2|NO2|CO|颗粒物|臭氧|二氧化硫|二氧化氮|一氧化碳)/iu.test(normalizedQuery) &&
      /(限值|标准值|浓度限值|一级|二级|年平均|日平均|24\s*小时|1\s*小时|8\s*小时)/u.test(normalizedQuery));
  const assessmentValidityIntent = domainPlan.rankingSignals.includes("ambient_air_assessment_validity_question");
  const aqiIntent =
    domainPlan.rankingSignals.includes("aqi_reporting_question") || domainPlan.rankingSignals.includes("ambient_aqi_list_question");
  const amendmentIntent = /修改单|amendment/i.test(normalizedQuery);
  const qaQcIntent =
    domainPlan.standardClusters.includes("ambient_auto_monitoring_operation_qaqc") ||
    domainPlan.rankingSignals.includes("qaqc_question") ||
    /(质控|质量控制|质量保证|有效数据|负值|零点|量程|转换炉效率|平行性|比对)/u.test(normalizedQuery);
  const statisticsIntent = domainPlan.standardClusters.includes("ambient_statistics_reporting") || options.intent === "statistics";
  const listCompleteIntent =
    domainPlan.rankingSignals.includes("list_complete_question") ||
    /(包括哪些|有哪些|完整清单|全部项目|所有项目|测试项目|检测项目|检查项目|验收项目|质控项目|质量控制项目|性能指标|评价指标|监测项目|清单|要点|步骤)/u.test(
      normalizedQuery
    );
  const rankingChunkTerms = uniqueCompact([
    ...Object.keys(domainPlan.chunkTermBoosts ?? {}),
    ...domainPlan.expandedTerms,
    ...(listCompleteIntent
      ? [
          "检测项目",
          "测试项目",
          "性能指标",
          "指标要求",
          "验收项目",
          "质控项目",
          "检查项目",
          "评价指标",
          "监测项目",
          "表 1",
          "表1",
          "表 2",
          "表2",
          "表 3",
          "表3",
          "清单",
          "项目",
          "示值误差",
          "参比方法",
          "有效数据率"
        ]
      : []),
    ...(qaQcIntent ? ["质控", "质量控制", "有效数据", "负值", "零点", "量程", "转换炉效率", "平行性", "比对测试"] : []),
    ...(statisticsIntent ? ["公报", "月报", "年报", "统计", "城市", "评价城市", "统计期"] : [])
  ]);
  const DatabaseSync = getDatabaseSync();
  const db = withSuppressedSqliteExperimentalWarning(() => new DatabaseSync(sqliteImmutableReadOnlyUri(dbPath)));
  const limit = options.limit ?? 5;
  const candidateLimit = listCompleteIntent ? Math.max(limit * 8, limit + 30) : Math.max(limit * 3, limit + 5);
  const seen = new Set<string>();
  const seenPageIds = new Set<string>();
  const chunkRowsByPage = new Map<string, number>();
  const rows: Array<Record<string, unknown>> = [];

  function selectedColumns(rankExpression: string, snippetExpression: string, stage: SearchResult["retrievalStage"]): string {
    return `
      SELECT
        pages.id AS pageId,
        pages.path AS path,
        pages.title AS title,
        pages.kind AS kind,
        pages.status AS status,
        pages.source_type AS sourceType,
        pages.source_class AS sourceClass,
        pages.authority_layer AS authorityLayer,
        pages.legal_status AS legalStatus,
        pages.document_role AS documentRole,
        pages.jurisdiction AS jurisdiction,
        pages.region AS region,
        pages.standard_code AS standardCode,
        pages.standard_identity AS standardIdentity,
        pages.evidence_role AS evidenceRole,
        pages.reporting_period AS reportingPeriod,
        pages.evidence_period AS evidencePeriod,
        pages.visibility AS visibility,
        pages.tenant_id AS tenantId,
        pages.source_scope AS sourceScope,
        pages.pollutants AS pollutants,
        pages.project_ids AS projectIds,
        NULL AS chunkId,
        NULL AS chunkOrdinal,
        NULL AS chunkHeading,
        NULL AS chunkKind,
        NULL AS chunkLocation,
        NULL AS factId,
        NULL AS factStableId,
        NULL AS factOrdinal,
        NULL AS factLegacyIds,
        NULL AS factType,
        NULL AS factTable,
        NULL AS factRawText,
        NULL AS factClauseNo,
        NULL AS factTableNo,
        NULL AS factFormulaNo,
        NULL AS factSourceSection,
        NULL AS factSubject,
        NULL AS factPredicate,
        NULL AS factObjectValue,
        NULL AS factQualifiers,
        NULL AS factProvenance,
        '${stage}' AS retrievalStage,
        ${snippetExpression} AS snippet,
        ${rankExpression} AS rank
    `;
  }

  function selectedChunkColumns(rankExpression: string, snippetExpression: string): string {
    return `
      SELECT
        pages.id AS pageId,
        pages.path AS path,
        pages.title AS title,
        pages.kind AS kind,
        pages.status AS status,
        pages.source_type AS sourceType,
        pages.source_class AS sourceClass,
        pages.authority_layer AS authorityLayer,
        pages.legal_status AS legalStatus,
        pages.document_role AS documentRole,
        pages.jurisdiction AS jurisdiction,
        pages.region AS region,
        pages.standard_code AS standardCode,
        pages.standard_identity AS standardIdentity,
        pages.evidence_role AS evidenceRole,
        pages.reporting_period AS reportingPeriod,
        pages.evidence_period AS evidencePeriod,
        pages.visibility AS visibility,
        pages.tenant_id AS tenantId,
        pages.source_scope AS sourceScope,
        pages.pollutants AS pollutants,
        pages.project_ids AS projectIds,
        chunks.id AS chunkId,
        chunks.ordinal AS chunkOrdinal,
        chunks.heading AS chunkHeading,
        chunks.kind AS chunkKind,
        chunks.location AS chunkLocation,
        NULL AS factId,
        NULL AS factStableId,
        NULL AS factOrdinal,
        NULL AS factLegacyIds,
        NULL AS factType,
        NULL AS factTable,
        NULL AS factRawText,
        NULL AS factClauseNo,
        NULL AS factTableNo,
        NULL AS factFormulaNo,
        NULL AS factSourceSection,
        NULL AS factSubject,
        NULL AS factPredicate,
        NULL AS factObjectValue,
        NULL AS factQualifiers,
        NULL AS factProvenance,
        'chunk_fts' AS retrievalStage,
        ${snippetExpression} AS snippet,
        ${rankExpression} AS rank
    `;
  }

  function selectedFactColumns(rankExpression: string, snippetExpression: string): string {
    return `
      SELECT
        pages.id AS pageId,
        pages.path AS path,
        pages.title AS title,
        pages.kind AS kind,
        pages.status AS status,
        pages.source_type AS sourceType,
        pages.source_class AS sourceClass,
        pages.authority_layer AS authorityLayer,
        pages.legal_status AS legalStatus,
        pages.document_role AS documentRole,
        pages.jurisdiction AS jurisdiction,
        pages.region AS region,
        pages.standard_code AS standardCode,
        pages.standard_identity AS standardIdentity,
        facts.evidence_role AS evidenceRole,
        facts.reporting_period AS reportingPeriod,
        facts.evidence_period AS evidencePeriod,
        pages.visibility AS visibility,
        pages.tenant_id AS tenantId,
        pages.source_scope AS sourceScope,
        pages.pollutants AS pollutants,
        pages.project_ids AS projectIds,
        facts.id AS chunkId,
        NULL AS chunkOrdinal,
        facts.table_name AS chunkHeading,
        CASE WHEN facts.fact_type = 'formula' THEN 'formula' ELSE 'table' END AS chunkKind,
        facts.table_name AS chunkLocation,
        facts.id AS factId,
        facts.fact_stable_id AS factStableId,
        facts.fact_ordinal AS factOrdinal,
        facts.fact_legacy_ids AS factLegacyIds,
        facts.fact_type AS factType,
        facts.table_name AS factTable,
        facts.raw_text AS factRawText,
        facts.clause_no AS factClauseNo,
        facts.table_no AS factTableNo,
        facts.formula_no AS factFormulaNo,
        facts.source_section AS factSourceSection,
        facts.subject AS factSubject,
        facts.predicate AS factPredicate,
        facts.object_value AS factObjectValue,
        facts.qualifiers_json AS factQualifiers,
        facts.provenance AS factProvenance,
        'structured_fact' AS retrievalStage,
        ${snippetExpression} AS snippet,
        ${rankExpression} AS rank
    `;
  }

  function addScalarOrListFilter(
    clauses: string[],
    params: Array<number | string>,
    column: string,
    value: string | string[] | undefined
  ): void {
    const values = (Array.isArray(value) ? value : value ? [value] : []).filter((item) => item && item !== "all");
    if (!values.length) {
      return;
    }
    if (values.length === 1) {
      clauses.push(`${column} = ?`);
      params.push(values[0]);
      return;
    }
    clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  }

  function buildFilterClauses(
    params: Array<number | string>,
    mode: { relaxAuthority?: boolean; includeDrafts?: boolean; includeSuperseded?: boolean } = {}
  ): string[] {
    const clauses: string[] = [];
    addScalarOrListFilter(clauses, params, "pages.kind", options.kind);
    addScalarOrListFilter(clauses, params, "pages.status", options.status);
    if (options.project && options.project !== "all" && options.scope !== "mixed_public_private") {
      if (options.project === "unassigned") {
        clauses.push("pages.project_key = ''");
      } else {
        clauses.push("pages.project_key LIKE ?");
        params.push(`%|${options.project}|%`);
      }
    }
    addScalarOrListFilter(clauses, params, "pages.source_type", options.sourceType);
    addScalarOrListFilter(clauses, params, "pages.source_class", options.sourceClass);
    if (!mode.relaxAuthority) {
      addScalarOrListFilter(clauses, params, "pages.authority_layer", options.authorityLayer);
    }
    addScalarOrListFilter(clauses, params, "pages.legal_status", options.legalStatus);
    if (!mode.relaxAuthority) {
      addScalarOrListFilter(clauses, params, "pages.document_role", options.documentRole);
    }
    addScalarOrListFilter(clauses, params, "pages.jurisdiction", options.jurisdiction);
    if (options.region && options.region !== "all") {
      clauses.push("pages.region LIKE ?");
      params.push(`%${options.region}%`);
    }
    if (options.scope === "mixed_public_private") {
      const mixedClauses = ["pages.visibility = 'public'"];
      if (options.tenantId) {
        mixedClauses.push("pages.tenant_id = ?");
        params.push(options.tenantId);
      }
      if (options.project && options.project !== "all") {
        mixedClauses.push("pages.project_key LIKE ?");
        params.push(`%|${options.project}|%`);
      }
      clauses.push(`(${mixedClauses.join(" OR ")})`);
    } else if (options.scope === "tenant_only" && !options.tenantId) {
      clauses.push("1 = 0");
    } else if (options.scope === "project_only" && !options.project) {
      clauses.push("1 = 0");
    } else if (options.visibility) {
      clauses.push("pages.visibility = ?");
      params.push(options.visibility);
    }
    if (options.tenantId && options.scope !== "mixed_public_private") {
      clauses.push("pages.tenant_id = ?");
      params.push(options.tenantId);
    }
    if (options.pollutant && options.pollutant !== "all") {
      clauses.push("LOWER(pages.pollutants) LIKE ?");
      params.push(`%${options.pollutant.toLowerCase()}%`);
    }
    if (options.includeDrafts !== true && mode.includeDrafts !== true) {
      clauses.push("(pages.legal_status <> 'draft_consultation' OR pages.legal_status = '')");
    }
    if (options.includeSuperseded !== true && mode.includeSuperseded !== true) {
      clauses.push("(pages.legal_status <> 'superseded' OR pages.legal_status = '')");
    }
    return clauses;
  }

  function standardCodeExpr(column: string): string {
    return `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${column}, ' ', ''), '-', ''), '/', ''), '—', ''), '–', ''), '―', ''), '：', ''))`;
  }

  function boostCase(column: "pages.document_role" | "pages.evidence_role", boosts: Record<string, number> | undefined): string {
    const entries = Object.entries(boosts ?? {})
      .filter(([key, value]) => /^[a-z_]+$/i.test(key) && Number.isFinite(Number(value)) && Number(value) > 0)
      .slice(0, 12);
    if (!entries.length) {
      return "WHEN 1=0 THEN 0";
    }
    return entries
      .map(([key, value]) => `WHEN ${column} = '${key.replace(/'/g, "''")}' THEN ${Math.max(0, Math.min(10, Number(value)))}`)
      .join(" ");
  }

  function orderBy(): string {
    return `
      ORDER BY
        CASE
          WHEN ? <> '' AND (${standardCodeExpr("pages.standard_code_normalized")} = ? OR ${standardCodeExpr("pages.standard_code")} = ?) THEN 0
          WHEN ? <> '' AND pages.standard_family = ? AND pages.standard_number = ? AND (? = '' OR pages.standard_year = ?) THEN 1
          WHEN ? <> '' AND pages.standard_family = ? AND pages.standard_number = ? THEN 2
          WHEN ? <> '' THEN 3
          ELSE 0
        END,
        CASE
          WHEN ${assessmentValidityIntent ? 1 : 0} = 1 AND pages.evidence_role = 'current_authority' AND pages.document_role = 'standard' THEN 0
          WHEN ${assessmentValidityIntent ? 1 : 0} = 1 AND pages.authority_layer IN ('core', 'method', 'local') THEN 1
          WHEN ${assessmentValidityIntent ? 1 : 0} = 1 THEN 2
          ELSE 0
        END,
        CASE
          WHEN ${ambientLimitIntent ? 1 : 0} = 1 AND pages.evidence_role = 'current_authority' AND pages.document_role = 'standard' THEN 0
          WHEN ${ambientLimitIntent ? 1 : 0} = 1 AND pages.authority_layer IN ('core', 'method', 'local') THEN 1
          WHEN ${ambientLimitIntent ? 1 : 0} = 1 THEN 2
          ELSE 0
        END,
        CASE
          WHEN ${amendmentIntent ? 1 : 0} = 1 AND (pages.document_role = 'amendment' OR pages.title LIKE '%修改单%' OR pages.standard_code LIKE '%修改单%') THEN 0
          WHEN ${amendmentIntent ? 1 : 0} = 1 THEN 1
          ELSE 0
        END,
        CASE
          WHEN ${currentBasisIntent ? 1 : 0} = 1 AND pages.legal_status = 'current_effective' THEN 0
          WHEN ${currentBasisIntent ? 1 : 0} = 1 AND pages.authority_layer IN ('core', 'method', 'local') THEN 1
          WHEN ${currentBasisIntent ? 1 : 0} = 1 THEN 2
          ELSE 0
        END,
        CASE ${boostCase("pages.evidence_role", domainPlan.evidenceRoleBoosts)} ELSE 0 END * -1,
        CASE ${boostCase("pages.document_role", domainPlan.documentRoleBoosts)} ELSE 0 END * -1,
        CASE
          WHEN ${statisticsIntent ? 1 : 0} = 1 AND pages.document_role IN ('statistics', 'whitepaper', 'official_explanation') THEN -4
          WHEN ${qaQcIntent ? 1 : 0} = 1 AND pages.document_role IN ('monitoring_method', 'qa_qc', 'standard') THEN -4
          ELSE 0
        END,
        CASE pages.status
          WHEN 'active' THEN 0
          WHEN 'draft' THEN 1
          WHEN 'candidate' THEN 2
          ELSE 3
        END,
        CASE pages.kind
          WHEN 'source' THEN 0
          WHEN 'module' THEN 1
          WHEN 'output' THEN 2
          WHEN 'insight' THEN 3
          WHEN 'graph_report' THEN 4
          WHEN 'community_summary' THEN 5
          WHEN 'concept' THEN 6
          WHEN 'entity' THEN 7
          ELSE 8
        END,
        rank
    `;
  }

  function appendOrderParams(params: Array<number | string>): void {
    params.push(
      explicitStandardCompact,
      explicitStandardCompact,
      explicitStandardCompact,
      explicitStandardFamily,
      explicitStandardFamily,
      explicitStandardNumber,
      explicitStandardYear,
      explicitStandardYear,
      explicitStandardFamily,
      explicitStandardFamily,
      explicitStandardNumber,
      explicitStandardCompact
    );
  }

  function appendRows(
    nextRows: Array<Record<string, unknown>>,
    options: { allowOverflowStages?: Set<string>; maxAdded?: number } = {}
  ): void {
    let added = 0;
    for (const row of nextRows) {
      const pageId = String(row.pageId ?? "");
      const stage = String(row.retrievalStage ?? "");
      const allowOverflow = options.allowOverflowStages?.has(stage) ?? false;
      if (options.maxAdded && added >= options.maxAdded) {
        break;
      }
      if (!allowOverflow && rows.length >= candidateLimit) {
        break;
      }
      if (stage === "standard_exact" && pageId && seenPageIds.has(pageId)) {
        const existing = rows.find(
          (item) => String(item.pageId ?? "") === pageId && !["structured_fact", "chunk_fts"].includes(String(item.retrievalStage ?? ""))
        );
        if (existing) {
          Object.assign(existing, row);
        }
        continue;
      }
      if (stage === "chunk_fts") {
        const current = chunkRowsByPage.get(pageId) ?? 0;
        const chunkBudget = listCompleteIntent ? 5 : qaQcIntent || statisticsIntent || domainPlan.pinnedStandards.length > 0 ? 3 : 1;
        if (current >= chunkBudget) {
          continue;
        }
        chunkRowsByPage.set(pageId, current + 1);
      }
      if (listCompleteIntent && stage === "structured_fact") {
        const factText = String(row.factRawText ?? "");
        const itemHits = listCompletenessItemHitCount(factText);
        if (factText.length < 240 && itemHits < 3) {
          continue;
        }
      }
      const rowKey =
        stage === "structured_fact"
          ? `${stage}:${String(row.factId ?? row.chunkId ?? pageId)}`
          : stage === "chunk_fts"
            ? `${stage}:${String(row.chunkId ?? pageId)}`
            : pageId;
      if (!pageId || seen.has(rowKey)) {
        continue;
      }
      seen.add(rowKey);
      if (stage !== "structured_fact") {
        seenPageIds.add(pageId);
      }
      rows.push(row);
      added += 1;
      if (!allowOverflow && rows.length >= candidateLimit) {
        break;
      }
    }
  }

  function crossStagePriority(row: Record<string, unknown>): number {
    const title = String(row.title ?? "");
    const standardCode = String(row.standardCode ?? "");
    const standardIdentity = String(row.standardIdentity ?? "");
    const documentRole = String(row.documentRole ?? "");
    const evidenceRole = String(row.evidenceRole ?? "");
    const authorityLayer = String(row.authorityLayer ?? "");
    const retrievalStage = String(row.retrievalStage ?? "");
    const chunkKind = String(row.chunkKind ?? "");
    if (/(重污染天气|重污染过程|污染过程|应急预警|应急响应|应急减排|绩效分级|秋冬季攻坚|预警材料)/u.test(userQueryText)) {
      const heavySource = /(重污染天气|重污染过程|应急预警|应急响应|应急减排|绩效分级|秋冬季攻坚|预警材料)/u.test(
        `${standardCode} ${title}`
      );
      if (heavySource && ["policy", "technical_guide", "regulation", "official_explanation"].includes(documentRole)) {
        return -138;
      }
      if (["monitoring_method", "qa_qc", "standard"].includes(documentRole) && !heavySource) {
        return 35;
      }
    }
    if (
      /(在线监控|自动监控|污染源自动监控|在线设备|在线数据|数据异常|采样探头|CEMS|离线|现场|执法|处罚|违法|程序证据|风险提示|弄虚作假)/u.test(
        userQueryText
      ) &&
      /(执法现场|现场检查|检查清单|检查事项|现场|处罚|违法|直接认定|直接作为|程序证据|风险提示|采样探头|截图|证据|离线|数据异常|弄虚作假)/u.test(
        userQueryText
      ) &&
      !/(管理职责|职责主体|管理办法|主体责任)/u.test(userQueryText)
    ) {
      const inspectionSource = /19号令|第19号|现场监督检查办法/u.test(`${standardCode} ${title}`);
      const managementSource = /28号令|第28号|总局令第28号|污染源自动监控管理办法/u.test(`${standardCode} ${title}`);
      if (inspectionSource) {
        return -145;
      }
      if (managementSource) {
        return -138;
      }
    }
    if (
      /(在线监控|自动监控|污染源自动监控|在线设备|自动监控设备|企业自行监测|运维单位|排污单位|运维责任)/u.test(userQueryText) &&
      /(管理职责|职责主体|管理办法|主体责任|故障|报告|停运|拆除|备案|联网|设备更换|频次|承担管理责任|管理责任|维护到位|运维责任)/u.test(
        userQueryText
      )
    ) {
      const managementSource = /28号令|第28号|总局令第28号|污染源自动监控管理办法/u.test(`${standardCode} ${title}`);
      const inspectionSource = /19号令|第19号|现场监督检查办法/u.test(`${standardCode} ${title}`);
      if (managementSource) {
        return -145;
      }
      if (inspectionSource) {
        return -138;
      }
    }
    if (retrievalStage === "source_alias") {
      return -110;
    }
    if (aqiIntent && /HJ\s*633|HJ633/u.test(`${standardIdentity} ${standardCode} ${title}`)) {
      return -140;
    }
    if (aqiIntent && /GB\s*3095|GB3095/u.test(`${standardIdentity} ${standardCode} ${title}`)) {
      return -35;
    }
    if (ambientLimitIntent && /GB\s*3095|GB3095|环境空气质量标准/u.test(`${standardIdentity} ${standardCode} ${title}`)) {
      return retrievalStage === "structured_fact" ? -124 : chunkKind === "table" ? -136 : -132;
    }
    if (hasExactStandards && retrievalStage === "standard_exact") {
      if (amendmentIntent && (documentRole === "amendment" || title.includes("修改单") || standardCode.includes("修改单"))) {
        return -120;
      }
      const formalStandardRole = [
        "standard",
        "monitoring_method",
        "qa_qc",
        "technical_regulation",
        "regulation",
        "law",
        "policy",
        "emission_standard"
      ].includes(documentRole);
      const explanatoryReferenceRole = [
        "technical_guide",
        "official_explanation",
        "whitepaper",
        "research_literature",
        "statistics",
        "compilation_explanation",
        "draft"
      ].includes(documentRole);
      const versionedStandard = extractStandardReferences(`${standardCode}\n${title}`).some((ref) => ref.year);
      if (formalStandardRole && versionedStandard) {
        return -128;
      }
      if (formalStandardRole) {
        return -118;
      }
      if (explanatoryReferenceRole) {
        return -84;
      }
      return -100;
    }
    if (ambientLimitIntent && retrievalStage === "structured_fact") {
      const factText = [row.factRawText, row.factSubject, row.factObjectValue, row.pollutants, row.averagingPeriod, row.value, row.unit]
        .filter(Boolean)
        .join(" ");
      const ambientQualityStandardSource = /GB\s*3095|GB3095|环境空气质量标准/u.test([standardCode, title].join(" "));
      const usefulLimitFact =
        includesFocusTerm(factText, pollutantFocusTermsForQuery(normalizedQuery)) &&
        requiredAmbientPeriodGroups(normalizedQuery).every((group) => includesFocusTerm(factText, group)) &&
        /[0-9]/.test(factText) &&
        /(一级|二级|限值|μg|µg|ug|mg|年平均|日平均|24小时平均|1小时平均|日最大8小时平均)/iu.test(factText);
      return usefulLimitFact && ambientQualityStandardSource ? -130 : usefulLimitFact ? -50 : -65;
    }
    if ((assessmentValidityIntent || retrievalStage === "structured_fact") && retrievalStage === "structured_fact") {
      if (listCompleteIntent) {
        const factText = String(row.factRawText ?? "");
        const itemHits = listCompletenessItemHitCount(factText);
        return factText.length > 240 && itemHits >= 3 ? -112 : -55;
      }
      return -95;
    }
    if (
      listCompleteIntent &&
      retrievalStage === "chunk_fts" &&
      (String(row.chunkKind ?? "") === "table" || String(row.chunkKind ?? "") === "formula") &&
      (authorityLayer === "core" || authorityLayer === "method" || evidenceRole === "method" || evidenceRole === "current_authority")
    ) {
      return -108;
    }
    if (assessmentValidityIntent && (evidenceRole === "current_authority" || authorityLayer === "core" || authorityLayer === "method")) {
      if (documentRole === "standard" || retrievalStage === "structured_fact") {
        return -92;
      }
      return -72;
    }
    if (aqiIntent && /HJ\s*633|HJ633/u.test(`${standardIdentity} ${standardCode} ${title}`)) {
      return -122;
    }
    if (aqiIntent && /GB\s*3095|GB3095/u.test(`${standardIdentity} ${standardCode} ${title}`)) {
      return -35;
    }
    if (ambientLimitIntent && (evidenceRole === "current_authority" || authorityLayer === "core" || authorityLayer === "method")) {
      if (documentRole === "standard" || retrievalStage === "structured_fact") {
        return -90;
      }
      return -70;
    }
    if (amendmentIntent && (documentRole === "amendment" || title.includes("修改单") || standardCode.includes("修改单"))) {
      return -80;
    }
    if (currentBasisIntent) {
      if (evidenceRole === "current_authority" || evidenceRole === "method" || evidenceRole === "local_adaptation") {
        return -45;
      }
      if (authorityLayer === "evidence" || evidenceRole === "statistics" || evidenceRole === "research" || evidenceRole === "background") {
        return 55;
      }
    }
    return 0;
  }

  function hydrateRowsWithDomainChunks(): void {
    const targetRows = rows.filter((row) => {
      if (String(row.retrievalStage ?? "") === "structured_fact") {
        return false;
      }
      const title = String(row.title ?? "");
      const standardCode = String(row.standardCode ?? "");
      const snippet = String(row.snippet ?? "");
      const isAmbientLimitTarget =
        ambientLimitIntent &&
        (String(row.evidenceRole ?? "") === "current_authority" || String(row.authorityLayer ?? "") === "core" || standardCode.length > 0);
      const isAssessmentValidityTarget =
        assessmentValidityIntent &&
        (String(row.evidenceRole ?? "") === "current_authority" ||
          String(row.authorityLayer ?? "") === "core" ||
          String(row.authorityLayer ?? "") === "method" ||
          standardCode.length > 0);
      const isAmendmentTarget = amendmentIntent && (title.includes("修改单") || standardCode.includes("修改单"));
      const isRankingTarget =
        rankingChunkTerms.length > 0 &&
        (domainPlan.pinnedStandards.length > 0 ||
          String(row.authorityLayer ?? "") === "core" ||
          String(row.authorityLayer ?? "") === "method" ||
          qaQcIntent ||
          statisticsIntent);
      if (!isAmbientLimitTarget && !isAssessmentValidityTarget && !isAmendmentTarget && !isRankingTarget) {
        return false;
      }
      if (!row.chunkId) {
        return true;
      }
      if (listCompleteIntent) {
        return true;
      }
      if (isAmbientLimitTarget) {
        return !hasUsefulAmbientLimitSnippet(snippet, normalizedQuery);
      }
      if (isAssessmentValidityTarget) {
        return !/(数据有效性|有效数据|有效监测数据|评价项目|评价方法|达标评价)/u.test(snippet);
      }
      return isAmendmentTarget && !hasUsefulAmendmentSnippet(snippet);
    });
    if (!targetRows.length) {
      return;
    }
    const ambientTerms = pollutantFocusTermsForQuery(normalizedQuery);
    const assessmentValidityTerms = uniqueCompact([
      ...domainPlan.expandedTerms,
      "数据有效性",
      "有效数据",
      "有效监测数据",
      "评价项目",
      "评价方法"
    ]);
    const amendmentTerms = uniqueCompact([...domainPlan.expandedTerms, "修改单", "修订", "替换"]);
    for (const row of targetRows) {
      const terms = assessmentValidityIntent
        ? assessmentValidityTerms
        : ambientLimitIntent
          ? ambientTerms
          : amendmentIntent
            ? amendmentTerms
            : rankingChunkTerms;
      const statement = db.prepare(`
        SELECT id, ordinal, heading, kind, location, text
        FROM chunks
        WHERE page_id = ?
        ORDER BY ordinal
        LIMIT 120
      `);
      const candidates = statement.all(String(row.pageId ?? "")) as Array<Record<string, unknown>>;
      const scored = candidates
        .map((chunk) => {
          const text = String(chunk.text ?? "");
          const kind = String(chunk.kind ?? "");
          const matchScore = terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
          const domainScore = assessmentValidityIntent
            ? (/(数据有效性|有效数据|有效监测数据)/u.test(text) ? 8 : 0) + (/(评价项目|评价方法|达标评价|年评价)/u.test(text) ? 5 : 0)
            : ambientLimitIntent
              ? (includesFocusTerm(text, ambientTerms) ? 6 : 0) +
                (/(年平均|日平均|1小时平均|日最大8小时平均)/.test(text) ? 4 : 0) +
                (text.includes("浓度限值") || text.includes("一级") || text.includes("二级") ? 3 : 0)
              : amendmentIntent
                ? (text.includes("修改单") ? 5 : 0) +
                  amendmentTerms.reduce((score, term) => score + (text.includes(term) ? 2 : 0), 0) +
                  (hasUsefulAmendmentSnippet(sourceExcerptBody(text)) ? 8 : 0)
                : rankingChunkTerms.reduce((score, term) => score + (text.includes(term) ? 2 : 0), 0) +
                  (listCompleteIntent &&
                  /(表\s*[0-9A-Z一二三四五六七八九十]|检测项目|测试项目|性能指标|指标要求|验收项目|质控项目|检查项目|评价指标|监测项目)/u.test(
                    text
                  )
                    ? 12
                    : 0) +
                  (listCompleteIntent &&
                  /(示值误差|影响测试|流量测试|参比方法比对|有效数据率|平行性|检出限|漂移|校准|比对|准确度|精密度)/u.test(text)
                    ? 8
                    : 0) +
                  (qaQcIntent && /(质控|质量控制|有效数据|负值|零点|量程|转换炉效率|平行性)/u.test(text) ? 8 : 0) +
                  (statisticsIntent && /(公报|月报|年报|统计|城市|评价城市)/u.test(text) ? 6 : 0);
          const kindScore = kind === "table" || kind === "formula" ? 2 : kind === "paragraph" ? 1 : kind === "heading" ? -1 : 0;
          return { chunk, score: domainScore + matchScore + kindScore, kindScore };
        })
        .filter((item) => item.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.kindScore - left.kindScore ||
            Number(left.chunk.ordinal ?? 0) - Number(right.chunk.ordinal ?? 0)
        );
      const chunk = scored[0]?.chunk;
      if (!chunk) {
        continue;
      }
      row.chunkId = chunk.id;
      row.chunkOrdinal = chunk.ordinal;
      row.chunkHeading = chunk.heading;
      row.chunkKind = chunk.kind;
      row.chunkLocation = chunk.location;
      row.snippet = focusedChunkSnippet(
        String(chunk.text ?? ""),
        assessmentValidityIntent
          ? assessmentValidityTerms
          : ambientLimitIntent
            ? ambientTerms
            : amendmentIntent
              ? ["将", "修改为", "结果表示", "按式", "式中"]
              : rankingChunkTerms,
        listCompleteIntent ? 5000 : 1800,
        { preserveTableRows: listCompleteIntent }
      );
      row.retrievalStage = row.retrievalStage ?? "chunk_fts";
    }
  }

  try {
    if (identityTerms.length) {
      const rankParams: Array<number | string> = [];
      const filterParams: Array<number | string> = [];
      const whereParams: Array<number | string> = [];
      const clauses = buildFilterClauses(filterParams, { relaxAuthority: true });
      if (!options.kind) {
        clauses.push("pages.kind IN ('source', 'module')");
      }
      const rankCases: string[] = [];
      const whereClauses: string[] = [];
      for (const [index, term] of identityTerms.entries()) {
        const pattern = `%${term.toLowerCase()}%`;
        const compactPattern = `%${compactAliasText(term)}%`;
        rankCases.push(
          "WHEN (LOWER(pages.title) LIKE ? OR LOWER(pages.search_terms) LIKE ? OR LOWER(REPLACE(pages.search_terms, ' ', '')) LIKE ? OR LOWER(pages.standard_code) LIKE ? OR LOWER(pages.body) LIKE ?) THEN ?"
        );
        rankParams.push(pattern, pattern, compactPattern, pattern, pattern, -40 + Math.min(index, 20));
        whereClauses.push(
          "(LOWER(pages.title) LIKE ? OR LOWER(pages.search_terms) LIKE ? OR LOWER(REPLACE(pages.search_terms, ' ', '')) LIKE ? OR LOWER(pages.standard_code) LIKE ? OR LOWER(pages.body) LIKE ?)"
        );
        whereParams.push(pattern, pattern, compactPattern, pattern, pattern);
      }
      clauses.push(`(${whereClauses.join(" OR ")})`);
      const params = [...rankParams, ...filterParams, ...whereParams];
      appendOrderParams(params);
      params.push(Math.min(Math.max(candidateLimit, identityTerms.length + 4), 24));
      const statement = db.prepare(`
        ${selectedColumns(`CASE ${rankCases.join(" ")} ELSE -8 END`, "substr(pages.body, 1, 420)", "source_alias")}
        FROM pages
        WHERE ${clauses.join(" AND ")}
        ${orderBy()}
        LIMIT ?
      `);
      appendRows(statement.all(...params) as Array<Record<string, unknown>>, {
        allowOverflowStages: new Set(["source_alias"]),
        maxAdded: Math.min(identityTerms.length + 8, 24)
      });
    }

    if (aliasTerms.length) {
      const params: Array<number | string> = [];
      const clauses = buildFilterClauses(params, { relaxAuthority: true });
      if (!options.kind) {
        clauses.push("pages.kind IN ('source', 'module')");
      }
      const aliasClauses: string[] = [];
      for (const term of aliasTerms) {
        const pattern = `%${term.toLowerCase()}%`;
        const compactPattern = `%${compactAliasText(term)}%`;
        aliasClauses.push(
          "(LOWER(pages.title) LIKE ? OR LOWER(pages.search_terms) LIKE ? OR LOWER(REPLACE(pages.search_terms, ' ', '')) LIKE ? OR LOWER(pages.standard_code) LIKE ?)"
        );
        params.push(pattern, pattern, compactPattern, pattern);
      }
      clauses.push(`(${aliasClauses.join(" OR ")})`);
      appendOrderParams(params);
      params.push(Math.min(candidateLimit, 10));
      const statement = db.prepare(`
        ${selectedColumns("-8", "substr(pages.body, 1, 420)", "source_alias")}
        FROM pages
        WHERE ${clauses.join(" AND ")}
        ${orderBy()}
        LIMIT ?
      `);
      appendRows(statement.all(...params) as Array<Record<string, unknown>>);
    }

    const defaultFactBoosts: Record<string, number> = assessmentValidityIntent
      ? { validity_rule: 5, limit_value: 2, formula: 1.5, technical_parameter: 1 }
      : { limit_value: 4, formula: 3, technical_parameter: 2 };
    if (qaQcIntent) {
      defaultFactBoosts.technical_parameter = Math.max(defaultFactBoosts.technical_parameter ?? 0, 5);
      defaultFactBoosts.validity_rule = Math.max(defaultFactBoosts.validity_rule ?? 0, 4);
      defaultFactBoosts.method_step = Math.max(defaultFactBoosts.method_step ?? 0, 3);
    }
    if (statisticsIntent) {
      defaultFactBoosts.status_rule = Math.max(defaultFactBoosts.status_rule ?? 0, 2);
      defaultFactBoosts.technical_parameter = Math.max(defaultFactBoosts.technical_parameter ?? 0, 2);
    }
    for (const [key, value] of Object.entries(domainPlan.factTypeBoosts ?? {})) {
      if (/^[a-z_]+$/i.test(key)) {
        defaultFactBoosts[key] = Math.max(defaultFactBoosts[key] ?? 0, Math.max(0, Math.min(10, Number(value))));
      }
    }
    const factBoostExpression = `bm25(fact_search) - CASE facts.fact_type ${Object.entries(defaultFactBoosts)
      .map(([key, value]) => `WHEN '${key.replace(/'/g, "''")}' THEN ${value}`)
      .join(" ")} ELSE 0 END`;
    if (rows.length < candidateLimit && aliasTerms.length) {
      const params: Array<number | string> = [];
      const clauses = buildFilterClauses(params, { relaxAuthority: true });
      if (!options.kind) {
        clauses.push("pages.kind IN ('source', 'module')");
      }
      const aliasClauses: string[] = [];
      for (const term of aliasTerms) {
        const pattern = `%${term.toLowerCase()}%`;
        const compactPattern = `%${compactAliasText(term)}%`;
        aliasClauses.push(
          "(LOWER(pages.title) LIKE ? OR LOWER(pages.search_terms) LIKE ? OR LOWER(REPLACE(pages.search_terms, ' ', '')) LIKE ? OR LOWER(pages.standard_code) LIKE ?)"
        );
        params.push(pattern, pattern, compactPattern, pattern);
      }
      clauses.push(`(${aliasClauses.join(" OR ")})`);
      appendOrderParams(params);
      params.push(Math.min(candidateLimit - rows.length, 10));
      const statement = db.prepare(`
        ${selectedColumns("-8", "substr(pages.body, 1, 420)", "source_alias")}
        FROM pages
        WHERE ${clauses.join(" AND ")}
        ${orderBy()}
        LIMIT ?
      `);
      appendRows(statement.all(...params) as Array<Record<string, unknown>>);
    }

    if (ambientLimitIntent && rows.length < candidateLimit && ftsQuery) {
      try {
        const params: Array<number | string> = [ftsQuery];
        const clauses = ["fact_search MATCH ?", ...buildFilterClauses(params)];
        appendOrderParams(params);
        params.push(candidateLimit - rows.length);
        const statement = db.prepare(`
          ${selectedFactColumns(factBoostExpression, "snippet(fact_search, 0, '[', ']', '...', 28)")}
          FROM fact_search
          JOIN facts ON facts.rowid = fact_search.rowid
          JOIN pages ON pages.id = facts.page_id
          WHERE ${clauses.join(" AND ")}
          ${orderBy()}
          LIMIT ?
        `);
        appendRows(statement.all(...params) as Array<Record<string, unknown>>);
      } catch {
        // Structured facts are additive; exact standard and chunk retrieval can
        // still answer when an older index lacks fact tables.
      }
    }

    if (ambientLimitIntent && rows.length < candidateLimit && !rows.some((row) => String(row.retrievalStage ?? "") === "structured_fact")) {
      try {
        const params: Array<number | string> = [];
        const clauses = buildFilterClauses(params);
        const factHaystack =
          "LOWER(COALESCE(facts.raw_text, '') || ' ' || COALESCE(facts.subject, '') || ' ' || COALESCE(facts.object_value, '') || ' ' || COALESCE(pages.pollutants, ''))";
        const focusGroups = [
          pollutantFocusTermsForQuery(normalizedQuery).flat(),
          ...requiredAmbientPeriodGroups(normalizedQuery),
          /二级/u.test(normalizedQuery) ? ["二级"] : [],
          /一级/u.test(normalizedQuery) ? ["一级"] : [],
          /(限值|标准值|浓度限值)/u.test(normalizedQuery) ? ["限值", "浓度限值"] : []
        ].filter((group) => group.length > 0);
        for (const group of focusGroups) {
          const terms = uniqueCompact(group.map((term) => term.toLowerCase()));
          if (!terms.length) {
            continue;
          }
          clauses.push(`(${terms.map(() => `${factHaystack} LIKE ?`).join(" OR ")})`);
          params.push(...terms.map((term) => `%${term}%`));
        }
        if (focusGroups.length) {
          appendOrderParams(params);
          params.push(candidateLimit - rows.length);
          const statement = db.prepare(`
            ${selectedFactColumns("-12", "substr(facts.raw_text, 1, 420)")}
            FROM facts
            JOIN pages ON pages.id = facts.page_id
            WHERE ${clauses.join(" AND ")}
            ${orderBy()}
            LIMIT ?
          `);
          appendRows(statement.all(...params) as Array<Record<string, unknown>>);
        }
      } catch {
        // LIKE fallback is best-effort for fact indexes whose FTS tokenization
        // does not align with user wording such as "24小时平均" vs "日平均".
      }
    }

    if (hasExactStandards) {
      for (const exactStandard of exactStandards) {
        const params: Array<number | string> = [];
        const clauses = buildFilterClauses(params, {
          includeSuperseded: hasUserExplicitStandard && !currentBasisIntent,
          relaxAuthority: true
        });
        if (!options.kind) {
          clauses.push("pages.kind IN ('source', 'module')");
        }
        clauses.push(
          `(
            ${standardCodeExpr("pages.standard_code_normalized")} = ?
            OR ${standardCodeExpr("pages.standard_code")} = ?
            OR (pages.standard_family = ? AND pages.standard_number = ? AND (? = '' OR pages.standard_year = ?))
          )`
        );
        params.push(
          exactStandard.compact,
          exactStandard.compact,
          exactStandard.family,
          exactStandard.number,
          exactStandard.year ?? "",
          exactStandard.year ?? ""
        );
        appendOrderParams(params);
        params.push(hasUserExplicitStandard ? 12 : 6);
        const exactRankExpression = amendmentIntent
          ? "CASE WHEN pages.document_role = 'amendment' OR pages.title LIKE '%修改单%' OR pages.standard_code LIKE '%修改单%' THEN -4 WHEN pages.legal_status = 'current_effective' THEN -2 ELSE -1 END"
          : "CASE WHEN pages.legal_status = 'current_effective' THEN -2 ELSE -1 END";
        const statement = db.prepare(`
          ${selectedColumns(exactRankExpression, "substr(pages.body, 1, 240)", "standard_exact")}
          FROM pages
          WHERE ${clauses.join(" AND ")}
          ${orderBy()}
          LIMIT ?
        `);
        appendRows(statement.all(...params) as Array<Record<string, unknown>>);
      }
    }

    if (rows.length < candidateLimit && ftsQuery) {
      try {
        const params: Array<number | string> = [ftsQuery];
        const clauses = ["fact_search MATCH ?", ...buildFilterClauses(params)];
        appendOrderParams(params);
        params.push(candidateLimit - rows.length);
        const statement = db.prepare(`
          ${selectedFactColumns(factBoostExpression, "snippet(fact_search, 0, '[', ']', '...', 28)")}
          FROM fact_search
          JOIN facts ON facts.rowid = fact_search.rowid
          JOIN pages ON pages.id = facts.page_id
          WHERE ${clauses.join(" AND ")}
          ${orderBy()}
          LIMIT ?
        `);
        appendRows(statement.all(...params) as Array<Record<string, unknown>>);
      } catch {
        // Structured facts are additive; older indexes can still use chunk/page retrieval.
      }
    }

    if (rows.length < candidateLimit && ftsQuery && options.chunking?.enabled !== false) {
      try {
        const params: Array<number | string> = [ftsQuery];
        const clauses = ["chunk_search MATCH ?", ...buildFilterClauses(params)];
        if (seenPageIds.size && !qaQcIntent && !statisticsIntent && domainPlan.pinnedStandards.length === 0) {
          clauses.push(`pages.id NOT IN (${[...seenPageIds].map(() => "?").join(", ")})`);
          params.push(...[...seenPageIds]);
        }
        appendOrderParams(params);
        params.push(candidateLimit - rows.length);
        const statement = db.prepare(`
          ${selectedChunkColumns("bm25(chunk_search) - CASE chunks.kind WHEN 'table' THEN 2.0 WHEN 'formula' THEN 1.5 WHEN 'paragraph' THEN 0.5 ELSE 0 END", "snippet(chunk_search, 0, '[', ']', '...', 24)")}
          FROM chunk_search
          JOIN chunks ON chunks.rowid = chunk_search.rowid
          JOIN pages ON pages.id = chunks.page_id
          WHERE ${clauses.join(" AND ")}
          ${orderBy()}
          LIMIT ?
        `);
        appendRows(statement.all(...params) as Array<Record<string, unknown>>);
      } catch {
        // Chunk search is additive. If an older index lacks chunk tables, page
        // search and LIKE fallback still provide compatible retrieval.
      }
    }

    if (rows.length < candidateLimit && ftsQuery) {
      try {
        const params: Array<number | string> = [ftsQuery];
        const clauses = ["page_search MATCH ?", ...buildFilterClauses(params)];
        if (seenPageIds.size) {
          clauses.push(`pages.id NOT IN (${[...seenPageIds].map(() => "?").join(", ")})`);
          params.push(...[...seenPageIds]);
        }
        appendOrderParams(params);
        params.push(candidateLimit - rows.length);
        const statement = db.prepare(`
          ${selectedColumns("bm25(page_search)", "snippet(page_search, 1, '[', ']', '...', 16)", "fts")}
          FROM page_search
          JOIN pages ON pages.rowid = page_search.rowid
          WHERE ${clauses.join(" AND ")}
          ${orderBy()}
          LIMIT ?
        `);
        appendRows(statement.all(...params) as Array<Record<string, unknown>>);
      } catch {
        // Fall back to LIKE retrieval below. This keeps malformed FTS input or
        // tokenizer edge cases from taking down agent-facing queries.
      }
    }

    if (rows.length < candidateLimit && likeTerms.length) {
      const params: Array<number | string> = [];
      const clauses = buildFilterClauses(params);
      const likeClauses: string[] = [];
      for (const term of likeTerms) {
        const pattern = `%${term.toLowerCase()}%`;
        likeClauses.push(
          "(LOWER(pages.title) LIKE ? OR LOWER(pages.body) LIKE ? OR LOWER(pages.search_terms) LIKE ? OR LOWER(pages.standard_code_normalized) LIKE ?)"
        );
        params.push(pattern, pattern, pattern, pattern);
      }
      clauses.push(`(${likeClauses.join(" OR ")})`);
      if (seenPageIds.size) {
        clauses.push(`pages.id NOT IN (${[...seenPageIds].map(() => "?").join(", ")})`);
        params.push(...[...seenPageIds]);
      }
      appendOrderParams(params);
      params.push(candidateLimit - rows.length);
      const statement = db.prepare(`
        ${selectedColumns("0", "substr(pages.body, 1, 240)", "like")}
        FROM pages
        WHERE ${clauses.join(" AND ")}
        ${orderBy()}
        LIMIT ?
      `);
      appendRows(statement.all(...params) as Array<Record<string, unknown>>);
    }
    hydrateRowsWithDomainChunks();
  } finally {
    db.close();
  }

  const orderedRows = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const priorityDelta = crossStagePriority(left.row) - crossStagePriority(right.row);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      const rankDelta = Number(left.row.rank ?? 0) - Number(right.row.rank ?? 0);
      return rankDelta !== 0 ? rankDelta : left.index - right.index;
    })
    .map((item) => item.row);

  return orderedRows.slice(0, limit).map((row) => ({
    projectIds: (() => {
      const raw = String(row.projectIds ?? "[]");
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
      } catch {
        return [];
      }
    })(),
    pageId: String(row.pageId ?? ""),
    path: String(row.path ?? ""),
    title: String(row.title ?? ""),
    kind: normalizeKind(row.kind),
    status: normalizeStatus(row.status),
    sourceType: normalizeSourceType(row.sourceType),
    sourceClass: normalizeSourceClass(row.sourceClass),
    authorityLayer: String(row.authorityLayer ?? "") || undefined,
    legalStatus: String(row.legalStatus ?? "") || undefined,
    documentRole: String(row.documentRole ?? "") || undefined,
    jurisdiction: String(row.jurisdiction ?? "") || undefined,
    region: String(row.region ?? "") || undefined,
    standardCode: String(row.standardCode ?? "") || undefined,
    standardIdentity: String(row.standardIdentity ?? "") || undefined,
    evidenceRole: normalizeEvidenceRole(row.evidenceRole),
    reportingPeriod: String(row.reportingPeriod ?? "") || undefined,
    evidencePeriod: String(row.evidencePeriod ?? "") || undefined,
    visibility:
      row.visibility === "public" || row.visibility === "tenant" || row.visibility === "project"
        ? (row.visibility as SearchResult["visibility"])
        : undefined,
    tenantId: String(row.tenantId ?? "") || undefined,
    sourceScope:
      row.sourceScope === "public_authority" ||
      row.sourceScope === "tenant_private" ||
      row.sourceScope === "project_private" ||
      row.sourceScope === "generated_report"
        ? (row.sourceScope as SearchResult["sourceScope"])
        : undefined,
    pollutants: String(row.pollutants ?? "")
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean),
    chunkId: String(row.chunkId ?? "") || undefined,
    chunkOrdinal:
      row.chunkOrdinal === null || typeof row.chunkOrdinal === "undefined" || row.chunkOrdinal === ""
        ? undefined
        : Number.isFinite(Number(row.chunkOrdinal))
          ? Number(row.chunkOrdinal)
          : undefined,
    chunkHeading: String(row.chunkHeading ?? "") || undefined,
    chunkKind: normalizeChunkKind(row.chunkKind),
    chunkLocation: String(row.chunkLocation ?? "") || undefined,
    retrievalStage: normalizeRetrievalStage(row.retrievalStage),
    factId: String(row.factId ?? "") || undefined,
    factStableId: String(row.factStableId ?? "") || undefined,
    factOrdinal:
      row.factOrdinal === null || typeof row.factOrdinal === "undefined" || row.factOrdinal === ""
        ? undefined
        : Number.isFinite(Number(row.factOrdinal))
          ? Number(row.factOrdinal)
          : undefined,
    factLegacyIds: parseJsonStringList(row.factLegacyIds),
    factType: String(row.factType ?? "") || undefined,
    factTable: String(row.factTable ?? "") || undefined,
    factRawText: String(row.factRawText ?? "") || undefined,
    factClauseNo: String(row.factClauseNo ?? "") || undefined,
    factTableNo: String(row.factTableNo ?? "") || undefined,
    factFormulaNo: String(row.factFormulaNo ?? "") || undefined,
    factSourceSection: String(row.factSourceSection ?? "") || undefined,
    factSubject: String(row.factSubject ?? "") || undefined,
    factPredicate: String(row.factPredicate ?? "") || undefined,
    factObjectValue: String(row.factObjectValue ?? "") || undefined,
    factQualifiers: parseJsonObject(row.factQualifiers),
    factProvenance: String(row.factProvenance ?? "") || undefined,
    rankingSignals: domainPlan.rankingSignals,
    snippet:
      String(row.retrievalStage ?? "") === "structured_fact"
        ? listCompleteIntent
          ? String(row.factRawText ?? "").slice(0, 5000)
          : renderStructuredFactSnippet({ rawText: String(row.factRawText ?? ""), pollutant: String(row.pollutants ?? "") })
        : String(row.snippet ?? ""),
    rank: Number(row.rank ?? 0)
  }));
}

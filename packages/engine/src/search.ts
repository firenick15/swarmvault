import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import {
  buildEnvAirQueryPlan,
  buildEnvAirSearchText,
  extractStandardReferences,
  inferCurrentBasisIntent,
  normalizeStandardCode,
  searchLikeTerms
} from "./domain/env-air.js";
import { searchTokens } from "./tokenize.js";
import type { GraphPage, PageKind, PageStatus, SearchResult, SourceCaptureType, SourceClass, SourceManifest } from "./types.js";
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
  includeDrafts?: boolean;
  includeSuperseded?: boolean;
}

export interface SearchQueryOptions extends SearchPageFilters {
  limit?: number;
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
  return value === "standard_exact" ||
    value === "fts" ||
    value === "chunk_fts" ||
    value === "like" ||
    value === "semantic" ||
    value === "rerank"
    ? value
    : undefined;
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
  if (/^#{1,6}\s/.test(trimmed)) {
    if (/(^#{1,6}\s*表\s*[0-9一二三四五六七八九十]|浓度限值|限值表)/.test(trimmed)) {
      return "table";
    }
    if (/(^#{1,6}\s*公式|计算公式)/.test(trimmed)) {
      return "formula";
    }
    return "heading";
  }
  if (trimmed.includes("|") && /\|.*\|/.test(trimmed)) {
    return "table";
  }
  if (/<table[\s>]/i.test(trimmed)) {
    return "table";
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

function focusedChunkSnippet(text: string, focusTerms: string[], maxChars = 1800): string {
  const sourceText = sourceExcerptBody(text).trim();
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

function hasUsefulAmbientLimitSnippet(snippet: string): boolean {
  return snippet.includes("PM2.5") && (snippet.includes("年平均") || snippet.includes("浓度限值"));
}

function hasUsefulAmendmentSnippet(snippet: string): boolean {
  return /(将|修改为|替换|删除|增加|按式|式中|结果表示)/.test(snippet);
}

function meaningfulMetadataValue(value: unknown): string {
  return typeof value === "string" && value.trim() && value.trim() !== "unknown" ? value.trim() : "";
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
    } else if (documentRole === "amendment" || authorityLayer === "core" || authorityLayer === "method" || authorityLayer === "local") {
      legalStatus = "current_effective";
    }
  }

  return { authorityLayer, legalStatus, documentRole };
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
    if (next.length > maxChars && buffer) {
      flush();
      bufferHeading = heading;
      buffer = trimmed;
    } else {
      bufferHeading = bufferHeading || heading;
      buffer = next;
    }
    if (buffer.length >= maxChars) {
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
      standard_code_normalized TEXT NOT NULL,
      standard_family TEXT NOT NULL,
      standard_number TEXT NOT NULL,
      standard_year TEXT NOT NULL,
      pollutants TEXT NOT NULL,
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
    DELETE FROM chunk_search;
    DELETE FROM chunks;
    DELETE FROM page_search;
    DELETE FROM pages;
  `);

  const insertPage = db.prepare(
    "INSERT INTO pages (id, path, title, body, kind, status, source_type, source_class, authority_layer, legal_status, document_role, jurisdiction, region, standard_code, standard_code_normalized, standard_family, standard_number, standard_year, pollutants, search_terms, project_ids, project_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, page_id, ordinal, heading, kind, location, text, search_terms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const rootDir = path.dirname(wikiDir);

  db.exec("BEGIN TRANSACTION;");
  try {
    for (const page of pages) {
      const absolutePath = path.join(wikiDir, page.path);
      const content = await fs.readFile(absolutePath, "utf8");
      const parsed = matter(content);
      let body = parsed.content;
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
              body = `${body}\n\n## Source Excerpt\n\n${excerpt.trim()}`.trim();
            }
          }
        } catch {
          // Leave the page searchable via its generated markdown alone when source excerpts are unavailable.
        }
      }
      const standardCode = typeof parsed.data.standard_code === "string" ? parsed.data.standard_code : "";
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
      const pollutants = Array.isArray(parsed.data.pollutants)
        ? (parsed.data.pollutants as unknown[]).filter((item): item is string => typeof item === "string")
        : typeof parsed.data.pollutants === "string"
          ? parsed.data.pollutants
              .split("|")
              .map((item) => item.trim())
              .filter(Boolean)
          : [];
      const searchTerms = buildEnvAirSearchText({ title: page.title, body, standardCode, pollutants });
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
        standardCode ? normalizeStandardCode(standardCode) : (firstStandard?.normalized ?? ""),
        firstStandard?.family ?? "",
        firstStandard?.number ?? "",
        firstStandard?.year ?? "",
        pollutants.join("|"),
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
    }

    db.exec("INSERT INTO page_search (rowid, title, body, search_terms) SELECT rowid, title, body, search_terms FROM pages;");
    db.exec("INSERT INTO chunk_search (rowid, text, search_terms) SELECT rowid, text, search_terms FROM chunks;");
    db.exec("COMMIT;");
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
  const domainPlan = buildEnvAirQueryPlan(query);
  const expandedQuery = [domainPlan.normalizedQuery, ...domainPlan.expandedTerms, ...domainPlan.pinnedStandards].join(" ");
  const normalizedQuery = normalizedStandardQuery(expandedQuery);
  const ftsQuery = toFtsQuery(normalizedQuery);
  const likeTerms = searchLikeTerms(normalizedQuery);
  if (!ftsQuery && likeTerms.length === 0) {
    return [];
  }
  const currentBasisIntent = inferCurrentBasisIntent(normalizedQuery);
  const pinnedStandard = extractStandardReferences(domainPlan.pinnedStandards.join(" "))[0];
  const explicitStandard = domainPlan.standardRefs[0] ?? pinnedStandard;
  const hasUserExplicitStandard = domainPlan.standardRefs.length > 0;
  const explicitStandardCompact = explicitStandard?.compact ?? "";
  const explicitStandardFamily = explicitStandard?.family ?? "";
  const explicitStandardNumber = explicitStandard?.number ?? "";
  const explicitStandardYear = explicitStandard?.year ?? "";
  const ambientLimitIntent = domainPlan.rankingSignals.includes("ambient_air_quality_limit_question");
  const amendmentIntent = /修改单|amendment/i.test(normalizedQuery);
  const DatabaseSync = getDatabaseSync();
  const db = withSuppressedSqliteExperimentalWarning(() => new DatabaseSync(dbPath, { readOnly: true }));
  const limit = options.limit ?? 5;
  const candidateLimit = Math.max(limit * 3, limit + 5);
  const seen = new Set<string>();
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
        pages.pollutants AS pollutants,
        pages.project_ids AS projectIds,
        NULL AS chunkId,
        NULL AS chunkOrdinal,
        NULL AS chunkHeading,
        NULL AS chunkKind,
        NULL AS chunkLocation,
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
        pages.pollutants AS pollutants,
        pages.project_ids AS projectIds,
        chunks.id AS chunkId,
        chunks.ordinal AS chunkOrdinal,
        chunks.heading AS chunkHeading,
        chunks.kind AS chunkKind,
        chunks.location AS chunkLocation,
        'chunk_fts' AS retrievalStage,
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

  function buildFilterClauses(params: Array<number | string>, mode: { relaxAuthority?: boolean } = {}): string[] {
    const clauses: string[] = [];
    addScalarOrListFilter(clauses, params, "pages.kind", options.kind);
    addScalarOrListFilter(clauses, params, "pages.status", options.status);
    if (options.project && options.project !== "all") {
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
    if (options.pollutant && options.pollutant !== "all") {
      clauses.push("LOWER(pages.pollutants) LIKE ?");
      params.push(`%${options.pollutant.toLowerCase()}%`);
    }
    if (options.includeDrafts !== true) {
      clauses.push("(pages.legal_status <> 'draft_consultation' OR pages.legal_status = '')");
    }
    if (options.includeSuperseded !== true) {
      clauses.push("(pages.legal_status <> 'superseded' OR pages.legal_status = '')");
    }
    return clauses;
  }

  function standardCodeExpr(column: string): string {
    return `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${column}, ' ', ''), '-', ''), '/', ''), '—', ''), '–', ''), '―', ''), '：', ''))`;
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
          WHEN ${ambientLimitIntent ? 1 : 0} = 1 AND pages.standard_family = 'GB' AND pages.standard_number = '3095' AND (pages.document_role = 'standard' OR pages.title LIKE '%环境空气质量标准%') THEN 0
          WHEN ${ambientLimitIntent ? 1 : 0} = 1 AND pages.standard_family = 'GB' AND pages.standard_number = '3095' THEN 1
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

  function appendRows(nextRows: Array<Record<string, unknown>>): void {
    for (const row of nextRows) {
      const pageId = String(row.pageId ?? "");
      if (!pageId || seen.has(pageId)) {
        continue;
      }
      seen.add(pageId);
      rows.push(row);
      if (rows.length >= candidateLimit) {
        break;
      }
    }
  }

  function crossStagePriority(row: Record<string, unknown>): number {
    const title = String(row.title ?? "");
    const standardCode = String(row.standardCode ?? "");
    const documentRole = String(row.documentRole ?? "");
    const retrievalStage = String(row.retrievalStage ?? "");
    if (hasUserExplicitStandard && retrievalStage === "standard_exact") {
      if (amendmentIntent && (documentRole === "amendment" || title.includes("修改单") || standardCode.includes("修改单"))) {
        return -120;
      }
      return -100;
    }
    if (ambientLimitIntent && /GB\s*3095/i.test(standardCode)) {
      if (documentRole === "standard" || title.includes("环境空气质量标准") || title === "中华人民共和国国家标准") {
        return -90;
      }
      return -70;
    }
    if (amendmentIntent && (documentRole === "amendment" || title.includes("修改单") || standardCode.includes("修改单"))) {
      return -80;
    }
    return 0;
  }

  function hydrateRowsWithDomainChunks(): void {
    const targetRows = rows.filter((row) => {
      const title = String(row.title ?? "");
      const standardCode = String(row.standardCode ?? "");
      const snippet = String(row.snippet ?? "");
      const isAmbientLimitTarget = ambientLimitIntent && /GB\s*3095/i.test(standardCode);
      const isAmendmentTarget = amendmentIntent && (title.includes("修改单") || standardCode.includes("修改单"));
      if (!isAmbientLimitTarget && !isAmendmentTarget) {
        return false;
      }
      if (!row.chunkId) {
        return true;
      }
      if (isAmbientLimitTarget) {
        return !hasUsefulAmbientLimitSnippet(snippet);
      }
      return isAmendmentTarget && !hasUsefulAmendmentSnippet(snippet);
    });
    if (!targetRows.length) {
      return;
    }
    const ambientTerms = ["PM2.5", "细颗粒物", "年平均", "浓度限值", "一级", "二级", "表"];
    const amendmentTerms = ["修改单", "甲醛吸收", "副玫瑰苯胺", "修订", "替换"];
    for (const row of targetRows) {
      const terms = ambientLimitIntent && /GB\s*3095/i.test(String(row.standardCode ?? "")) ? ambientTerms : amendmentTerms;
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
          const domainScore =
            ambientLimitIntent && /GB\s*3095/i.test(String(row.standardCode ?? ""))
              ? (text.includes("PM2.5") || text.includes("细颗粒物") ? 6 : 0) +
                (text.includes("年平均") ? 4 : 0) +
                (text.includes("浓度限值") || text.includes("一级") || text.includes("二级") ? 3 : 0)
              : (text.includes("修改单") ? 5 : 0) +
                (text.includes("甲醛吸收") ? 3 : 0) +
                (text.includes("副玫瑰苯胺") ? 3 : 0) +
                (hasUsefulAmendmentSnippet(sourceExcerptBody(text)) ? 8 : 0);
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
        ambientLimitIntent && /GB\s*3095/i.test(String(row.standardCode ?? ""))
          ? ["PM2.5", "细颗粒物", "年平均", "浓度限值"]
          : ["将", "修改为", "结果表示", "按式", "式中"]
      );
      row.retrievalStage = row.retrievalStage ?? "chunk_fts";
    }
  }

  try {
    if (explicitStandard && hasUserExplicitStandard) {
      const params: Array<number | string> = [];
      const clauses = buildFilterClauses(params, { relaxAuthority: true });
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
        explicitStandardCompact,
        explicitStandardCompact,
        explicitStandardFamily,
        explicitStandardNumber,
        explicitStandardYear,
        explicitStandardYear
      );
      appendOrderParams(params);
      params.push(Math.min(candidateLimit, 12));
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

    if (rows.length < candidateLimit && ftsQuery && options.chunking?.enabled !== false) {
      try {
        const params: Array<number | string> = [ftsQuery];
        const clauses = ["chunk_search MATCH ?", ...buildFilterClauses(params)];
        if (seen.size) {
          clauses.push(`pages.id NOT IN (${[...seen].map(() => "?").join(", ")})`);
          params.push(...[...seen]);
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
        if (seen.size) {
          clauses.push(`pages.id NOT IN (${[...seen].map(() => "?").join(", ")})`);
          params.push(...[...seen]);
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
      if (seen.size) {
        clauses.push(`pages.id NOT IN (${[...seen].map(() => "?").join(", ")})`);
        params.push(...[...seen]);
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
    rankingSignals: domainPlan.rankingSignals,
    snippet: String(row.snippet ?? ""),
    rank: Number(row.rank ?? 0)
  }));
}

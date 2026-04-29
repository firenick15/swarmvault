import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { buildEnvAirSearchText, extractStandardReferences, normalizeStandardCode, searchLikeTerms } from "./domain/env-air.js";
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
    .replace(/\bpm\s*2\s*\.?\s*5\b/gi, "pm2.5")
    .replace(/\bpm\s*1\s*0\b/gi, "pm10")
    .trim();
}

function inferCurrentBasisIntent(query: string): boolean {
  return /(现行|按什么执行|执行依据|限值|标准|依据|current\s+basis|what\s+standard)/i.test(query);
}

export async function rebuildSearchIndex(dbPath: string, pages: GraphPage[], wikiDir: string): Promise<void> {
  await ensureDir(path.dirname(dbPath));
  const DatabaseSync = getDatabaseSync();
  const db = withSuppressedSqliteExperimentalWarning(() => new DatabaseSync(dbPath));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    DROP TABLE IF EXISTS page_search;
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
      standard_year TEXT NOT NULL,
      pollutants TEXT NOT NULL,
      search_terms TEXT NOT NULL,
      project_ids TEXT NOT NULL,
      project_key TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(
      title,
      body,
      search_terms,
      content='pages',
      content_rowid='rowid'
    );
    DELETE FROM page_search;
    DELETE FROM pages;
  `);

  const insertPage = db.prepare(
    "INSERT INTO pages (id, path, title, body, kind, status, source_type, source_class, authority_layer, legal_status, document_role, jurisdiction, region, standard_code, standard_code_normalized, standard_family, standard_year, pollutants, search_terms, project_ids, project_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const rootDir = path.dirname(wikiDir);

  for (const page of pages) {
    const absolutePath = path.join(wikiDir, page.path);
    const content = await fs.readFile(absolutePath, "utf8");
    const parsed = matter(content);
    let body = parsed.content;
    const primarySourceId =
      Array.isArray(parsed.data.source_ids) && typeof parsed.data.source_ids[0] === "string"
        ? parsed.data.source_ids[0]
        : page.sourceIds[0];
    if ((page.kind === "source" || page.kind === "module") && primarySourceId) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(rootDir, "state", "manifests", `${primarySourceId}.json`), "utf8")
        ) as SourceManifest;
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
      typeof parsed.data.authority_layer === "string" ? parsed.data.authority_layer : "",
      typeof parsed.data.legal_status === "string" ? parsed.data.legal_status : "",
      typeof parsed.data.document_role === "string" ? parsed.data.document_role : "",
      typeof parsed.data.jurisdiction === "string" ? parsed.data.jurisdiction : "",
      typeof parsed.data.region === "string" ? parsed.data.region : "",
      standardCode,
      standardCode ? normalizeStandardCode(standardCode) : (firstStandard?.normalized ?? ""),
      firstStandard?.family ?? "",
      firstStandard?.year ?? "",
      pollutants.join("|"),
      searchTerms,
      JSON.stringify(page.projectIds),
      page.projectIds.map((projectId) => `|${projectId}|`).join("")
    );
  }

  db.exec("INSERT INTO page_search (rowid, title, body, search_terms) SELECT rowid, title, body, search_terms FROM pages;");
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
        sourceClass: undefined
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
  const normalizedQuery = normalizedStandardQuery(query);
  const ftsQuery = toFtsQuery(normalizedQuery);
  const likeTerms = searchLikeTerms(normalizedQuery);
  if (!ftsQuery && likeTerms.length === 0) {
    return [];
  }
  const currentBasisIntent = inferCurrentBasisIntent(normalizedQuery);
  const explicitStandard = extractStandardReferences(normalizedQuery)[0];
  const explicitStandardCompact = explicitStandard?.compact ?? "";
  const explicitStandardFamily = explicitStandard?.family ?? "";
  const DatabaseSync = getDatabaseSync();
  const db = withSuppressedSqliteExperimentalWarning(() => new DatabaseSync(dbPath, { readOnly: true }));
  const limit = options.limit ?? 5;
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];

  function selectedColumns(rankExpression: string, snippetExpression: string): string {
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

  function buildFilterClauses(params: Array<number | string>): string[] {
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
    addScalarOrListFilter(clauses, params, "pages.authority_layer", options.authorityLayer);
    addScalarOrListFilter(clauses, params, "pages.legal_status", options.legalStatus);
    addScalarOrListFilter(clauses, params, "pages.document_role", options.documentRole);
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
    return `UPPER(REPLACE(REPLACE(REPLACE(${column}, ' ', ''), '-', ''), '/', ''))`;
  }

  function orderBy(): string {
    return `
      ORDER BY
        CASE
          WHEN ${currentBasisIntent ? 1 : 0} = 1 AND pages.legal_status = 'current_effective' THEN 0
          WHEN ${currentBasisIntent ? 1 : 0} = 1 AND pages.authority_layer IN ('core', 'method', 'local') THEN 1
          WHEN ${currentBasisIntent ? 1 : 0} = 1 THEN 2
          ELSE 0
        END,
        CASE
          WHEN ? <> '' AND (${standardCodeExpr("pages.standard_code_normalized")} = ? OR ${standardCodeExpr("pages.standard_code")} = ?) THEN 0
          WHEN ? <> '' AND pages.standard_family = ? THEN 1
          WHEN ? <> '' THEN 2
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
      if (rows.length >= limit) {
        break;
      }
    }
  }

  try {
    if (ftsQuery) {
      try {
        const params: Array<number | string> = [ftsQuery];
        const clauses = ["page_search MATCH ?", ...buildFilterClauses(params)];
        appendOrderParams(params);
        params.push(limit);
        const statement = db.prepare(`
          ${selectedColumns("bm25(page_search)", "snippet(page_search, 1, '[', ']', '...', 16)")}
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

    if (rows.length < limit && likeTerms.length) {
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
      params.push(limit - rows.length);
      const statement = db.prepare(`
        ${selectedColumns("0", "substr(pages.body, 1, 240)")}
        FROM pages
        WHERE ${clauses.join(" AND ")}
        ${orderBy()}
        LIMIT ?
      `);
      appendRows(statement.all(...params) as Array<Record<string, unknown>>);
    }
  } finally {
    db.close();
  }

  return rows.map((row) => ({
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
    snippet: String(row.snippet ?? ""),
    rank: Number(row.rank ?? 0)
  }));
}

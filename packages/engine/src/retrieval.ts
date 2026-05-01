import fs from "node:fs/promises";
import path from "node:path";
import { loadVaultConfig } from "./config.js";
import { applyStandardRelationOverrides } from "./domain/standard-relations.js";
import { rebuildSearchIndex } from "./search.js";
import type { GraphArtifact, RetrievalConfig, RetrievalDoctorResult, RetrievalManifest, RetrievalStatus, VaultConfig } from "./types.js";
import { fileExists, readJsonFile, sha256, toPosix, writeJsonFile } from "./utils.js";

const DEFAULT_RETRIEVAL_SHARD_SIZE = 25000;
export const RETRIEVAL_INDEX_SCHEMA_VERSION = 3;

const RETRIEVAL_INDEX_REQUIRED_COLUMNS: Record<string, string[]> = {
  pages: [
    "id",
    "path",
    "title",
    "body",
    "authority_layer",
    "legal_status",
    "document_role",
    "standard_identity",
    "standard_code_normalized",
    "evidence_role",
    "reporting_period",
    "evidence_period",
    "visibility",
    "tenant_id",
    "source_scope",
    "project_key"
  ],
  chunks: ["id", "page_id", "ordinal", "heading", "kind", "location", "text", "search_terms"],
  facts: [
    "id",
    "page_id",
    "fact_stable_id",
    "fact_legacy_ids",
    "fact_type",
    "clause_no",
    "table_no",
    "formula_no",
    "source_section",
    "standard_identity",
    "evidence_role",
    "raw_text",
    "search_terms"
  ],
  page_search: ["title", "body", "search_terms"],
  chunk_search: ["text", "search_terms"],
  fact_search: ["raw_text", "search_terms"]
};

type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;

function retrievalIndexSchemaHash(): string {
  return sha256(JSON.stringify({ version: RETRIEVAL_INDEX_SCHEMA_VERSION, columns: RETRIEVAL_INDEX_REQUIRED_COLUMNS }));
}

function warningMessage(warning: string | Error): string {
  return warning instanceof Error ? warning.message : String(warning);
}

function warningType(warning: string | Error, type?: string): string | undefined {
  if (warning instanceof Error) {
    return warning.name;
  }
  return typeof type === "string" ? type : undefined;
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
    if (warningType(warning, type) === "ExperimentalWarning" && warningMessage(warning).includes("SQLite is an experimental feature")) {
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

async function inspectRetrievalIndex(
  dbPath: string,
  manifest: RetrievalManifest | null
): Promise<{ schemaOk: boolean; warnings: string[] }> {
  if (!(await fileExists(dbPath))) {
    return { schemaOk: false, warnings: [] };
  }
  const warnings: string[] = [];
  const stat = await fs.stat(dbPath).catch(() => null);
  if (!stat?.size) {
    warnings.push("Retrieval index file is empty.");
    return { schemaOk: false, warnings };
  }
  const DatabaseSync = getDatabaseSync();
  const db = withSuppressedSqliteExperimentalWarning(() => new DatabaseSync(dbPath, { readOnly: true }));
  try {
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name?: unknown }>;
    const tables = new Set(tableRows.map((row) => String(row.name ?? "")));
    for (const [table, requiredColumns] of Object.entries(RETRIEVAL_INDEX_REQUIRED_COLUMNS)) {
      if (!tables.has(table)) {
        warnings.push(`Retrieval index table is missing: ${table}.`);
        continue;
      }
      const columnRows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
      const columns = new Set(columnRows.map((row) => String(row.name ?? "")));
      for (const column of requiredColumns) {
        if (!columns.has(column)) {
          warnings.push(`Retrieval index column is missing: ${table}.${column}.`);
        }
      }
    }
  } catch (error) {
    warnings.push(`Retrieval index schema check failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
  if (manifest?.indexSchemaHash && manifest.indexSchemaHash !== retrievalIndexSchemaHash()) {
    warnings.push("Retrieval manifest schema hash does not match the current engine schema.");
  }
  if (manifest?.indexSchemaVersion && manifest.indexSchemaVersion !== RETRIEVAL_INDEX_SCHEMA_VERSION) {
    warnings.push("Retrieval manifest schema version does not match the current engine schema.");
  }
  return { schemaOk: warnings.length === 0, warnings };
}

export function resolveRetrievalConfig(config: VaultConfig): RetrievalConfig {
  return {
    backend: "sqlite",
    shardSize: config.retrieval?.shardSize ?? DEFAULT_RETRIEVAL_SHARD_SIZE,
    hybrid: config.retrieval?.hybrid ?? config.search?.hybrid ?? true,
    rerank: config.retrieval?.rerank ?? config.search?.rerank ?? false,
    embeddingProvider: config.retrieval?.embeddingProvider ?? config.tasks.embeddingProvider,
    maxIndexedRows: config.retrieval?.maxIndexedRows,
    chunking: {
      enabled: config.retrieval?.chunking?.enabled ?? true,
      maxChars: config.retrieval?.chunking?.maxChars ?? 1600,
      overlapChars: config.retrieval?.chunking?.overlapChars ?? 160
    },
    debug: config.retrieval?.debug ?? false
  };
}

function graphHash(graph: GraphArtifact): string {
  return sha256(
    JSON.stringify({
      generatedAt: graph.generatedAt,
      pages: graph.pages
        .map((page) => [page.id, page.path, page.kind, page.status, page.updatedAt, page.sourceIds, page.sourceHashes])
        .sort((left, right) => {
          return String(left[0]).localeCompare(String(right[0]));
        })
    })
  );
}

export async function writeRetrievalManifest(rootDir: string, graph: GraphArtifact): Promise<RetrievalManifest> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifest: RetrievalManifest = {
    version: 3,
    backend: "sqlite",
    generatedAt: new Date().toISOString(),
    graphGeneratedAt: graph.generatedAt,
    graphHash: graphHash(graph),
    indexSchemaHash: retrievalIndexSchemaHash(),
    indexSchemaVersion: RETRIEVAL_INDEX_SCHEMA_VERSION,
    shardCount: 1,
    shards: [
      {
        id: "fts-000",
        path: toPosix(path.relative(paths.stateDir, paths.searchDbPath)),
        pageCount: graph.pages.length
      }
    ]
  };
  await writeJsonFile(paths.retrievalManifestPath, manifest);
  return manifest;
}

export async function rebuildRetrievalIndex(rootDir: string): Promise<RetrievalStatus> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("Graph artifact not found. Run `swarmvault compile` before rebuilding retrieval.");
  }
  await applyStandardRelationOverrides(paths.wikiDir, graph.pages);
  await rebuildSearchIndex(paths.searchDbPath, graph.pages, paths.wikiDir, { chunking: config.retrieval?.chunking });
  await writeRetrievalManifest(rootDir, graph);
  return getRetrievalStatus(rootDir);
}

export async function getRetrievalStatus(rootDir: string): Promise<RetrievalStatus> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const configured = resolveRetrievalConfig(config);
  const [manifest, graph, manifestExists, indexExists, graphExists] = await Promise.all([
    readJsonFile<RetrievalManifest>(paths.retrievalManifestPath).catch(() => null),
    readJsonFile<GraphArtifact>(paths.graphPath).catch(() => null),
    fileExists(paths.retrievalManifestPath),
    fileExists(paths.searchDbPath),
    fileExists(paths.graphPath)
  ]);
  const warnings: string[] = [];
  if (!graphExists) {
    warnings.push("Graph artifact is missing. Run `swarmvault compile`.");
  }
  if (!indexExists) {
    warnings.push("Retrieval index is missing. Run `swarmvault retrieval rebuild`.");
  }
  if (!manifestExists) {
    warnings.push("Retrieval manifest is missing. Run `swarmvault retrieval rebuild`.");
  }
  if (manifest && graph && manifest.graphHash !== graphHash(graph)) {
    warnings.push("Retrieval index is stale relative to the current graph.");
  }
  const schemaInspection = await inspectRetrievalIndex(paths.searchDbPath, manifest);
  warnings.push(...schemaInspection.warnings);
  return {
    configured,
    manifestPath: paths.retrievalManifestPath,
    indexPath: paths.searchDbPath,
    manifestExists,
    indexExists,
    graphExists,
    stale:
      Boolean(manifest && graph && manifest.graphHash !== graphHash(graph)) ||
      !manifestExists ||
      !indexExists ||
      !schemaInspection.schemaOk,
    pageCount: manifest?.shards.reduce((total, shard) => total + shard.pageCount, 0) ?? graph?.pages.length ?? 0,
    shardCount: manifest?.shardCount ?? 0,
    warnings,
    schemaOk: schemaInspection.schemaOk
  };
}

export async function doctorRetrieval(rootDir: string, options: { repair?: boolean } = {}): Promise<RetrievalDoctorResult> {
  let status = await getRetrievalStatus(rootDir);
  const actions: string[] = [];
  let repaired = false;
  if (status.stale) {
    actions.push("rebuild");
    if (options.repair) {
      status = await rebuildRetrievalIndex(rootDir);
      repaired = true;
    }
  }
  return {
    status,
    ok: !status.stale && status.warnings.length === 0,
    repaired,
    actions
  };
}

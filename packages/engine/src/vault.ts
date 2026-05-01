import fs from "node:fs/promises";
import path from "node:path";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import matter from "gray-matter";
import { z } from "zod";
import { installConfiguredAgents } from "./agents.js";
import { analysisSignature, analyzeSource } from "./analysis.js";
import {
  benchmarkQueryTokens,
  buildBenchmarkArtifact,
  buildBenchmarkByClass,
  defaultBenchmarkQuestionsForGraph,
  estimateCorpusWords,
  graphHash
} from "./benchmark.js";
import {
  DEFAULT_PROMOTION_CONFIG,
  evaluateCandidateForPromotion,
  renderPromotionSessionMarkdown,
  sortDecisionsForPromotion
} from "./candidate-promotion.js";
import { buildCodeIndex, enrichResolvedCodeImports, modulePageTitle } from "./code-analysis.js";
import { withCompileLock } from "./compile-lock.js";
import { conflictConfidence, edgeConfidence, nodeConfidence } from "./confidence.js";
import { defaultVaultSchema, initWorkspace, loadVaultConfig, PRIMARY_SCHEMA_FILENAME } from "./config.js";
import { runConsolidation } from "./consolidate.js";
import { runDeepLint } from "./deep-lint.js";
import {
  buildEnvAirQueryPlan,
  buildEnvironmentDataToolHints,
  classifyEnvAirToolRouting,
  pollutantAliasGroupsForQuery,
  standardAliasGroupsForQuery,
  standardIdentityKey,
  standardRefsForExactRetrieval
} from "./domain/env-air.js";
import { buildDomainQueryPlan } from "./domain/intents.js";
import { domainProfileHash } from "./domain/profile.js";
import { type LoadedDomainProfile, loadDomainProfile } from "./domain/profile-loader.js";
import { applyStandardRelationOverrides } from "./domain/standard-relations.js";
import { embeddingSimilarityEdges, filterGraphBySourceClass, semanticGraphMatches, semanticPageSearch } from "./embeddings.js";
import { markSuperseded, resolveDecayConfig, runDecayPass } from "./freshness.js";
import { enrichGraph } from "./graph-enrichment.js";
import { buildGraphShareArtifact, renderGraphShareBundleFiles, renderGraphShareSvg } from "./graph-share.js";
import {
  blastRadius,
  computeNormLabel,
  explainGraphTarget,
  listHyperedges,
  queryGraph,
  shortestGraphPath,
  topGodNodes
} from "./graph-tools.js";
import { ingestInput, listManifests, readExtractedText } from "./ingest.js";
import { evaluateKnowledgeCandidateQuality } from "./knowledge-quality.js";
import { resolveLargeRepoDefaults } from "./large-repo-defaults.js";
import { recordSession } from "./logs.js";
import {
  buildAggregatePage,
  buildCommunitySummaryPage,
  buildExploreHubPage,
  buildGraphReportArtifact,
  buildGraphReportPage,
  buildGraphSharePage,
  buildIndexPage,
  buildModulePage,
  buildOutputPage,
  buildProjectIndex,
  buildProjectsIndex,
  buildSectionIndex,
  buildSourcePage,
  candidatePagePathFor,
  type ManagedGraphPageMetadata,
  type ManagedPageMetadata
} from "./markdown.js";
import { buildMemoryGraphElements, loadMemoryTaskPages, memoryTaskHashes, updateMemoryTask } from "./memory.js";
import { runConfiguredRoles, summarizeRoleQuestions } from "./orchestration.js";
import {
  buildOutputAssetManifest,
  chartSpecSchema,
  renderChartSvg,
  renderRasterPosterSvg,
  renderSceneSvg,
  sceneSpecSchema
} from "./output-artifacts.js";
import { loadSavedOutputPages, relatedOutputsForPage, resolveUniqueOutputSlug } from "./outputs.js";
import { loadExistingManagedPageState, loadInsightPages, parseStoredPage } from "./pages.js";
import { createProvider, getProviderForTask } from "./providers/registry.js";
import { ensureRetrievalReady, resolveRetrievalConfig, writeRetrievalManifest } from "./retrieval.js";
import {
  buildSchemaPrompt,
  composeVaultSchema,
  getEffectiveSchema,
  type LoadedVaultSchemas,
  loadVaultSchemas,
  schemaCategoryLabels
} from "./schema.js";
import { mergeSearchResults, rebuildSearchIndex, type SearchQueryOptions, searchPages } from "./search.js";
import { ALL_SOURCE_CLASSES, aggregateManifestSourceClass } from "./source-classification.js";
import { listGuidedSourceSessions, updateGuidedSourceSessionStatus } from "./source-sessions.js";
import { synthesizeEnvAirTopics } from "./topic-synthesis.js";
import type {
  AgentMemoryTask,
  AnalysisRetryResult,
  AnalysisStatusResult,
  ApprovalBundleType,
  ApprovalChangeType,
  ApprovalDetail,
  ApprovalDiffHunk,
  ApprovalDiffLine,
  ApprovalEntry,
  ApprovalEntryDetail,
  ApprovalEntryLabel,
  ApprovalFrontmatterChange,
  ApprovalManifest,
  ApprovalStructuredDiff,
  ApprovalSummary,
  BenchmarkArtifact,
  BenchmarkOptions,
  BenchmarkQuestionResult,
  BlastRadiusResult,
  CandidatePromotionConfig,
  CandidateRecord,
  CodeIndexArtifact,
  CompileInvalidationReport,
  CompileLifecycleStep,
  CompileOptions,
  CompileResult,
  CompileState,
  ConsolidationResult,
  ExploreOptions,
  ExploreResult,
  ExploreStepResult,
  GraphArtifact,
  GraphEdge,
  GraphExplainResult,
  GraphHyperedge,
  GraphNode,
  GraphPage,
  GraphPathResult,
  GraphQueryResult,
  GraphReportArtifact,
  GraphShareBundleFile,
  InitOptions,
  LintFinding,
  LintOptions,
  OutputAsset,
  OutputFormat,
  PageManager,
  PageStatus,
  PromotionDecision,
  PromotionSession,
  ProviderSmokeTestResult,
  QueryOptions,
  QueryResult,
  RetrievalDebugInfo,
  ReviewActionResult,
  SearchResult,
  SourceAnalysis,
  SourceClass,
  SourceManifest,
  StandardCoverage,
  ToolRoutingDecision,
  VaultConfig
} from "./types.js";
import {
  ensureDir,
  fileExists,
  isPathWithin,
  listFilesRecursive,
  normalizeKnowledgeLabelKey,
  normalizeWhitespace,
  readJsonFile,
  sha256,
  slugify,
  slugifyKnowledgeLabel,
  toPosix,
  truncate,
  uniqueBy,
  writeFileIfChanged,
  writeJsonFile
} from "./utils.js";
import { getWebSearchAdapterForTask } from "./web-search/registry.js";

type QueryExecutionResult = {
  answer: string;
  citations: string[];
  relatedPageIds: string[];
  relatedNodeIds: string[];
  relatedSourceIds: string[];
  schemaHash: string;
  projectIds: string[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  evidenceState?: QueryResult["evidenceState"];
  groundingWarnings?: string[];
  invalidCitations?: string[];
  recommendedNextTool?: QueryResult["recommendedNextTool"];
  toolRouting?: QueryResult["toolRouting"];
  answerBasis?: QueryResult["answerBasis"];
  currentStatus?: string;
  dataToolHints?: string[];
  agentDecision?: QueryResult["agentDecision"];
  evidenceSet?: QueryResult["evidenceSet"];
  primaryEvidenceSet?: QueryResult["primaryEvidenceSet"];
  supportingEvidenceSet?: QueryResult["supportingEvidenceSet"];
  excludedEvidenceSet?: QueryResult["excludedEvidenceSet"];
  standardCoverage?: QueryResult["standardCoverage"];
  evidenceCompleteness?: QueryResult["evidenceCompleteness"];
  temporalIntent?: QueryResult["temporalIntent"];
  retrievalDebug?: RetrievalDebugInfo;
  scopeAudit?: QueryResult["scopeAudit"];
};

type PersistedOutputPageResult = {
  page: GraphPage;
  savedPath: string;
  outputAssets: OutputAsset[];
};

type GeneratedOutputArtifacts = {
  answer: string;
  outputAssets: OutputAsset[];
  assetFiles: Array<{
    relativePath: string;
    content: string | Uint8Array;
    encoding?: BufferEncoding;
  }>;
};

type ProjectEntry = {
  id: string;
  roots: string[];
  schemaPath?: string;
};

type CandidateHistoryEntry = NonNullable<CompileState["candidateHistory"][string]>;
type ManagedPageRecord = {
  page: GraphPage;
  content: string;
};

const COMPILE_PROGRESS_THRESHOLD = 120;
const COMPILE_PROGRESS_UPDATE_INTERVAL = 50;

function uniqueStrings(values: string[]): string[] {
  return uniqueBy(values.filter(Boolean), (value) => value);
}

function createCompileProgressReporter(
  phase: string,
  totalItems: number
): { tick: (label?: string) => void; finish: (summary?: string) => void } {
  if (totalItems < COMPILE_PROGRESS_THRESHOLD || !process.stderr?.isTTY) {
    return {
      tick: () => {},
      finish: () => {}
    };
  }

  let completed = 0;
  let nextUpdate = Math.min(COMPILE_PROGRESS_UPDATE_INTERVAL, totalItems);
  process.stderr.write(`[swarmvault compile] ${phase}: 0/${totalItems}\n`);

  return {
    tick: (label) => {
      completed += 1;
      if (completed >= nextUpdate || completed === totalItems) {
        process.stderr.write(`[swarmvault compile] ${phase}: ${completed}/${totalItems}${label ? ` (${label})` : ""}\n`);
        while (completed >= nextUpdate) {
          nextUpdate += COMPILE_PROGRESS_UPDATE_INTERVAL;
        }
      }
    },
    finish: (summary) => {
      process.stderr.write(`[swarmvault compile] ${phase}: ${totalItems}/${totalItems}${summary ? ` (${summary})` : ""}\n`);
    }
  };
}

function normalizeOutputFormat(format: OutputFormat | undefined): OutputFormat {
  return format === "report" || format === "slides" || format === "chart" || format === "image" ? format : "markdown";
}

function outputFormatInstruction(format: OutputFormat): string {
  switch (format) {
    case "report":
      return "Return a concise markdown report with a title, a brief summary, key findings, and cited evidence.";
    case "slides":
      return "Return Marp-compatible markdown slide content with short slide titles, `---` separators, and cited evidence. Do not include YAML frontmatter.";
    case "chart":
      return "Return concise markdown that explains the key visual takeaway for a chart and cites the supporting source IDs.";
    case "image":
      return "Return concise markdown that explains the key visual takeaway for an illustrative image and cites the supporting source IDs.";
    default:
      return "Return concise markdown grounded in the provided context with cited evidence.";
  }
}

function outputAssetPath(slug: string, fileName: string): string {
  return toPosix(path.join("outputs", "assets", slug, fileName));
}

function outputAssetId(slug: string, role: OutputAsset["role"]): string {
  return `output:${slug}:asset:${role}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    case "application/json":
      return "json";
    default:
      return "bin";
  }
}

function defaultChartSpec(question: string, answer: string, citations: string[], relatedPageCount: number, relatedNodeCount: number) {
  return {
    kind: "bar" as const,
    title: question,
    subtitle: truncate(normalizeWhitespace(answer), 120),
    xLabel: "Metric",
    yLabel: "Count",
    seriesLabel: "Vault context",
    data: [
      { label: "Citations", value: citations.length },
      { label: "Pages", value: relatedPageCount },
      { label: "Nodes", value: relatedNodeCount }
    ],
    notes: citations.length ? [`Sources: ${citations.join(", ")}`] : ["No citations recorded."]
  };
}

function defaultSceneSpec(question: string, answer: string, citations: string[]): z.infer<typeof sceneSpecSchema> {
  const summary = truncate(normalizeWhitespace(answer), 140);
  const citationLine = citations.length ? `Sources: ${citations.join(", ")}` : "No citations recorded.";
  return {
    title: question,
    alt: `${question}. ${summary}`,
    background: "#f8fafc",
    width: 1200,
    height: 720,
    elements: [
      {
        kind: "shape",
        shape: "rect",
        x: 48,
        y: 112,
        width: 1104,
        height: 220,
        fill: "#dbeafe",
        stroke: "#0ea5e9",
        strokeWidth: 3
      },
      {
        kind: "label",
        x: 78,
        y: 170,
        text: "Vault Summary",
        fontSize: 30,
        fill: "#0f172a"
      },
      {
        kind: "label",
        x: 78,
        y: 218,
        text: summary,
        fontSize: 22,
        fill: "#1e293b"
      },
      {
        kind: "shape",
        shape: "rect",
        x: 48,
        y: 372,
        width: 520,
        height: 210,
        fill: "#ecfccb",
        stroke: "#65a30d",
        strokeWidth: 3
      },
      {
        kind: "label",
        x: 78,
        y: 430,
        text: `Citations: ${citations.length}`,
        fontSize: 28,
        fill: "#14532d"
      },
      {
        kind: "label",
        x: 78,
        y: 476,
        text: citationLine,
        fontSize: 20,
        fill: "#166534"
      },
      {
        kind: "shape",
        shape: "circle",
        x: 864,
        y: 478,
        radius: 116,
        fill: "#fee2e2",
        stroke: "#ef4444",
        strokeWidth: 4
      },
      {
        kind: "label",
        x: 792,
        y: 470,
        text: "Image",
        fontSize: 34,
        fill: "#7f1d1d"
      },
      {
        kind: "label",
        x: 754,
        y: 512,
        text: "Fallback",
        fontSize: 26,
        fill: "#991b1b"
      }
    ]
  };
}

async function resolveImageGenerationProvider(rootDir: string) {
  const { config } = await loadVaultConfig(rootDir);
  const preferredProviderId = config.tasks.imageProvider;
  if (!preferredProviderId) {
    return getProviderForTask(rootDir, "queryProvider");
  }
  const providerConfig = config.providers[preferredProviderId];
  if (!providerConfig) {
    throw new Error(`No provider configured with id "${preferredProviderId}" for task "imageProvider".`);
  }
  const { createProvider } = await import("./providers/registry.js");
  return createProvider(preferredProviderId, providerConfig, rootDir);
}

async function generateOutputArtifacts(
  rootDir: string,
  input: {
    slug: string;
    title: string;
    question: string;
    answer: string;
    citations: string[];
    format: OutputFormat;
    relatedPageCount: number;
    relatedNodeCount: number;
    projectId?: string | null;
  }
): Promise<GeneratedOutputArtifacts> {
  if (input.format !== "chart" && input.format !== "image") {
    return {
      answer: input.answer,
      outputAssets: [],
      assetFiles: []
    };
  }

  const schemas = await loadVaultSchemas(rootDir);
  const schema = getEffectiveSchema(schemas, input.projectId ?? null);

  if (input.format === "chart") {
    const provider = await getProviderForTask(rootDir, "queryProvider");
    const chartSpec =
      provider.type === "heuristic"
        ? defaultChartSpec(input.question, input.answer, input.citations, input.relatedPageCount, input.relatedNodeCount)
        : await provider.generateStructured(
            {
              system: buildSchemaPrompt(
                schema,
                "Create a grounded chart spec. Use only the supplied answer and citations. Prefer simple bar or line charts with 2-12 points."
              ),
              prompt: [
                `Question: ${input.question}`,
                "",
                "Answer:",
                input.answer,
                "",
                `Citations: ${input.citations.join(", ") || "none"}`,
                `Related pages: ${input.relatedPageCount}`,
                `Related nodes: ${input.relatedNodeCount}`
              ].join("\n")
            },
            chartSpecSchema
          );
    const rendered = renderChartSvg(chartSpec);
    const primaryAsset: OutputAsset = {
      id: outputAssetId(input.slug, "primary"),
      role: "primary",
      path: outputAssetPath(input.slug, "primary.svg"),
      mimeType: "image/svg+xml",
      width: rendered.width,
      height: rendered.height
    };
    const manifestAsset: OutputAsset = {
      id: outputAssetId(input.slug, "manifest"),
      role: "manifest",
      path: outputAssetPath(input.slug, "manifest.json"),
      mimeType: "application/json"
    };
    const outputAssets = [primaryAsset, manifestAsset];
    return {
      answer: input.answer,
      outputAssets,
      assetFiles: [
        { relativePath: primaryAsset.path, content: rendered.svg, encoding: "utf8" },
        {
          relativePath: manifestAsset.path,
          content: buildOutputAssetManifest({
            slug: input.slug,
            format: input.format,
            question: input.question,
            title: input.title,
            citations: input.citations,
            answer: input.answer,
            assets: outputAssets,
            spec: chartSpec
          }),
          encoding: "utf8"
        }
      ]
    };
  }

  const imageProvider = await resolveImageGenerationProvider(rootDir);
  const nativePrompt = [
    `Create a single grounded illustration for: ${input.question}`,
    "",
    "Use only the supplied vault context.",
    input.answer,
    "",
    `Citations: ${input.citations.join(", ") || "none"}`
  ].join("\n");

  if (imageProvider.capabilities.has("image_generation") && typeof imageProvider.generateImage === "function") {
    try {
      const image = await imageProvider.generateImage({
        prompt: nativePrompt,
        system: buildSchemaPrompt(schema, "Create one grounded image prompt. Avoid text-heavy diagrams."),
        width: 1200,
        height: 720
      });
      const extension = extensionForMimeType(image.mimeType);
      const primaryAsset: OutputAsset = {
        id: outputAssetId(input.slug, "primary"),
        role: "primary",
        path: outputAssetPath(input.slug, `primary.${extension}`),
        mimeType: image.mimeType,
        width: image.width,
        height: image.height
      };
      const poster = renderRasterPosterSvg({
        title: input.title,
        alt: image.revisedPrompt ?? input.answer,
        rasterFileName: `primary.${extension}`,
        width: image.width,
        height: image.height
      });
      const posterAsset: OutputAsset = {
        id: outputAssetId(input.slug, "poster"),
        role: "poster",
        path: outputAssetPath(input.slug, "poster.svg"),
        mimeType: "image/svg+xml",
        width: poster.width,
        height: poster.height
      };
      const manifestAsset: OutputAsset = {
        id: outputAssetId(input.slug, "manifest"),
        role: "manifest",
        path: outputAssetPath(input.slug, "manifest.json"),
        mimeType: "application/json"
      };
      const outputAssets = [primaryAsset, posterAsset, manifestAsset];
      return {
        answer: input.answer,
        outputAssets,
        assetFiles: [
          { relativePath: primaryAsset.path, content: image.bytes },
          { relativePath: posterAsset.path, content: poster.svg, encoding: "utf8" },
          {
            relativePath: manifestAsset.path,
            content: buildOutputAssetManifest({
              slug: input.slug,
              format: input.format,
              question: input.question,
              title: input.title,
              citations: input.citations,
              answer: input.answer,
              assets: outputAssets,
              spec: {
                mode: "native",
                prompt: nativePrompt,
                revisedPrompt: image.revisedPrompt
              }
            }),
            encoding: "utf8"
          }
        ]
      };
    } catch {
      // Fall back to deterministic SVG scene generation below.
    }
  }

  const sceneSpec =
    imageProvider.type === "heuristic"
      ? defaultSceneSpec(input.question, input.answer, input.citations)
      : await imageProvider.generateStructured(
          {
            system: buildSchemaPrompt(
              schema,
              "Create a grounded SVG scene spec with shapes and short labels only. Avoid inventing unsupported details."
            ),
            prompt: nativePrompt
          },
          sceneSpecSchema
        );
  const renderedScene = renderSceneSvg(sceneSpec);
  const primaryAsset: OutputAsset = {
    id: outputAssetId(input.slug, "primary"),
    role: "primary",
    path: outputAssetPath(input.slug, "primary.svg"),
    mimeType: "image/svg+xml",
    width: renderedScene.width,
    height: renderedScene.height
  };
  const manifestAsset: OutputAsset = {
    id: outputAssetId(input.slug, "manifest"),
    role: "manifest",
    path: outputAssetPath(input.slug, "manifest.json"),
    mimeType: "application/json"
  };
  const outputAssets = [primaryAsset, manifestAsset];
  return {
    answer: input.answer,
    outputAssets,
    assetFiles: [
      { relativePath: primaryAsset.path, content: renderedScene.svg, encoding: "utf8" },
      {
        relativePath: manifestAsset.path,
        content: buildOutputAssetManifest({
          slug: input.slug,
          format: input.format,
          question: input.question,
          title: input.title,
          citations: input.citations,
          answer: input.answer,
          assets: outputAssets,
          spec: sceneSpec
        }),
        encoding: "utf8"
      }
    ]
  };
}

function normalizeProjectRoot(root: string): string {
  const normalized = toPosix(path.posix.normalize(root.replace(/\\/g, "/")))
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  return normalized;
}

function projectEntries(config: VaultConfig): ProjectEntry[] {
  return Object.entries(config.projects ?? {})
    .map(([id, project]) => ({
      id,
      roots: uniqueStrings(project.roots.map(normalizeProjectRoot)).filter(Boolean),
      schemaPath: project.schemaPath
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function projectConfigHash(config: VaultConfig): string {
  return sha256(
    JSON.stringify(
      projectEntries(config).map((project) => ({
        id: project.id,
        roots: project.roots,
        schemaPath: project.schemaPath ?? null
      }))
    )
  );
}

function manifestPathForProject(rootDir: string, manifest: SourceManifest): string {
  const rawPath = manifest.originalPath ?? manifest.storedPath;
  if (!rawPath) {
    return toPosix(manifest.storedPath);
  }
  if (!path.isAbsolute(rawPath)) {
    return normalizeProjectRoot(rawPath);
  }
  const relative = toPosix(path.relative(rootDir, rawPath));
  return relative.startsWith("..") ? toPosix(rawPath) : normalizeProjectRoot(relative);
}

function prefixMatches(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function resolveSourceProjectId(rootDir: string, manifest: SourceManifest, config: VaultConfig): string | null {
  const comparablePath = manifestPathForProject(rootDir, manifest);
  let best: { id: string; length: number } | null = null;
  for (const project of projectEntries(config)) {
    for (const root of project.roots) {
      if (!root || !prefixMatches(comparablePath, root)) {
        continue;
      }
      if (!best || root.length > best.length || (root.length === best.length && project.id.localeCompare(best.id) < 0)) {
        best = { id: project.id, length: root.length };
      }
    }
  }
  return best?.id ?? null;
}

function resolveSourceProjects(rootDir: string, manifests: SourceManifest[], config: VaultConfig): Record<string, string | null> {
  return Object.fromEntries(manifests.map((manifest) => [manifest.sourceId, resolveSourceProjectId(rootDir, manifest, config)]));
}

function scopedProjectIdsFromSources(sourceIds: string[], sourceProjects: Record<string, string | null>): string[] {
  const projectIds = uniqueStrings(sourceIds.map((sourceId) => sourceProjects[sourceId] ?? "").filter(Boolean));
  return projectIds.length === 1 ? projectIds : [];
}

function schemaProjectIdsFromPages(pageIds: string[], pageMap: Map<string, GraphPage>): string[] {
  return uniqueStrings(
    pageIds
      .flatMap((pageId) => pageMap.get(pageId)?.projectIds ?? [])
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
  );
}

function categoryTagsForSchema(schema: { content: string }, texts: string[]): string[] {
  const haystack = normalizeWhitespace(texts.filter(Boolean).join(" ")).toLowerCase();
  if (!haystack) {
    return [];
  }
  return uniqueStrings(
    schemaCategoryLabels({ path: "", hash: "", content: schema.content })
      .filter((label) => haystack.includes(label.toLowerCase()))
      .map((label) => `category/${slugify(label)}`)
  ).slice(0, 3);
}

function effectiveHashForProject(schemas: LoadedVaultSchemas, projectId: string | null): string {
  return getEffectiveSchema(schemas, projectId).hash;
}

function previousGlobalSchemaHash(previousState: CompileState | null | undefined): string {
  return (
    previousState?.effectiveSchemaHashes?.global ??
    (previousState as { schemaHash?: string } | null)?.schemaHash ??
    previousState?.rootSchemaHash ??
    ""
  );
}

function previousProjectSchemaHash(previousState: CompileState | null | undefined, projectId: string | null): string {
  if (!projectId) {
    return previousGlobalSchemaHash(previousState);
  }
  return (
    previousState?.effectiveSchemaHashes?.projects?.[projectId] ??
    previousState?.projectSchemaHashes?.[projectId] ??
    previousGlobalSchemaHash(previousState)
  );
}

function expectedSchemaHashForPage(
  page: GraphPage,
  schemas: LoadedVaultSchemas,
  pageMap: Map<string, GraphPage>,
  sourceProjects: Record<string, string | null>
): string {
  if (page.kind === "source" || page.kind === "module" || page.kind === "concept" || page.kind === "entity") {
    return effectiveHashForProject(schemas, scopedProjectIdsFromSources(page.sourceIds, sourceProjects)[0] ?? null);
  }
  if (page.kind === "output") {
    const projectIds = schemaProjectIdsFromPages(page.relatedPageIds, pageMap);
    if (projectIds.length) {
      return composeVaultSchema(
        schemas.root,
        projectIds
          .map((projectId) => schemas.projects[projectId])
          .filter((schema): schema is NonNullable<typeof schema> => Boolean(schema?.hash))
      ).hash;
    }
    return effectiveHashForProject(
      schemas,
      scopedProjectIdsFromSources(page.relatedSourceIds.length ? page.relatedSourceIds : page.sourceIds, sourceProjects)[0] ?? null
    );
  }
  if (page.path === "projects/index.md" || page.kind === "insight") {
    return schemas.effective.global.hash;
  }
  if (page.path.startsWith("projects/") && page.path.endsWith("/index.md")) {
    const projectId = page.projectIds[0] ?? page.path.split("/")[1] ?? null;
    return effectiveHashForProject(schemas, projectId);
  }
  return schemas.effective.global.hash;
}

function formatHeuristicAnswer(
  question: string,
  excerpts: string[],
  rawExcerpts: string[],
  searchResults: SearchResult[],
  format: OutputFormat
): string {
  switch (format) {
    case "report":
      return [
        `# Report: ${question}`,
        "",
        "## Summary",
        "",
        searchResults.length
          ? `The vault surfaces ${searchResults.length} relevant page(s) for this question.`
          : "No relevant pages found yet.",
        "",
        "## Relevant Pages",
        "",
        ...(searchResults.length ? searchResults.map((result) => `- ${result.title} (${result.path})`) : ["- None found."]),
        "",
        "## Evidence",
        "",
        ...(excerpts.length ? excerpts : ["No wiki evidence available yet."]),
        ...(rawExcerpts.length ? ["", "## Raw Sources", "", ...rawExcerpts] : []),
        ""
      ].join("\n");
    case "slides":
      return [
        `# ${question}`,
        "",
        searchResults.length ? `- ${searchResults.length} relevant page(s) found` : "- No relevant pages found yet",
        "---",
        "",
        "# Key Pages",
        "",
        ...(searchResults.length ? searchResults.map((result) => `- ${result.title}`) : ["- None found."]),
        ...(rawExcerpts.length
          ? [
              "---",
              "",
              "# Raw Sources",
              "",
              ...rawExcerpts.map((excerpt) => `- ${truncate(normalizeWhitespace(excerpt.replace(/^#.*\n/, "")), 140)}`)
            ]
          : []),
        ""
      ].join("\n");
    default:
      return [
        `Question: ${question}`,
        "",
        "Relevant pages:",
        ...searchResults.map((result) => `- ${result.title} (${result.path})`),
        "",
        excerpts.length ? excerpts.join("\n\n") : "No relevant pages found yet.",
        ...(rawExcerpts.length ? ["", "Raw source material:", "", ...rawExcerpts] : [])
      ].join("\n");
  }
}

function jaccardSimilarity(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) {
    return 1;
  }
  const intersection = [...leftSet].filter((item) => rightSet.has(item));
  return intersection.length / union.size;
}

function aggregateTopicQuality(
  name: string,
  sourceAnalyses: SourceAnalysis[]
): { score: number; flags: string[]; decision: "promote" | "candidate_only" | "index_only" | "reject" } {
  const quality = evaluateKnowledgeCandidateQuality({
    title: name,
    kind: "concept",
    descriptions: sourceAnalyses.flatMap((analysis) => [
      analysis.summary,
      ...analysis.concepts.filter((item) => item.name === name).map((item) => item.description),
      ...analysis.entities.filter((item) => item.name === name).map((item) => item.description)
    ]),
    sourceIds: sourceAnalyses.map((analysis) => analysis.sourceId),
    authorityLayers: sourceAnalyses.map((analysis) => analysis.domain?.authorityLayer ?? "unknown"),
    documentRoles: sourceAnalyses.map((analysis) => analysis.domain?.documentRole ?? "unknown")
  });
  const decision = quality.severity === "ok" ? "promote" : quality.severity;
  const flags = quality.reasons;
  const score = quality.score;
  return { score, flags, decision };
}

function shouldPromoteCandidate(
  previous: CandidateHistoryEntry | undefined,
  sourceIds: string[],
  name: string,
  sourceAnalyses: SourceAnalysis[]
): boolean {
  const quality = aggregateTopicQuality(name, sourceAnalyses);
  if (quality.decision !== "promote") {
    return false;
  }
  return Boolean(previous && previous.status === "candidate" && jaccardSimilarity(previous.sourceIds, sourceIds) >= 0.5);
}

function activeAggregatePath(kind: "concept" | "entity", slug: string): string {
  return kind === "entity" ? `entities/${slug}.md` : `concepts/${slug}.md`;
}

function approvalSummary(manifest: ApprovalManifest): ApprovalSummary {
  return {
    approvalId: manifest.approvalId,
    createdAt: manifest.createdAt,
    bundleType: manifest.bundleType,
    title: manifest.title,
    sourceSessionId: manifest.sourceSessionId,
    entryCount: manifest.entries.length,
    pendingCount: manifest.entries.filter((entry) => entry.status === "pending").length,
    acceptedCount: manifest.entries.filter((entry) => entry.status === "accepted").length,
    rejectedCount: manifest.entries.filter((entry) => entry.status === "rejected").length
  };
}

function pageSlug(page: Pick<GraphPage, "id">): string {
  return page.id.includes(":") ? page.id.slice(page.id.indexOf(":") + 1) : slugify(page.id);
}

function candidateActivePath(page: Pick<GraphPage, "kind" | "id">): string {
  if (page.kind !== "concept" && page.kind !== "entity") {
    throw new Error(`Only concept and entity candidates can be promoted: ${page.id}`);
  }
  return activeAggregatePath(page.kind, pageSlug(page));
}

async function cleanupStaleAggregatePages(wikiDir: string, activePageIds: Set<string>): Promise<string[]> {
  const aggregateRoots = ["concepts", "entities", path.join("candidates", "concepts"), path.join("candidates", "entities")];
  const archived: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const root of aggregateRoots) {
    const absoluteRoot = path.join(wikiDir, root);
    const files = await listFilesRecursive(absoluteRoot).catch(() => []);
    for (const absolutePath of files) {
      if (!absolutePath.endsWith(".md")) {
        continue;
      }
      const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
      if (!raw) {
        continue;
      }
      const parsed = matter(raw);
      const kind = parsed.data.kind;
      const pageId = typeof parsed.data.page_id === "string" ? parsed.data.page_id : "";
      if ((kind !== "concept" && kind !== "entity") || parsed.data.managed_by !== "system" || !pageId || activePageIds.has(pageId)) {
        continue;
      }
      const relativePath = toPosix(path.relative(wikiDir, absolutePath));
      const archivePath = path.join(wikiDir, ".stale", stamp, relativePath);
      await ensureDir(path.dirname(archivePath));
      await fs.rename(absolutePath, archivePath).catch(async () => {
        await fs.rm(absolutePath, { force: true });
      });
      archived.push(relativePath);
    }
  }
  return archived;
}

function buildCommunityId(seed: string, index: number): string {
  const slug = slugify(seed) || "cluster";
  return `community:${slug}-${index + 1}`;
}

function pageHashes(pages: Array<{ page: GraphPage; contentHash: string }>): Record<string, string> {
  return Object.fromEntries(pages.map((page) => [page.page.id, page.contentHash]));
}

async function buildManagedGraphPage(
  absolutePath: string,
  defaults: {
    status?: PageStatus;
    managedBy: PageManager;
    confidence: number;
    compiledFrom: string[];
    statePathCandidates?: string[];
  },
  build: (metadata: ManagedGraphPageMetadata, existingContent?: string | null) => { page: GraphPage; content: string }
): Promise<{ page: GraphPage; content: string }> {
  const existingContent = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
  let carriedContent = existingContent;
  let existing = await loadExistingManagedPageState(absolutePath, {
    status: defaults.status ?? "active",
    managedBy: defaults.managedBy
  });
  let usedFallbackState = false;
  if (!existingContent && defaults.statePathCandidates?.length) {
    for (const candidatePath of defaults.statePathCandidates) {
      if (candidatePath === absolutePath || !(await fileExists(candidatePath))) {
        continue;
      }
      existing = await loadExistingManagedPageState(candidatePath, {
        status: defaults.status ?? "active",
        managedBy: defaults.managedBy
      });
      carriedContent = await fs.readFile(candidatePath, "utf8");
      usedFallbackState = true;
      break;
    }
  }

  let metadata: ManagedGraphPageMetadata = {
    status: usedFallbackState && defaults.status ? defaults.status : existing.status,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
    compiledFrom: defaults.compiledFrom,
    managedBy: defaults.managedBy,
    confidence: defaults.confidence
  };
  let built = build(metadata, carriedContent);

  if (carriedContent && carriedContent !== built.content) {
    metadata = {
      ...metadata,
      updatedAt: new Date().toISOString()
    };
    built = build(metadata, carriedContent);
  }

  return built;
}

async function buildManagedContent(
  absolutePath: string,
  defaults: {
    status?: PageStatus;
    managedBy: PageManager;
    compiledFrom: string[];
    statePathCandidates?: string[];
  },
  build: (metadata: ManagedPageMetadata) => string
): Promise<string> {
  const existingContent = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
  let existing = await loadExistingManagedPageState(absolutePath, {
    status: defaults.status ?? "active",
    managedBy: defaults.managedBy
  });
  let usedFallbackState = false;
  if (!existingContent && defaults.statePathCandidates?.length) {
    for (const candidatePath of defaults.statePathCandidates) {
      if (candidatePath === absolutePath || !(await fileExists(candidatePath))) {
        continue;
      }
      existing = await loadExistingManagedPageState(candidatePath, {
        status: defaults.status ?? "active",
        managedBy: defaults.managedBy
      });
      usedFallbackState = true;
      break;
    }
  }

  let metadata: ManagedPageMetadata = {
    status: usedFallbackState && defaults.status ? defaults.status : existing.status,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
    compiledFrom: defaults.compiledFrom,
    managedBy: defaults.managedBy
  };
  let content = build(metadata);

  if (existingContent && existingContent !== content) {
    metadata = {
      ...metadata,
      updatedAt: new Date().toISOString()
    };
    content = build(metadata);
  }

  return content;
}

function manifestDetailValue(manifest: SourceManifest, key: string): string | undefined {
  const value = manifest.details?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function loadAnalysesBySourceIds(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  sourceIds: string[]
): Promise<SourceAnalysis[]> {
  const analyses = await Promise.all(
    sourceIds.map(async (sourceId) => await readJsonFile<SourceAnalysis>(path.join(paths.analysesDir, `${sourceId}.json`)))
  );
  return analyses.filter((analysis): analysis is SourceAnalysis => Boolean(analysis?.sourceId));
}

async function buildDashboardRecords(
  config: VaultConfig,
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  graph: GraphArtifact,
  schemaHash: string,
  report: GraphReportArtifact | null
): Promise<ManagedPageRecord[]> {
  const dataviewEnabled = config.profile.dataviewBlocks;
  const profilePresets = config.profile.presets;
  const dashboardPack = config.profile.dashboardPack;
  const sourcePages = graph.pages.filter((page) => page.kind === "source");
  const reviewPages = graph.pages.filter((page) => page.kind === "output" && page.path.startsWith("outputs/source-reviews/"));
  const briefPages = graph.pages.filter((page) => page.kind === "output" && page.path.startsWith("outputs/source-briefs/"));
  const guidePages = graph.pages.filter((page) => page.kind === "output" && page.path.startsWith("outputs/source-guides/"));
  const sessionPages = graph.pages.filter((page) => page.kind === "output" && page.path.startsWith("outputs/source-sessions/"));
  const conceptPages = graph.pages.filter((page) => page.kind === "concept" && page.status !== "candidate").slice(0, 16);
  const entityPages = graph.pages.filter((page) => page.kind === "entity" && page.status !== "candidate").slice(0, 16);
  const manifests = graph.sources;
  const manifestBySourceId = new Map(manifests.map((manifest) => [manifest.sourceId, manifest] as const));
  const timelineManifests = manifests
    .filter((manifest) => manifestDetailValue(manifest, "occurred_at"))
    .sort((left, right) => (manifestDetailValue(right, "occurred_at") ?? "").localeCompare(manifestDetailValue(left, "occurred_at") ?? ""))
    .slice(0, 25);
  const recentSourcePages = [...sourcePages].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 20);
  const analyses = await loadAnalysesBySourceIds(paths, uniqueStrings(sourcePages.flatMap((page) => page.sourceIds)));
  const openQuestions = uniqueStrings(
    analyses.flatMap((analysis) => analysis.questions.map((question) => `${analysis.title}: ${question}`))
  ).slice(0, 20);
  const sourceSessions = await listGuidedSourceSessions(paths.rootDir);
  const stagedGuideBundles = (
    await Promise.all(
      (
        await fs.readdir(paths.approvalsDir, { withFileTypes: true }).catch(() => [])
      )
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => await readApprovalManifest(paths, entry.name).catch(() => null))
    )
  )
    .filter((manifest): manifest is ApprovalManifest => Boolean(manifest))
    .filter((manifest) => manifest.bundleType === "guided-source" || manifest.bundleType === "guided-session")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 12);
  const readerFocusPages = uniqueBy([...guidePages, ...briefPages, ...conceptPages, ...entityPages], (page) => page.id).slice(0, 8);
  const diligenceSessions = sourceSessions
    .filter((session) => session.status === "staged" || session.status === "awaiting_input")
    .slice(0, 8);

  const dashboards: Array<{ relativePath: string; title: string; content: (metadata: ManagedPageMetadata) => string }> = [
    {
      relativePath: "dashboards/index.md",
      title: "Dashboards",
      content: (metadata) =>
        matter.stringify(
          [
            "# Dashboards",
            "",
            "- [[dashboards/recent-sources|Recent Sources]]",
            "- [[dashboards/reading-log|Reading Log]]",
            "- [[dashboards/timeline|Timeline]]",
            "- [[dashboards/source-sessions|Source Sessions]]",
            "- [[dashboards/source-guides|Source Guides]]",
            "- [[dashboards/research-map|Research Map]]",
            "- [[dashboards/contradictions|Contradictions]]",
            "- [[dashboards/open-questions|Open Questions]]",
            "",
            `Profile Presets: ${profilePresets.length ? profilePresets.map((preset) => `\`${preset}\``).join(", ") : "_default_"}`,
            `Dashboard Pack: \`${dashboardPack}\``,
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE file.mtime AS updated",
                  'FROM "dashboards"',
                  'WHERE file.name != "index"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:index",
            kind: "index",
            title: "Dashboards",
            tags: ["index", "dashboards"],
            source_ids: [],
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: metadata.compiledFrom,
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/recent-sources.md",
      title: "Recent Sources",
      content: (metadata) =>
        matter.stringify(
          [
            "# Recent Sources",
            "",
            ...(recentSourcePages.length
              ? recentSourcePages.map((page) => `- ${page.updatedAt}: [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No source pages yet."]),
            ...(dashboardPack === "reader" && readerFocusPages.length
              ? ["", "## Reader Focus", "", ...readerFocusPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)]
              : []),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE source_type, occurred_at, participants",
                  'FROM "sources"',
                  "SORT updated_at desc",
                  "LIMIT 25",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:recent-sources",
            kind: "index",
            title: "Recent Sources",
            tags: ["index", "dashboard", "recent-sources"],
            source_ids: recentSourcePages.flatMap((page) => page.sourceIds),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: recentSourcePages.flatMap((page) => page.sourceIds),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/reading-log.md",
      title: "Reading Log",
      content: (metadata) =>
        matter.stringify(
          [
            "# Reading Log",
            "",
            ...(timelineManifests.length
              ? timelineManifests.map((manifest) => {
                  const occurredAt = manifestDetailValue(manifest, "occurred_at") ?? manifest.updatedAt;
                  const participants = manifestDetailValue(manifest, "participants");
                  return `- ${occurredAt}: ${manifest.title}${participants ? ` (${participants})` : ""}`;
                })
              : recentSourcePages.map((page) => `- ${page.updatedAt}: [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)),
            ...(sourceSessions.length
              ? [
                  "",
                  "## Active Guided Sessions",
                  "",
                  ...sourceSessions
                    .slice(0, 8)
                    .map(
                      (session) =>
                        `- ${session.updatedAt}: \`${session.status}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`
                    )
                ]
              : []),
            ...(dashboardPack === "reader" && conceptPages.length
              ? [
                  "",
                  "## Thesis And Hub Pages",
                  "",
                  ...conceptPages.slice(0, 6).map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
                ]
              : []),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE occurred_at, source_type, participants, container_title",
                  'FROM "sources"',
                  "SORT occurred_at desc",
                  "LIMIT 25",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:reading-log",
            kind: "index",
            title: "Reading Log",
            tags: ["index", "dashboard", "reading-log"],
            source_ids: timelineManifests.map((manifest) => manifest.sourceId),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: timelineManifests.map((manifest) => manifest.sourceId),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/timeline.md",
      title: "Timeline",
      content: (metadata) =>
        matter.stringify(
          [
            "# Timeline",
            "",
            ...(timelineManifests.length
              ? timelineManifests.map((manifest) => {
                  const occurredAt = manifestDetailValue(manifest, "occurred_at") ?? manifest.updatedAt;
                  const sourcePage = sourcePages.find((page) => page.sourceIds.includes(manifest.sourceId));
                  return `- ${occurredAt}: ${sourcePage ? `[[${sourcePage.path.replace(/\.md$/, "")}|${sourcePage.title}]]` : manifest.title}`;
                })
              : ["- No timeline-aware sources yet."]),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE occurred_at, participants, container_title",
                  'FROM "sources"',
                  "WHERE occurred_at",
                  "SORT occurred_at desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:timeline",
            kind: "index",
            title: "Timeline",
            tags: ["index", "dashboard", "timeline"],
            source_ids: timelineManifests.map((manifest) => manifest.sourceId),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: timelineManifests.map((manifest) => manifest.sourceId),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/source-sessions.md",
      title: "Source Sessions",
      content: (metadata) =>
        matter.stringify(
          [
            "# Source Sessions",
            "",
            "## Active Sessions",
            "",
            ...(sourceSessions.length
              ? sourceSessions
                  .slice(0, 16)
                  .map(
                    (session) =>
                      `- ${session.updatedAt}: \`${session.status}\` \`${session.sessionId}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`
                  )
              : ["- No guided source sessions yet."]),
            "",
            "## Pending Guided Bundles",
            "",
            ...(stagedGuideBundles.length
              ? stagedGuideBundles.map(
                  (bundle) =>
                    `- ${bundle.createdAt}: \`${bundle.approvalId}\`${bundle.title ? ` ${bundle.title}` : ""} (${bundle.entries.length} staged entr${bundle.entries.length === 1 ? "y" : "ies"})`
                )
              : ["- No staged guided bundles right now."]),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE session_status, evidence_state, canonical_targets",
                  'FROM "outputs/source-sessions"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:source-sessions",
            kind: "index",
            title: "Source Sessions",
            tags: ["index", "dashboard", "source-sessions"],
            source_ids: uniqueStrings([
              ...sessionPages.flatMap((page) => page.sourceIds),
              ...sourceSessions.flatMap((session) => session.sourceIds)
            ]),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: uniqueStrings([
              ...sessionPages.flatMap((page) => page.sourceIds),
              ...sourceSessions.flatMap((session) => session.sourceIds)
            ]),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/source-guides.md",
      title: "Source Guides",
      content: (metadata) =>
        matter.stringify(
          [
            "# Source Guides",
            "",
            ...(guidePages.length
              ? guidePages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No accepted source guides yet."]),
            "",
            "## Pending Guided Bundles",
            "",
            ...(stagedGuideBundles.length
              ? stagedGuideBundles.map(
                  (bundle) =>
                    `- ${bundle.createdAt}: \`${bundle.approvalId}\`${bundle.title ? ` ${bundle.title}` : ""} (${bundle.entries.length} staged entr${bundle.entries.length === 1 ? "y" : "ies"})`
                )
              : ["- No staged guided bundles right now."]),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  "TABLE evidence_state, canonical_targets, file.mtime AS updated",
                  'FROM "outputs/source-guides"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:source-guides",
            kind: "index",
            title: "Source Guides",
            tags: ["index", "dashboard", "source-guides"],
            source_ids: uniqueStrings([
              ...guidePages.flatMap((page) => page.sourceIds),
              ...stagedGuideBundles.flatMap((bundle) => bundle.entries.flatMap((entry) => entry.sourceIds))
            ]),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: uniqueStrings([
              ...guidePages.flatMap((page) => page.sourceIds),
              ...stagedGuideBundles.flatMap((bundle) => bundle.entries.flatMap((entry) => entry.sourceIds))
            ]),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/research-map.md",
      title: "Research Map",
      content: (metadata) =>
        matter.stringify(
          [
            "# Research Map",
            "",
            "## Canonical Concept Pages",
            "",
            ...(conceptPages.length
              ? conceptPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No concept pages yet."]),
            "",
            "## Canonical Entity Pages",
            "",
            ...(entityPages.length
              ? entityPages.map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No entity pages yet."]),
            "",
            "## Recently Guided Sources",
            "",
            ...(guidePages.length
              ? guidePages.slice(0, 8).map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`)
              : ["- No accepted source guides yet."]),
            "",
            "## Active Source Sessions",
            "",
            ...(sourceSessions.length
              ? sourceSessions
                  .slice(0, 8)
                  .map((session) => `- \`${session.status}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`)
              : ["- No active source sessions yet."]),
            ...(report?.suggestedQuestions?.length
              ? ["", "## Suggested Questions", "", ...report.suggestedQuestions.slice(0, 8).map((question) => `- ${question}`)]
              : []),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  'TABLE file.folder, file.mtime FROM "concepts" OR "entities"',
                  "SORT file.mtime desc",
                  "LIMIT 30",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:research-map",
            kind: "index",
            title: "Research Map",
            tags: ["index", "dashboard", "research-map"],
            source_ids: uniqueStrings([
              ...conceptPages.flatMap((page) => page.sourceIds),
              ...entityPages.flatMap((page) => page.sourceIds),
              ...guidePages.flatMap((page) => page.sourceIds)
            ]),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: uniqueStrings([
              ...conceptPages.flatMap((page) => page.sourceIds),
              ...entityPages.flatMap((page) => page.sourceIds),
              ...guidePages.flatMap((page) => page.sourceIds)
            ]),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/contradictions.md",
      title: "Contradictions",
      content: (metadata) =>
        matter.stringify(
          [
            "# Contradictions",
            "",
            ...(report?.contradictions.length
              ? report.contradictions.map((contradiction) => {
                  const left = manifestBySourceId.get(contradiction.sourceIdA)?.title ?? contradiction.sourceIdA;
                  const right = manifestBySourceId.get(contradiction.sourceIdB)?.title ?? contradiction.sourceIdB;
                  return `- ${left} / ${right}: ${contradiction.claimA} <> ${contradiction.claimB}`;
                })
              : ["- No contradictions are currently flagged."]),
            "",
            ...(reviewPages.length || briefPages.length || guidePages.length
              ? [
                  "## Related Reviews",
                  "",
                  ...[...guidePages, ...reviewPages, ...briefPages]
                    .slice(0, 12)
                    .map((page) => `- [[${page.path.replace(/\.md$/, "")}|${page.title}]]`),
                  ""
                ]
              : []),
            ...(dashboardPack === "diligence" && diligenceSessions.length
              ? [
                  "## Active Evidence Review Sessions",
                  "",
                  ...diligenceSessions.map(
                    (session) => `- \`${session.status}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`
                  ),
                  ""
                ]
              : []),
            ...(dataviewEnabled
              ? [
                  "```dataview",
                  'TABLE evidence_state, session_status, canonical_targets FROM "outputs/source-reviews" OR "outputs/source-guides" OR "outputs/source-sessions"',
                  'WHERE evidence_state = "conflicting"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:contradictions",
            kind: "index",
            title: "Contradictions",
            tags: ["index", "dashboard", "contradictions"],
            source_ids: report?.contradictions.flatMap((item) => [item.sourceIdA, item.sourceIdB]) ?? [],
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: report?.contradictions.flatMap((item) => [item.sourceIdA, item.sourceIdB]) ?? [],
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    },
    {
      relativePath: "dashboards/open-questions.md",
      title: "Open Questions",
      content: (metadata) =>
        matter.stringify(
          [
            "# Open Questions",
            "",
            ...(openQuestions.length ? openQuestions.map((question) => `- ${question}`) : ["- No open questions are currently extracted."]),
            ...(sourceSessions.length
              ? [
                  "",
                  "## Active Guided Sessions",
                  "",
                  ...sourceSessions
                    .filter((session) => session.status === "awaiting_input" || session.status === "staged")
                    .slice(0, 8)
                    .map((session) => `- \`${session.status}\` [[outputs/source-sessions/${session.scopeId}|${session.scopeTitle}]]`)
                ]
              : []),
            ...(dataviewEnabled
              ? [
                  "",
                  "```dataview",
                  'TABLE question_state, session_status, evidence_state FROM "outputs/source-briefs" OR "outputs/source-reviews" OR "outputs/source-guides" OR "outputs/source-sessions"',
                  "SORT file.mtime desc",
                  "```"
                ]
              : []),
            ""
          ].join("\n"),
          {
            page_id: "dashboards:open-questions",
            kind: "index",
            title: "Open Questions",
            tags: ["index", "dashboard", "open-questions"],
            source_ids: analyses.map((analysis) => analysis.sourceId),
            project_ids: [],
            node_ids: [],
            freshness: "fresh",
            status: metadata.status,
            confidence: 1,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: analyses.map((analysis) => analysis.sourceId),
            managed_by: metadata.managedBy,
            backlinks: [],
            schema_hash: schemaHash,
            source_hashes: {},
            source_semantic_hashes: {},
            profile_presets: profilePresets
          }
        )
    }
  ];

  const records: ManagedPageRecord[] = [];
  for (const dashboard of dashboards) {
    const absolutePath = path.join(paths.wikiDir, dashboard.relativePath);
    const compiledFrom =
      dashboard.relativePath === "dashboards/recent-sources.md" ? recentSourcePages.flatMap((page) => page.sourceIds) : [];
    const content = await buildManagedContent(
      absolutePath,
      {
        managedBy: "system",
        compiledFrom
      },
      dashboard.content
    );
    records.push({
      page: emptyGraphPage({
        id: `dashboard:${dashboard.relativePath.replace(/\.md$/, "")}`,
        path: dashboard.relativePath,
        title: dashboard.title,
        kind: "index",
        sourceIds: compiledFrom,
        nodeIds: [],
        schemaHash,
        sourceHashes: {},
        confidence: 1
      }),
      content
    });
  }
  return records;
}

function indexCompiledFrom(pages: GraphPage[]): string[] {
  return uniqueStrings(pages.flatMap((page) => page.sourceIds));
}

function autoResolution(nodeCount: number, edgeCount: number): number {
  if (nodeCount <= 20) return 0.5;
  if (edgeCount / Math.max(1, nodeCount) < 2) return 0.8;
  return 1.0;
}

function pruneDanglingEdges<E extends { source: string; target: string }>(nodes: Array<{ id: string }>, edges: E[]): E[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
}

function applyNormLabel(nodes: GraphNode[]): GraphNode[] {
  return nodes.map((node) => (node.normLabel ? node : { ...node, normLabel: computeNormLabel(node.label) }));
}

/**
 * Build a deterministic, one-line explanation for why a node shows up as a
 * god-node. Prefers the most specific signal available: degrees that cross
 * many communities get a "bridges N communities" phrasing, outliers get a
 * "NσN above mean" phrasing, and the fallback uses raw degree.
 */
function describeGodNodeReason(degree: number, communityCount: number, degreeMean: number, degreeStd: number): string {
  const parts = [`degree ${degree}`];
  if (communityCount >= 3) {
    parts.push(`across ${communityCount} communities`);
  } else if (communityCount === 2) {
    parts.push("bridges 2 communities");
  }
  if (degreeStd > 0) {
    const sigma = (degree - degreeMean) / degreeStd;
    if (sigma >= 1.5) {
      parts.push(`${sigma.toFixed(1)}σ above mean`);
    }
  }
  return parts.join(", ");
}

function deriveGraphMetrics(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options?: { resolution?: number }
): {
  nodes: GraphNode[];
  communities: GraphArtifact["communities"];
} {
  const adjacency = new Map<string, Set<string>>();
  const connect = (left: string, right: string) => {
    if (!adjacency.has(left)) {
      adjacency.set(left, new Set());
    }
    adjacency.get(left)?.add(right);
  };

  for (const edge of edges) {
    connect(edge.source, edge.target);
    connect(edge.target, edge.source);
  }

  const nonSourceNodes = nodes.filter((node) => node.type !== "source");
  for (let index = 0; index < nonSourceNodes.length; index++) {
    const left = nonSourceNodes[index];
    for (let cursor = index + 1; cursor < nonSourceNodes.length; cursor++) {
      const right = nonSourceNodes[cursor];
      if (left.sourceIds.some((sourceId) => right.sourceIds.includes(sourceId))) {
        connect(left.id, right.id);
        connect(right.id, left.id);
      }
    }
  }

  const communityMap = new Map<string, string>();
  const communities: Array<{ id: string; label: string; nodeIds: string[] }> = [];

  const nonSourceIdSet = new Set(nonSourceNodes.map((node) => node.id));

  /* Build a graphology UndirectedGraph for Louvain community detection.
     Only non-source nodes participate; edges are derived from the adjacency
     map which already includes both explicit edges and co-occurrence links. */
  const louvainGraph = new Graph({ type: "undirected" });
  for (const node of nonSourceNodes) {
    louvainGraph.addNode(node.id);
  }
  for (const node of nonSourceNodes) {
    for (const neighbor of adjacency.get(node.id) ?? []) {
      if (nonSourceIdSet.has(neighbor) && !louvainGraph.hasEdge(node.id, neighbor)) {
        louvainGraph.addEdge(node.id, neighbor);
      }
    }
  }

  /* Louvain requires at least one edge; fall back to singleton communities
     for disconnected graphs (e.g. single-source vaults). */
  const effectiveResolution = options?.resolution ?? autoResolution(louvainGraph.order, louvainGraph.size);
  const louvainMapping: Record<string, number> = louvainGraph.size > 0 ? louvain(louvainGraph, { resolution: effectiveResolution }) : {};

  /* Group nodes by their Louvain community number.  Isolated nodes (no edges)
     each get their own singleton community. */
  const groupByCommunity = new Map<number, string[]>();
  let nextIsolated = -1;
  for (const node of nonSourceNodes) {
    const communityNumber = louvainMapping[node.id] ?? nextIsolated--;
    if (!groupByCommunity.has(communityNumber)) {
      groupByCommunity.set(communityNumber, []);
    }
    groupByCommunity.get(communityNumber)!.push(node.id);
  }

  let communityIndex = 0;
  for (const memberIds of groupByCommunity.values()) {
    const labelSeed = nodes.find((candidate) => candidate.id === memberIds[0])?.label ?? `cluster-${communityIndex + 1}`;
    const communityId = buildCommunityId(labelSeed, communityIndex);
    communities.push({
      id: communityId,
      label: labelSeed,
      nodeIds: memberIds.sort((left, right) => left.localeCompare(right))
    });
    for (const memberId of memberIds) {
      communityMap.set(memberId, communityId);
    }
    communityIndex++;
  }

  const degreeMap = new Map<string, number>();
  for (const node of nodes) {
    degreeMap.set(node.id, adjacency.get(node.id)?.size ?? 0);
  }

  const degreeValues = nodes
    .filter((node) => node.type !== "source")
    .map((node) => degreeMap.get(node.id) ?? 0)
    .sort((left, right) => right - left);
  const godNodeThreshold = degreeValues[Math.max(0, Math.floor(degreeValues.length * 0.1) - 1)] ?? 0;

  // Precompute degree mean and standard deviation over the non-source
  // population so we can report how many σ above the mean each god node
  // sits. The values are deterministic and identical per graph snapshot.
  const degreeMean = degreeValues.length > 0 ? degreeValues.reduce((sum, value) => sum + value, 0) / degreeValues.length : 0;
  const degreeVariance =
    degreeValues.length > 0 ? degreeValues.reduce((sum, value) => sum + (value - degreeMean) ** 2, 0) / degreeValues.length : 0;
  const degreeStd = Math.sqrt(degreeVariance);

  const nextNodes = nodes.map((node) => {
    const neighborCommunities = new Set(
      [...(adjacency.get(node.id) ?? [])]
        .map((neighborId) => communityMap.get(neighborId) ?? communityMap.get(node.id))
        .filter((communityId): communityId is string => Boolean(communityId))
    );
    const degree = degreeMap.get(node.id) ?? 0;
    const bridgeScore = node.type === "source" ? neighborCommunities.size : Math.max(0, neighborCommunities.size - 1);
    const inferredCommunityId =
      communityMap.get(node.id) ??
      [...(adjacency.get(node.id) ?? [])]
        .map((neighborId) => communityMap.get(neighborId))
        .find((communityId): communityId is string => Boolean(communityId));
    const isGodNode = node.type !== "source" && degree >= godNodeThreshold && degree > 0;

    return {
      ...node,
      communityId: inferredCommunityId,
      degree,
      bridgeScore,
      isGodNode,
      surpriseReason: isGodNode ? describeGodNodeReason(degree, neighborCommunities.size, degreeMean, degreeStd) : undefined
    };
  });

  return {
    nodes: nextNodes,
    communities
  };
}

function resetGraphNodeMetrics(nodes: GraphNode[]): GraphNode[] {
  return nodes.map(
    ({
      communityId: _communityId,
      degree: _degree,
      bridgeScore: _bridgeScore,
      isGodNode: _isGodNode,
      surpriseReason: _surpriseReason,
      ...node
    }) => node
  );
}

type GoPackageSymbolLookup = {
  byName: Map<string, string>;
  uniqueMethodIdsByShortName: Map<string, string>;
};

function manifestRepoPath(manifest: SourceManifest): string {
  return toPosix(manifest.repoRelativePath ?? path.basename(manifest.originalPath ?? manifest.storedPath));
}

function goPackageScopeKey(manifest: SourceManifest, analysis: SourceAnalysis): string | null {
  if (analysis.code?.language !== "go") {
    return null;
  }
  const packageName = analysis.code.namespace?.trim();
  if (!packageName) {
    return null;
  }
  return `${packageName}:${path.posix.dirname(manifestRepoPath(manifest))}`;
}

function buildGoPackageSymbolLookups(
  analyses: SourceAnalysis[],
  manifestsById: Map<string, SourceManifest>
): Map<string, GoPackageSymbolLookup> {
  const lookups = new Map<
    string,
    {
      byName: Map<string, string>;
      methodIdsByShortName: Map<string, Set<string>>;
    }
  >();

  for (const analysis of analyses) {
    if (analysis.code?.language !== "go") {
      continue;
    }
    const manifest = manifestsById.get(analysis.sourceId);
    if (!manifest) {
      continue;
    }
    const scopeKey = goPackageScopeKey(manifest, analysis);
    if (!scopeKey) {
      continue;
    }
    const current = lookups.get(scopeKey) ?? {
      byName: new Map<string, string>(),
      methodIdsByShortName: new Map<string, Set<string>>()
    };

    for (const symbol of analysis.code.symbols) {
      current.byName.set(symbol.name, symbol.id);
      const separator = symbol.name.lastIndexOf(".");
      if (separator > 0) {
        const shortName = symbol.name.slice(separator + 1);
        const matches = current.methodIdsByShortName.get(shortName) ?? new Set<string>();
        matches.add(symbol.id);
        current.methodIdsByShortName.set(shortName, matches);
      }
    }

    lookups.set(scopeKey, current);
  }

  return new Map(
    [...lookups.entries()].map(([scopeKey, value]) => [
      scopeKey,
      {
        byName: value.byName,
        uniqueMethodIdsByShortName: new Map(
          [...value.methodIdsByShortName.entries()]
            .filter(([, ids]) => ids.size === 1)
            .map(([shortName, ids]) => [shortName, [...ids][0] as string])
        )
      } satisfies GoPackageSymbolLookup
    ])
  );
}

function claimTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{2,}/g)
      ?.filter((t) => !new Set(["the", "and", "for", "that", "this", "with", "are", "was", "from", "has", "not", "all", "but"]).has(t)) ??
      []
  );
}

function claimJaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

interface DetectedContradiction {
  sourceIdA: string;
  sourceIdB: string;
  claimA: { text: string; confidence: number };
  claimB: { text: string; confidence: number };
  similarity: number;
}

function detectContradictions(analyses: SourceAnalysis[]): DetectedContradiction[] {
  const contradictions: DetectedContradiction[] = [];
  const claimsWithTokens = analyses.flatMap((analysis) =>
    analysis.claims
      .filter((c) => c.polarity === "positive" || c.polarity === "negative")
      .map((c) => ({ sourceId: analysis.sourceId, claim: c, tokens: claimTokens(c.text) }))
  );

  for (let i = 0; i < claimsWithTokens.length; i++) {
    for (let j = i + 1; j < claimsWithTokens.length; j++) {
      const a = claimsWithTokens[i];
      const b = claimsWithTokens[j];
      if (a.sourceId === b.sourceId) continue;
      if (a.claim.polarity === b.claim.polarity) continue;
      const similarity = claimJaccardSimilarity(a.tokens, b.tokens);
      if (similarity >= 0.3) {
        contradictions.push({
          sourceIdA: a.sourceId,
          sourceIdB: b.sourceId,
          claimA: { text: a.claim.text, confidence: a.claim.confidence },
          claimB: { text: b.claim.text, confidence: b.claim.confidence },
          similarity
        });
      }
    }
  }

  return contradictions;
}

function buildGraph(
  manifests: SourceManifest[],
  analyses: SourceAnalysis[],
  pages: GraphPage[],
  sourceProjects: Record<string, string | null>,
  _codeIndex: CodeIndexArtifact,
  memoryTasks: AgentMemoryTask[] = [],
  options?: { communityResolution?: number; config?: VaultConfig | null }
): GraphArtifact {
  const manifestsById = new Map(manifests.map((manifest) => [manifest.sourceId, manifest]));
  const goPackageSymbolLookups = buildGoPackageSymbolLookups(analyses, manifestsById);
  const analysesBySourceId = new Map(analyses.map((analysis) => [analysis.sourceId, analysis]));
  const sourceNodes: GraphNode[] = manifests.map((manifest) => {
    const analysis = analysesBySourceId.get(manifest.sourceId);
    return {
      id: `source:${manifest.sourceId}`,
      type: "source",
      label: manifest.title,
      pageId: `source:${manifest.sourceId}`,
      freshness: "fresh",
      confidence: 1,
      sourceIds: [manifest.sourceId],
      projectIds: scopedProjectIdsFromSources([manifest.sourceId], sourceProjects),
      sourceClass: manifest.sourceClass,
      language: manifest.language,
      tags: analysis?.tags ?? []
    };
  });

  const conceptMap = new Map<string, GraphNode>();
  const entityMap = new Map<string, GraphNode>();
  const moduleMap = new Map<string, GraphNode>();
  const symbolMap = new Map<string, GraphNode>();
  const rationaleMap = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgesById = new Set<string>();

  const pushEdge = (edge: GraphEdge) => {
    if (edgesById.has(edge.id)) {
      return;
    }
    edgesById.add(edge.id);
    edges.push(edge);
  };

  for (const analysis of analyses) {
    for (const concept of analysis.concepts) {
      const existing = conceptMap.get(concept.id);
      const sourceIds = [...new Set([...(existing?.sourceIds ?? []), analysis.sourceId])];
      conceptMap.set(concept.id, {
        id: concept.id,
        type: "concept",
        label: concept.name,
        pageId: `concept:${slugifyKnowledgeLabel(concept.name)}`,
        freshness: "fresh",
        confidence: nodeConfidence(sourceIds.length),
        sourceIds,
        projectIds: scopedProjectIdsFromSources(sourceIds, sourceProjects),
        sourceClass: aggregateManifestSourceClass(manifests, sourceIds)
      });
      pushEdge({
        id: `${analysis.sourceId}->${concept.id}`,
        source: `source:${analysis.sourceId}`,
        target: concept.id,
        relation: "mentions",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: edgeConfidence(analysis.claims, concept.name),
        provenance: [analysis.sourceId]
      });
    }

    for (const entity of analysis.entities) {
      const existing = entityMap.get(entity.id);
      const sourceIds = [...new Set([...(existing?.sourceIds ?? []), analysis.sourceId])];
      entityMap.set(entity.id, {
        id: entity.id,
        type: "entity",
        label: entity.name,
        pageId: `entity:${slugifyKnowledgeLabel(entity.name)}`,
        freshness: "fresh",
        confidence: nodeConfidence(sourceIds.length),
        sourceIds,
        projectIds: scopedProjectIdsFromSources(sourceIds, sourceProjects),
        sourceClass: aggregateManifestSourceClass(manifests, sourceIds)
      });
      pushEdge({
        id: `${analysis.sourceId}->${entity.id}`,
        source: `source:${analysis.sourceId}`,
        target: entity.id,
        relation: "mentions",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: edgeConfidence(analysis.claims, entity.name),
        provenance: [analysis.sourceId]
      });
    }

    if (analysis.code) {
      const manifest = manifestsById.get(analysis.sourceId);
      if (!manifest) {
        continue;
      }

      const moduleId = analysis.code.moduleId;
      moduleMap.set(moduleId, {
        id: moduleId,
        type: "module",
        label: modulePageTitle(manifest),
        pageId: moduleId,
        freshness: "fresh",
        confidence: 1,
        sourceIds: [analysis.sourceId],
        projectIds: scopedProjectIdsFromSources([analysis.sourceId], sourceProjects),
        sourceClass: manifest.sourceClass,
        language: analysis.code.language,
        moduleId
      });

      pushEdge({
        id: `source:${analysis.sourceId}->${moduleId}:contains_code`,
        source: `source:${analysis.sourceId}`,
        target: moduleId,
        relation: "contains_code",
        status: "extracted",
        evidenceClass: "extracted",
        confidence: 1,
        provenance: [analysis.sourceId]
      });

      for (const symbol of analysis.code.symbols) {
        symbolMap.set(symbol.id, {
          id: symbol.id,
          type: "symbol",
          label: symbol.name,
          pageId: moduleId,
          freshness: "fresh",
          confidence: symbol.exported ? 0.88 : 0.74,
          sourceIds: [analysis.sourceId],
          projectIds: scopedProjectIdsFromSources([analysis.sourceId], sourceProjects),
          sourceClass: manifest.sourceClass,
          language: analysis.code.language,
          moduleId,
          symbolKind: symbol.kind
        });

        pushEdge({
          id: `${moduleId}->${symbol.id}:defines`,
          source: moduleId,
          target: symbol.id,
          relation: "defines",
          status: "extracted",
          evidenceClass: "extracted",
          confidence: 1,
          provenance: [analysis.sourceId]
        });

        if (symbol.exported) {
          pushEdge({
            id: `${moduleId}->${symbol.id}:exports`,
            source: moduleId,
            target: symbol.id,
            relation: "exports",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }
      }

      const symbolIdsByName = new Map(analysis.code.symbols.map((symbol) => [symbol.name, symbol.id]));
      const goPackageLookup =
        analysis.code.language === "go" ? goPackageSymbolLookups.get(goPackageScopeKey(manifest, analysis) ?? "") : undefined;
      const localSymbolIdsByName = goPackageLookup?.byName ?? symbolIdsByName;
      const localGoMethodIdsByShortName = goPackageLookup?.uniqueMethodIdsByShortName ?? new Map<string, string>();
      const resolveLocalSymbolId = (targetName: string): string | undefined =>
        localSymbolIdsByName.get(targetName) ??
        (analysis.code?.language === "go" ? localGoMethodIdsByShortName.get(targetName) : undefined);

      for (const rationale of analysis.rationales) {
        const targetSymbolId = rationale.symbolName ? symbolIdsByName.get(rationale.symbolName) : undefined;
        const targetId = targetSymbolId ?? moduleId;
        rationaleMap.set(rationale.id, {
          id: rationale.id,
          type: "rationale",
          label: truncate(rationale.text, 80),
          pageId: moduleId,
          freshness: "fresh",
          confidence: 1,
          sourceIds: [analysis.sourceId],
          projectIds: scopedProjectIdsFromSources([analysis.sourceId], sourceProjects),
          sourceClass: manifest.sourceClass,
          language: analysis.code.language,
          moduleId
        });
        pushEdge({
          id: `${rationale.id}->${targetId}:rationale_for`,
          source: rationale.id,
          target: targetId,
          relation: "rationale_for",
          status: "extracted",
          evidenceClass: "extracted",
          confidence: 1,
          provenance: [analysis.sourceId]
        });
      }
      const importedSymbolIdsByName = new Map<string, string>();
      for (const codeImport of analysis.code.imports.filter((item) => !item.isExternal)) {
        const targetSourceId = codeImport.resolvedSourceId;
        const targetAnalysis = targetSourceId ? analysesBySourceId.get(targetSourceId) : undefined;
        if (!targetSourceId || !targetAnalysis?.code) {
          continue;
        }

        if (codeImport.importedSymbols.length === 0) {
          for (const targetSymbol of targetAnalysis.code.symbols.filter((symbol) => symbol.exported)) {
            importedSymbolIdsByName.set(targetSymbol.name, targetSymbol.id);
          }
        }

        for (const importedSymbol of codeImport.importedSymbols) {
          const [rawExportedName, rawLocalName] = importedSymbol.split(/\s+as\s+/i);
          const exportedName = (rawExportedName ?? "").trim();
          const localName = (rawLocalName ?? rawExportedName ?? "").trim();
          if (!exportedName || !localName) {
            continue;
          }
          const targetSymbol = targetAnalysis.code.symbols.find((symbol) => symbol.name === exportedName && symbol.exported);
          if (targetSymbol) {
            importedSymbolIdsByName.set(localName, targetSymbol.id);
          }
        }
      }

      if (analysis.code.language === "go") {
        for (const symbol of analysis.code.symbols) {
          const separator = symbol.name.lastIndexOf(".");
          if (separator <= 0) {
            continue;
          }
          const receiverTypeId = localSymbolIdsByName.get(symbol.name.slice(0, separator));
          if (!receiverTypeId || receiverTypeId === symbol.id) {
            continue;
          }
          pushEdge({
            id: `${receiverTypeId}->${symbol.id}:defines:receiver`,
            source: receiverTypeId,
            target: symbol.id,
            relation: "defines",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }
      }

      for (const symbol of analysis.code.symbols) {
        for (const targetName of symbol.calls) {
          const localTargetId = resolveLocalSymbolId(targetName);
          if (localTargetId && localTargetId !== symbol.id) {
            pushEdge({
              id: `${symbol.id}->${localTargetId}:calls`,
              source: symbol.id,
              target: localTargetId,
              relation: "calls",
              status: "extracted",
              evidenceClass: "extracted",
              confidence: 1,
              provenance: [analysis.sourceId]
            });
            continue;
          }

          const crossFileTargetId = importedSymbolIdsByName.get(targetName);
          if (crossFileTargetId && crossFileTargetId !== symbol.id) {
            pushEdge({
              id: `${symbol.id}->${crossFileTargetId}:calls`,
              source: symbol.id,
              target: crossFileTargetId,
              relation: "calls",
              status: "inferred",
              evidenceClass: "inferred",
              confidence: 0.8,
              provenance: [analysis.sourceId]
            });
          }
        }

        for (const targetName of symbol.extends) {
          const targetId = resolveLocalSymbolId(targetName) ?? importedSymbolIdsByName.get(targetName);
          if (!targetId) {
            continue;
          }
          pushEdge({
            id: `${symbol.id}->${targetId}:extends`,
            source: symbol.id,
            target: targetId,
            relation: "extends",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }

        for (const targetName of symbol.implements) {
          const targetId = resolveLocalSymbolId(targetName) ?? importedSymbolIdsByName.get(targetName);
          if (!targetId) {
            continue;
          }
          pushEdge({
            id: `${symbol.id}->${targetId}:implements`,
            source: symbol.id,
            target: targetId,
            relation: "implements",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }
      }

      for (const codeImport of analysis.code.imports) {
        const targetSourceId = codeImport.resolvedSourceId;
        if (!targetSourceId) {
          continue;
        }

        const targetModuleId = `module:${targetSourceId}`;
        pushEdge({
          id: `${moduleId}->${targetModuleId}:${codeImport.reExport ? "exports" : "imports"}:${codeImport.specifier}`,
          source: moduleId,
          target: targetModuleId,
          relation: codeImport.reExport ? "exports" : "imports",
          status: "extracted",
          evidenceClass: "extracted",
          confidence: 1,
          provenance: [analysis.sourceId, targetSourceId]
        });
      }
    } else if (analysis.rationales.length) {
      // Non-code source rationales (markdown blockquote / list-item, plain
      // text paragraph) attach directly to the `source:` node. There is no
      // code symbol to target, and the `symbolName` captured from the
      // nearest preceding heading is preserved on the node for downstream
      // rendering rather than used as an edge target.
      const manifest = manifestsById.get(analysis.sourceId);
      if (manifest) {
        const sourceNodeId = `source:${analysis.sourceId}`;
        for (const rationale of analysis.rationales) {
          rationaleMap.set(rationale.id, {
            id: rationale.id,
            type: "rationale",
            label: truncate(rationale.text, 80),
            pageId: sourceNodeId,
            freshness: "fresh",
            confidence: 1,
            sourceIds: [analysis.sourceId],
            projectIds: scopedProjectIdsFromSources([analysis.sourceId], sourceProjects),
            sourceClass: manifest.sourceClass
          });
          pushEdge({
            id: `${rationale.id}->${sourceNodeId}:rationale_for`,
            source: rationale.id,
            target: sourceNodeId,
            relation: "rationale_for",
            status: "extracted",
            evidenceClass: "extracted",
            confidence: 1,
            provenance: [analysis.sourceId]
          });
        }
      }
    }
  }

  const conceptClaims = new Map<string, Array<{ claim: SourceAnalysis["claims"][number]; sourceId: string }>>();
  for (const analysis of analyses) {
    for (const claim of analysis.claims) {
      for (const concept of analysis.concepts) {
        if (claim.text.toLowerCase().includes(concept.name.toLowerCase())) {
          const key = concept.id;
          const list = conceptClaims.get(key) ?? [];
          list.push({ claim, sourceId: analysis.sourceId });
          conceptClaims.set(key, list);
        }
      }
    }
  }

  const conflictEdgeKeys = new Set<string>();
  for (const [, claimsForConcept] of conceptClaims) {
    const positive = claimsForConcept.filter((item) => item.claim.polarity === "positive");
    const negative = claimsForConcept.filter((item) => item.claim.polarity === "negative");
    for (const positiveClaim of positive) {
      for (const negativeClaim of negative) {
        if (positiveClaim.sourceId === negativeClaim.sourceId) {
          continue;
        }
        const edgeKey = [positiveClaim.sourceId, negativeClaim.sourceId].sort().join("|");
        if (conflictEdgeKeys.has(edgeKey)) {
          continue;
        }
        conflictEdgeKeys.add(edgeKey);
        pushEdge({
          id: `conflict:${positiveClaim.claim.id}->${negativeClaim.claim.id}`,
          source: `source:${positiveClaim.sourceId}`,
          target: `source:${negativeClaim.sourceId}`,
          relation: "conflicted_with",
          status: "conflicted",
          evidenceClass: "ambiguous",
          confidence: conflictConfidence(positiveClaim.claim, negativeClaim.claim),
          provenance: [positiveClaim.sourceId, negativeClaim.sourceId]
        });
      }
    }
  }

  const memoryElements = buildMemoryGraphElements(memoryTasks, pages);
  const graphNodes = [
    ...sourceNodes,
    ...moduleMap.values(),
    ...symbolMap.values(),
    ...rationaleMap.values(),
    ...conceptMap.values(),
    ...entityMap.values(),
    ...memoryElements.nodes
  ];
  const repoDefaults = resolveLargeRepoDefaults({
    nodeCount: graphNodes.length,
    config: options?.config
  });
  const enriched = enrichGraph(
    {
      generatedAt: new Date().toISOString(),
      nodes: graphNodes,
      edges: [...edges, ...memoryElements.edges],
      communities: [],
      sources: manifests,
      pages
    },
    manifests,
    analyses,
    [],
    {
      similarityIdfFloor: repoDefaults.similarityIdfFloor,
      similarityEdgeCap: repoDefaults.similarityEdgeCap
    }
  );
  const metrics = deriveGraphMetrics(graphNodes, enriched.edges, { resolution: options?.communityResolution });
  const finalNodes = applyNormLabel(metrics.nodes);
  const finalEdges = pruneDanglingEdges(finalNodes, enriched.edges);
  const finalHyperedges = (enriched.hyperedges ?? []).filter((hyperedge) => {
    const nodeIdSet = new Set(finalNodes.map((node) => node.id));
    return hyperedge.nodeIds.every((id) => nodeIdSet.has(id));
  });

  return {
    generatedAt: new Date().toISOString(),
    nodes: finalNodes,
    edges: finalEdges,
    hyperedges: finalHyperedges,
    communities: metrics.communities,
    sources: manifests,
    pages
  };
}

function recentResearchSourcePages(
  graph: GraphArtifact,
  previousCompiledAt?: string
): Array<{
  id: string;
  path: string;
  title: string;
  updatedAt: string;
  sourceType: NonNullable<GraphPage["sourceType"]>;
}> {
  const previousTimestamp = previousCompiledAt ? Date.parse(previousCompiledAt) : Number.NaN;
  return graph.pages
    .filter(
      (page): page is GraphPage & { sourceType: NonNullable<GraphPage["sourceType"]> } =>
        page.kind === "source" && Boolean(page.sourceType) && page.sourceType !== "url"
    )
    .filter((page) => Number.isNaN(previousTimestamp) || Date.parse(page.updatedAt) > previousTimestamp)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title))
    .slice(0, 8)
    .map((page) => ({
      id: page.id,
      path: page.path,
      title: page.title,
      updatedAt: page.updatedAt,
      sourceType: page.sourceType
    }));
}

async function buildGraphOrientationPages(
  graph: GraphArtifact,
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  schemaHash: string,
  previousCompiledAt?: string,
  contradictions: DetectedContradiction[] = [],
  config?: VaultConfig | null
): Promise<{ records: ManagedPageRecord[]; report: GraphReportArtifact; shareSvg: string; shareBundleFiles: GraphShareBundleFile[] }> {
  const benchmark = await readJsonFile<BenchmarkArtifact>(paths.benchmarkPath);
  const communityRecords: ManagedPageRecord[] = [];

  for (const community of graph.communities ?? []) {
    const absolutePath = path.join(paths.wikiDir, "graph", "communities", `${community.id.replace(/^community:/, "")}.md`);
    communityRecords.push(
      await buildManagedGraphPage(
        absolutePath,
        {
          managedBy: "system",
          compiledFrom: uniqueStrings(
            community.nodeIds.flatMap((nodeId) => graph.nodes.find((node) => node.id === nodeId)?.sourceIds ?? [])
          ),
          confidence: 1
        },
        (metadata) =>
          buildCommunitySummaryPage({
            graph,
            community,
            schemaHash,
            metadata
          })
      )
    );
  }

  const report = buildGraphReportArtifact({
    graph,
    communityPages: communityRecords.map((record) => record.page),
    benchmark,
    benchmarkStale: benchmark ? benchmark.graphHash !== graphHash(graph) : false,
    recentResearchSources: recentResearchSourcePages(graph, previousCompiledAt),
    graphHash: graphHash(graph),
    contradictions,
    config
  });
  const reportAbsolutePath = path.join(paths.wikiDir, "graph", "report.md");
  const reportRecord = await buildManagedGraphPage(
    reportAbsolutePath,
    {
      managedBy: "system",
      compiledFrom: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
      confidence: 1
    },
    (metadata) =>
      buildGraphReportPage({
        graph,
        schemaHash,
        metadata,
        report
      })
  );
  const shareArtifact = buildGraphShareArtifact({
    graph,
    report,
    vaultName: path.basename(paths.rootDir)
  });
  const shareRecord = await buildManagedGraphPage(
    path.join(paths.wikiDir, "graph", "share-card.md"),
    {
      managedBy: "system",
      compiledFrom: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
      confidence: 1
    },
    (metadata) =>
      buildGraphSharePage({
        graph,
        schemaHash,
        metadata,
        artifact: shareArtifact,
        report,
        vaultName: path.basename(paths.rootDir)
      })
  );

  return {
    records: [reportRecord, shareRecord, ...communityRecords],
    report,
    shareSvg: renderGraphShareSvg(shareArtifact),
    shareBundleFiles: renderGraphShareBundleFiles(shareArtifact)
  };
}

async function writePage(wikiDir: string, relativePath: string, content: string, changedPages: string[]): Promise<void> {
  const absolutePath = path.resolve(wikiDir, relativePath);
  const changed = await writeFileIfChanged(absolutePath, content);
  if (changed) {
    changedPages.push(relativePath);
  }
}

async function writeGraphShareBundle(wikiDir: string, files: GraphShareBundleFile[]): Promise<void> {
  for (const file of files) {
    await writeFileIfChanged(path.join(wikiDir, "graph", "share-kit", file.relativePath), file.content);
  }
}

function aggregateItems(
  analyses: SourceAnalysis[],
  kind: "concepts" | "entities"
): Array<{
  name: string;
  descriptions: string[];
  sourceAnalyses: SourceAnalysis[];
  sourceHashes: Record<string, string>;
  sourceSemanticHashes: Record<string, string>;
}> {
  const grouped = new Map<
    string,
    {
      name: string;
      descriptions: string[];
      sourceAnalyses: SourceAnalysis[];
      sourceHashes: Record<string, string>;
      sourceSemanticHashes: Record<string, string>;
    }
  >();

  for (const analysis of analyses) {
    for (const item of analysis[kind]) {
      const key = normalizeKnowledgeLabelKey(item.name);
      const existing = grouped.get(key) ?? {
        name: item.name,
        descriptions: [],
        sourceAnalyses: [],
        sourceHashes: {},
        sourceSemanticHashes: {}
      };
      existing.descriptions.push(item.description);
      existing.sourceAnalyses.push(analysis);
      existing.sourceHashes[analysis.sourceId] = analysis.sourceHash;
      existing.sourceSemanticHashes[analysis.sourceId] = analysis.semanticHash;
      grouped.set(key, existing);
    }
  }

  return [...grouped.values()];
}

function emptyGraphPage(input: {
  id: string;
  path: string;
  title: string;
  kind: GraphPage["kind"];
  sourceIds: string[];
  sourceClass?: SourceClass;
  projectIds?: string[];
  nodeIds: string[];
  schemaHash: string;
  sourceHashes: Record<string, string>;
  sourceSemanticHashes?: Record<string, string>;
  confidence: number;
  status?: PageStatus;
  createdAt?: string;
  updatedAt?: string;
  compiledFrom?: string[];
  managedBy?: PageManager;
}): GraphPage {
  return {
    id: input.id,
    path: input.path,
    title: input.title,
    kind: input.kind,
    sourceClass: input.sourceClass,
    sourceIds: input.sourceIds,
    projectIds: input.projectIds ?? [],
    nodeIds: input.nodeIds,
    freshness: "fresh",
    status: input.status ?? "active",
    confidence: input.confidence,
    backlinks: [],
    schemaHash: input.schemaHash,
    sourceHashes: input.sourceHashes,
    sourceSemanticHashes: input.sourceSemanticHashes ?? {},
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: input.createdAt ?? new Date().toISOString(),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    compiledFrom: input.compiledFrom ?? input.sourceIds,
    managedBy: input.managedBy ?? "system"
  };
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}

async function requiredCompileArtifactsExist(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"]): Promise<boolean> {
  const requiredPaths = [
    paths.graphPath,
    paths.codeIndexPath,
    paths.searchDbPath,
    path.join(paths.wikiDir, "index.md"),
    path.join(paths.wikiDir, "sources", "index.md"),
    path.join(paths.wikiDir, "code", "index.md"),
    path.join(paths.wikiDir, "concepts", "index.md"),
    path.join(paths.wikiDir, "entities", "index.md"),
    path.join(paths.wikiDir, "outputs", "index.md"),
    path.join(paths.wikiDir, "projects", "index.md"),
    path.join(paths.wikiDir, "candidates", "index.md")
  ];

  const checks = await Promise.all(requiredPaths.map((filePath) => fileExists(filePath)));
  return checks.every(Boolean);
}

async function loadAvailableCachedAnalyses(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  manifests: SourceManifest[]
): Promise<SourceAnalysis[]> {
  const analyses = await Promise.all(
    manifests.map(async (manifest) => readJsonFile<SourceAnalysis>(path.join(paths.analysesDir, `${manifest.sourceId}.json`)))
  );
  return analyses.filter((analysis): analysis is SourceAnalysis => Boolean(analysis));
}

function approvalManifestPath(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"], approvalId: string): string {
  return path.join(paths.approvalsDir, approvalId, "manifest.json");
}

function approvalGraphPath(paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"], approvalId: string): string {
  return path.join(paths.approvalsDir, approvalId, "state", "graph.json");
}

function normalizeApprovalBundleType(raw: string | undefined): ApprovalBundleType | undefined {
  if (!raw) return undefined;
  const legacy: Record<string, ApprovalBundleType> = {
    generated_output: "generated-output",
    source_review: "source-review",
    guided_source: "guided-source",
    guided_session: "guided-session"
  };
  return legacy[raw] ?? (raw as ApprovalBundleType);
}

async function readApprovalManifest(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  approvalId: string
): Promise<ApprovalManifest> {
  const manifest = await readJsonFile<ApprovalManifest>(approvalManifestPath(paths, approvalId));
  if (!manifest) {
    throw new Error(`Approval bundle not found: ${approvalId}`);
  }
  manifest.bundleType = normalizeApprovalBundleType(manifest.bundleType);
  return manifest;
}

async function writeApprovalManifest(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  manifest: ApprovalManifest
): Promise<void> {
  await fs.writeFile(approvalManifestPath(paths, manifest.approvalId), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function buildApprovalEntries(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  changedFiles: Array<{ relativePath: string; content: string }>,
  deletedPaths: string[],
  previousGraph: GraphArtifact | null,
  graph: GraphArtifact,
  labelsByPath: Map<string, ApprovalEntryLabel> = new Map()
): Promise<ApprovalEntry[]> {
  const previousPagesById = new Map((previousGraph?.pages ?? []).map((page) => [page.id, page]));
  const previousPagesByPath = new Map((previousGraph?.pages ?? []).map((page) => [page.path, page]));
  const nextPagesByPath = new Map(graph.pages.map((page) => [page.path, page]));
  const handledDeletedPaths = new Set<string>();
  const entries: ApprovalEntry[] = [];

  for (const file of changedFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const nextPage = nextPagesByPath.get(file.relativePath);
    if (!nextPage) {
      continue;
    }
    const previousPage = previousPagesById.get(nextPage.id);
    const currentExists = await fileExists(path.join(paths.wikiDir, file.relativePath));
    if (previousPage && previousPage.path !== nextPage.path) {
      entries.push({
        pageId: nextPage.id,
        title: nextPage.title,
        kind: nextPage.kind,
        changeType: "promote",
        status: "pending",
        sourceIds: nextPage.sourceIds,
        nextPath: nextPage.path,
        previousPath: previousPage.path,
        label: labelsByPath.get(nextPage.path) ?? labelsByPath.get(previousPage.path)
      });
      handledDeletedPaths.add(previousPage.path);
      continue;
    }

    entries.push({
      pageId: nextPage.id,
      title: nextPage.title,
      kind: nextPage.kind,
      changeType: previousPage || currentExists ? "update" : "create",
      status: "pending",
      sourceIds: nextPage.sourceIds,
      nextPath: nextPage.path,
      previousPath: previousPage?.path,
      label: labelsByPath.get(nextPage.path) ?? (previousPage?.path ? labelsByPath.get(previousPage.path) : undefined)
    });
  }

  for (const deletedPath of deletedPaths.sort((left, right) => left.localeCompare(right))) {
    if (handledDeletedPaths.has(deletedPath)) {
      continue;
    }
    const previousPage = previousPagesByPath.get(deletedPath);
    entries.push({
      pageId: previousPage?.id ?? `page:${slugify(deletedPath)}`,
      title: previousPage?.title ?? path.basename(deletedPath, ".md"),
      kind: previousPage?.kind ?? "index",
      changeType: "delete",
      status: "pending",
      sourceIds: previousPage?.sourceIds ?? [],
      previousPath: deletedPath,
      label: labelsByPath.get(deletedPath)
    });
  }

  return uniqueBy(entries, (entry) => `${entry.pageId}:${entry.changeType}:${entry.nextPath ?? ""}:${entry.previousPath ?? ""}`);
}

async function stageApprovalBundle(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  changedFiles: Array<{ relativePath: string; content: string }>,
  deletedPaths: string[],
  previousGraph: GraphArtifact | null,
  graph: GraphArtifact
): Promise<{ approvalId: string; approvalDir: string }> {
  const approvalId = `compile-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const approvalDir = path.join(paths.approvalsDir, approvalId);
  await ensureDir(approvalDir);
  await ensureDir(path.join(approvalDir, "wiki"));
  await ensureDir(path.join(approvalDir, "state"));

  for (const file of changedFiles) {
    const targetPath = path.join(approvalDir, "wiki", file.relativePath);
    await ensureDir(path.dirname(targetPath));
    await fs.writeFile(targetPath, file.content, "utf8");
  }

  await fs.writeFile(path.join(approvalDir, "state", "graph.json"), JSON.stringify(graph, null, 2), "utf8");
  await writeApprovalManifest(paths, {
    approvalId,
    createdAt: new Date().toISOString(),
    bundleType: "compile",
    title: "Compile Approval",
    entries: await buildApprovalEntries(paths, changedFiles, deletedPaths, previousGraph, graph)
  });

  return { approvalId, approvalDir };
}

async function syncVaultArtifacts(
  rootDir: string,
  input: {
    schemas: LoadedVaultSchemas;
    manifests: SourceManifest[];
    analyses: SourceAnalysis[];
    codeIndex: CodeIndexArtifact;
    sourceProjects: Record<string, string | null>;
    outputPages: GraphPage[];
    insightPages: GraphPage[];
    memoryRecords: Array<{ page: GraphPage; content: string }>;
    memoryTasks: AgentMemoryTask[];
    outputHashes: Record<string, string>;
    insightHashes: Record<string, string>;
    memoryHashes: Record<string, string>;
    domainProfileHash: string;
    domainProfile: LoadedDomainProfile;
    previousState: CompileState | null;
    approve?: boolean;
    promoteCandidates?: boolean;
    topicSynthesis?: boolean;
  }
): Promise<{
  graph: GraphArtifact;
  allPages: GraphPage[];
  changedPages: string[];
  promotedPageIds: string[];
  candidatePageCount: number;
  staged: boolean;
  approvalId?: string;
  approvalDir?: string;
}> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const previousGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const globalSchemaHash = input.schemas.effective.global.hash;
  const changedPages: string[] = [];
  const promotedPageIds: string[] = [];
  const candidateHistory: CompileState["candidateHistory"] = {};
  const records: ManagedPageRecord[] = [];
  const promoteCandidates = input.promoteCandidates ?? true;

  for (const manifest of input.manifests) {
    const analysis = input.analyses.find((item) => item.sourceId === manifest.sourceId);
    if (!analysis) {
      continue;
    }
    const sourceProjectIds = scopedProjectIdsFromSources([manifest.sourceId], input.sourceProjects);
    const sourceSchemaHash = effectiveHashForProject(input.schemas, sourceProjectIds[0] ?? null);
    const sourceCategoryTags = categoryTagsForSchema(getEffectiveSchema(input.schemas, sourceProjectIds[0] ?? null), [
      analysis.title,
      analysis.summary,
      ...analysis.concepts.map((item) => item.description),
      ...analysis.entities.map((item) => item.description)
    ]);

    const modulePreview = analysis.code
      ? emptyGraphPage({
          id: analysis.code.moduleId,
          path: `code/${manifest.sourceId}.md`,
          title: modulePageTitle(manifest),
          kind: "module",
          sourceIds: [manifest.sourceId],
          sourceClass: manifest.sourceClass,
          projectIds: sourceProjectIds,
          nodeIds: [analysis.code.moduleId, ...analysis.code.symbols.map((symbol) => symbol.id)],
          schemaHash: sourceSchemaHash,
          sourceHashes: { [manifest.sourceId]: manifest.contentHash },
          sourceSemanticHashes: { [manifest.sourceId]: manifest.semanticHash },
          confidence: 1
        })
      : null;
    const preview = emptyGraphPage({
      id: `source:${manifest.sourceId}`,
      path: `sources/${manifest.sourceId}.md`,
      title: analysis.title,
      kind: "source",
      sourceIds: [manifest.sourceId],
      sourceClass: manifest.sourceClass,
      projectIds: sourceProjectIds,
      nodeIds: [
        `source:${manifest.sourceId}`,
        ...analysis.concepts.map((item) => item.id),
        ...analysis.entities.map((item) => item.id),
        ...(analysis.code ? [analysis.code.moduleId, ...analysis.code.symbols.map((symbol) => symbol.id)] : [])
      ],
      schemaHash: sourceSchemaHash,
      sourceHashes: { [manifest.sourceId]: manifest.contentHash },
      sourceSemanticHashes: { [manifest.sourceId]: manifest.semanticHash },
      confidence: 1
    });
    const sourceRecord = await buildManagedGraphPage(
      path.join(paths.wikiDir, preview.path),
      {
        managedBy: "system",
        confidence: 1,
        compiledFrom: [manifest.sourceId]
      },
      (metadata, existingContent) =>
        buildSourcePage(
          manifest,
          analysis,
          sourceSchemaHash,
          metadata,
          relatedOutputsForPage(preview, input.outputPages),
          modulePreview ?? undefined,
          {
            projectIds: sourceProjectIds,
            extraTags: [...sourceCategoryTags, ...(analysis.tags ?? [])],
            sourceClass: manifest.sourceClass
          },
          existingContent
        )
    );
    records.push(sourceRecord);

    if (modulePreview && analysis.code) {
      const localModules = analysis.code.imports
        .map((codeImport) => {
          const resolvedSourceId = codeImport.resolvedSourceId;
          if (!resolvedSourceId) {
            return null;
          }
          const targetManifest = input.manifests.find((item) => item.sourceId === resolvedSourceId);
          if (!targetManifest) {
            return null;
          }
          return {
            specifier: codeImport.specifier,
            sourceId: resolvedSourceId,
            reExport: codeImport.reExport,
            page: {
              id: `module:${resolvedSourceId}`,
              path: `code/${resolvedSourceId}.md`,
              title: modulePageTitle(targetManifest)
            }
          };
        })
        .filter(
          (item): item is { specifier: string; sourceId: string; reExport: boolean; page: Pick<GraphPage, "id" | "path" | "title"> } =>
            Boolean(item)
        );

      records.push(
        await buildManagedGraphPage(
          path.join(paths.wikiDir, modulePreview.path),
          {
            managedBy: "system",
            confidence: 1,
            compiledFrom: [manifest.sourceId]
          },
          (metadata) =>
            buildModulePage({
              manifest,
              analysis,
              schemaHash: sourceSchemaHash,
              metadata,
              sourcePage: sourceRecord.page,
              localModules,
              relatedOutputs: relatedOutputsForPage(modulePreview, input.outputPages),
              projectIds: sourceProjectIds,
              extraTags: [...sourceCategoryTags, ...(analysis.tags ?? [])]
            })
        )
      );
    }
  }

  for (const kind of ["concepts", "entities"] as const) {
    for (const aggregate of aggregateItems(input.analyses, kind)) {
      const itemKind = kind === "concepts" ? "concept" : "entity";
      const slug = slugifyKnowledgeLabel(aggregate.name);
      const pageId = `${itemKind}:${slug}`;
      const sourceIds = uniqueStrings(aggregate.sourceAnalyses.map((item) => item.sourceId));
      const projectIds = scopedProjectIdsFromSources(sourceIds, input.sourceProjects);
      const schemaHash = effectiveHashForProject(input.schemas, projectIds[0] ?? null);
      const previousEntry = input.previousState?.candidateHistory?.[pageId];
      const topicQuality = aggregateTopicQuality(aggregate.name, aggregate.sourceAnalyses);
      if (topicQuality.decision === "reject") {
        continue;
      }
      const promoted =
        previousEntry?.status === "active" ||
        (promoteCandidates && shouldPromoteCandidate(previousEntry, sourceIds, aggregate.name, aggregate.sourceAnalyses));
      const relativePath = promoted ? activeAggregatePath(itemKind, slug) : candidatePagePathFor(itemKind, slug);
      const aggregateSourceClass = aggregateManifestSourceClass(input.manifests, sourceIds);
      const fallbackPaths = [
        path.join(paths.wikiDir, activeAggregatePath(itemKind, slug)),
        path.join(paths.wikiDir, candidatePagePathFor(itemKind, slug))
      ];
      const confidence = nodeConfidence(aggregate.sourceAnalyses.length);
      const preview = emptyGraphPage({
        id: pageId,
        path: relativePath,
        title: aggregate.name,
        kind: itemKind,
        sourceIds,
        sourceClass: aggregateSourceClass,
        projectIds,
        nodeIds: [pageId],
        schemaHash,
        sourceHashes: aggregate.sourceHashes,
        confidence,
        status: promoted ? "active" : "candidate"
      });
      const pageRecord = await buildManagedGraphPage(
        path.join(paths.wikiDir, relativePath),
        {
          status: promoted ? "active" : "candidate",
          managedBy: "system",
          confidence,
          compiledFrom: sourceIds,
          statePathCandidates: fallbackPaths
        },
        (metadata, existingContent) =>
          buildAggregatePage(
            itemKind,
            aggregate.name,
            aggregate.descriptions,
            aggregate.sourceAnalyses,
            aggregate.sourceHashes,
            aggregate.sourceSemanticHashes,
            schemaHash,
            metadata,
            relativePath,
            relatedOutputsForPage(preview, input.outputPages),
            {
              projectIds,
              extraTags: categoryTagsForSchema(getEffectiveSchema(input.schemas, projectIds[0] ?? null), [
                aggregate.name,
                ...aggregate.descriptions,
                ...aggregate.sourceAnalyses.map((item) => item.summary)
              ]),
              sourceClass: aggregateSourceClass
            },
            existingContent
          )
      );
      if (promoted && previousEntry?.status === "candidate") {
        promotedPageIds.push(pageId);
      }
      candidateHistory[pageId] = {
        sourceIds,
        status: promoted ? "active" : "candidate"
      };
      records.push(pageRecord);
    }
  }

  if (input.topicSynthesis) {
    const topicProvider = await getProviderForTask(rootDir, "compileProvider");
    const topicPages = await synthesizeEnvAirTopics({
      analyses: input.analyses,
      provider: topicProvider,
      schemaContent: input.schemas.effective.global.content,
      domainProfile: input.domainProfile
    });
    for (const topic of topicPages) {
      const sourceIds = uniqueStrings(topic.sourceIds);
      const sourceHashes = Object.fromEntries(
        input.analyses
          .filter((analysis) => sourceIds.includes(analysis.sourceId))
          .map((analysis) => [analysis.sourceId, analysis.sourceHash])
      );
      const sourceSemanticHashes = Object.fromEntries(
        input.analyses
          .filter((analysis) => sourceIds.includes(analysis.sourceId))
          .map((analysis) => [analysis.sourceId, analysis.semanticHash])
      );
      const projectIds = scopedProjectIdsFromSources(sourceIds, input.sourceProjects);
      const pageId = `concept:${topic.slug}`;
      const relativePath = `concepts/${topic.slug}.md`;
      const page = emptyGraphPage({
        id: pageId,
        path: relativePath,
        title: topic.title,
        kind: "concept",
        sourceIds,
        projectIds,
        nodeIds: [pageId],
        schemaHash: globalSchemaHash,
        sourceHashes,
        sourceSemanticHashes,
        confidence: 0.88,
        status: "active"
      });
      const content = await buildManagedContent(
        path.join(paths.wikiDir, relativePath),
        {
          managedBy: "system",
          compiledFrom: sourceIds
        },
        (metadata) =>
          matter.stringify(topic.body, {
            page_id: pageId,
            kind: "concept",
            cssclasses: ["sv-concept"],
            title: topic.title,
            tags: ["concept", "topic-synthesis", "env-air"],
            source_ids: sourceIds,
            project_ids: projectIds,
            node_ids: [pageId],
            freshness: "fresh",
            status: metadata.status,
            confidence: 0.88,
            created_at: metadata.createdAt,
            updated_at: metadata.updatedAt,
            compiled_from: metadata.compiledFrom,
            managed_by: metadata.managedBy,
            backlinks: sourceIds.map((sourceId) => `source:${sourceId}`),
            schema_hash: globalSchemaHash,
            synthesis: true,
            synthesis_version: 1,
            topic_id: topic.topicId,
            input_token_estimate: topic.inputTokenEstimate,
            prompt_hash: topic.promptHash,
            source_hashes: sourceHashes,
            source_semantic_hashes: sourceSemanticHashes
          })
      );
      records.push({ page, content });
      await writeJsonFile(path.join(paths.stateDir, "topic-synthesis", `${topic.topicId}.json`), {
        topicId: topic.topicId,
        title: topic.title,
        sourceIds,
        promptHash: topic.promptHash,
        inputTokenEstimate: topic.inputTokenEstimate,
        outputPagePath: relativePath,
        providerId: topicProvider.id,
        providerModel: topicProvider.model
      });
    }
  }

  const compiledPages = records.map((record) => record.page);
  const basePages = [...compiledPages, ...input.outputPages, ...input.insightPages, ...input.memoryRecords.map((record) => record.page)];
  records.push(...input.memoryRecords);
  const structuralGraph = buildGraph(input.manifests, input.analyses, basePages, input.sourceProjects, input.codeIndex, input.memoryTasks, {
    communityResolution: config.graph?.communityResolution,
    config
  });
  const contradictions = detectContradictions(input.analyses);
  for (const contradiction of contradictions) {
    const edgeId = `contradiction:${contradiction.sourceIdA}->${contradiction.sourceIdB}`;
    if (!structuralGraph.edges.some((e) => e.id === edgeId)) {
      structuralGraph.edges.push({
        id: edgeId,
        source: `source:${contradiction.sourceIdA}`,
        target: `source:${contradiction.sourceIdB}`,
        relation: "contradicts",
        status: "conflicted",
        evidenceClass: "ambiguous",
        confidence: Math.abs(contradiction.claimA.confidence - contradiction.claimB.confidence),
        provenance: [contradiction.sourceIdA, contradiction.sourceIdB]
      });
    }
  }
  const embeddingEdges = await embeddingSimilarityEdges(rootDir, structuralGraph).catch(() => []);
  const baseGraph =
    embeddingEdges.length > 0
      ? (() => {
          const edges = uniqueBy([...structuralGraph.edges, ...embeddingEdges], (edge) => edge.id).sort((left, right) =>
            left.id.localeCompare(right.id)
          );
          const metrics = deriveGraphMetrics(resetGraphNodeMetrics(structuralGraph.nodes), edges, {
            resolution: config.graph?.communityResolution
          });
          return {
            ...structuralGraph,
            nodes: metrics.nodes,
            edges,
            communities: metrics.communities
          } satisfies GraphArtifact;
        })()
      : structuralGraph;
  const graphOrientation = await buildGraphOrientationPages(
    baseGraph,
    paths,
    globalSchemaHash,
    input.previousState?.generatedAt,
    contradictions,
    config
  );
  const preliminaryPages = [...basePages, ...graphOrientation.records.map((record) => record.page)];
  const dashboardRecords = await buildDashboardRecords(
    config,
    paths,
    {
      ...baseGraph,
      sources: input.manifests,
      pages: preliminaryPages
    },
    globalSchemaHash,
    graphOrientation.report
  );
  records.push(...graphOrientation.records, ...dashboardRecords);
  const allPages = uniqueBy([...preliminaryPages, ...dashboardRecords.map((record) => record.page)], (page) => page.id);
  const graph: GraphArtifact = {
    ...baseGraph,
    pages: allPages
  };
  const activeConceptPages = allPages.filter((page) => page.kind === "concept" && page.status !== "candidate");
  const activeEntityPages = allPages.filter((page) => page.kind === "entity" && page.status !== "candidate");
  const modulePages = allPages.filter((page) => page.kind === "module");
  const candidatePages = allPages.filter((page) => page.status === "candidate");
  const configuredProjects = projectEntries(config);
  const projectIndexRefs = configuredProjects.map((project) =>
    emptyGraphPage({
      id: `project:${project.id}:index`,
      path: `projects/${project.id}/index.md`,
      title: `Project: ${project.id}`,
      kind: "index",
      sourceIds: [],
      projectIds: [project.id],
      nodeIds: [],
      schemaHash: effectiveHashForProject(input.schemas, project.id),
      sourceHashes: {},
      confidence: 1
    })
  );

  records.push({
    page: emptyGraphPage({
      id: "projects:index",
      path: "projects/index.md",
      title: "Projects",
      kind: "index",
      sourceIds: [],
      projectIds: [],
      nodeIds: [],
      schemaHash: globalSchemaHash,
      sourceHashes: {},
      confidence: 1
    }),
    content: await buildManagedContent(
      path.join(paths.wikiDir, "projects", "index.md"),
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(projectIndexRefs)
      },
      (metadata) => buildProjectsIndex(projectIndexRefs, globalSchemaHash, metadata)
    )
  });

  for (const project of configuredProjects) {
    const projectIndexRef = projectIndexRefs.find((page) => page.projectIds.includes(project.id));
    if (!projectIndexRef) {
      continue;
    }
    const sections = {
      sources: allPages.filter((page) => page.kind === "source" && page.projectIds.includes(project.id)),
      code: allPages.filter((page) => page.kind === "module" && page.projectIds.includes(project.id)),
      concepts: allPages.filter((page) => page.kind === "concept" && page.status !== "candidate" && page.projectIds.includes(project.id)),
      entities: allPages.filter((page) => page.kind === "entity" && page.status !== "candidate" && page.projectIds.includes(project.id)),
      outputs: allPages.filter((page) => page.kind === "output" && page.projectIds.includes(project.id)),
      candidates: allPages.filter((page) => page.status === "candidate" && page.projectIds.includes(project.id))
    } as const;
    records.push({
      page: projectIndexRef,
      content: await buildManagedContent(
        path.join(paths.wikiDir, projectIndexRef.path),
        {
          managedBy: "system",
          compiledFrom: indexCompiledFrom(Object.values(sections).flat())
        },
        (metadata) =>
          buildProjectIndex({
            projectId: project.id,
            schemaHash: effectiveHashForProject(input.schemas, project.id),
            metadata,
            sections
          })
      )
    });
  }

  records.push({
    page: emptyGraphPage({
      id: "index",
      path: "index.md",
      title: "SwarmVault Index",
      kind: "index",
      sourceIds: [],
      projectIds: [],
      nodeIds: [],
      schemaHash: globalSchemaHash,
      sourceHashes: {},
      confidence: 1
    }),
    content: await buildManagedContent(
      path.join(paths.wikiDir, "index.md"),
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(allPages)
      },
      (metadata) => buildIndexPage(allPages, globalSchemaHash, metadata, projectIndexRefs)
    )
  });

  for (const [relativePath, kind, pages] of [
    ["sources/index.md", "sources", allPages.filter((page) => page.kind === "source")],
    ["code/index.md", "code", modulePages],
    ["concepts/index.md", "concepts", activeConceptPages],
    ["entities/index.md", "entities", activeEntityPages],
    ["outputs/index.md", "outputs", allPages.filter((page) => page.kind === "output")],
    ["memory/index.md", "memory", allPages.filter((page) => page.kind === "memory_task")],
    [
      "dashboards/index.md",
      "dashboards",
      allPages.filter((page) => page.kind === "index" && page.path.startsWith("dashboards/") && page.path !== "dashboards/index.md")
    ],
    ["candidates/index.md", "candidates", candidatePages],
    ["graph/index.md", "graph", allPages.filter((page) => page.kind === "graph_report" || page.kind === "community_summary")]
  ] as const) {
    records.push({
      page: emptyGraphPage({
        id: `${kind}:index`,
        path: relativePath,
        title: kind,
        kind: "index",
        sourceIds: [],
        projectIds: [],
        nodeIds: [],
        schemaHash: globalSchemaHash,
        sourceHashes: {},
        confidence: 1
      }),
      content: await buildManagedContent(
        path.join(paths.wikiDir, relativePath),
        {
          managedBy: "system",
          compiledFrom: indexCompiledFrom(pages)
        },
        (metadata) => buildSectionIndex(kind, pages, globalSchemaHash, metadata)
      )
    });
  }

  const nextPagePaths = new Set(records.map((record) => record.page.path));
  const obsoleteGraphPaths = (previousGraph?.pages ?? [])
    .filter((page) => page.kind !== "output" && page.kind !== "insight")
    .map((page) => page.path)
    .filter((relativePath) => !nextPagePaths.has(relativePath));
  const existingProjectIndexPaths = (await listFilesRecursive(paths.projectsDir))
    .filter((absolutePath) => absolutePath.endsWith(".md"))
    .map((absolutePath) => toPosix(path.relative(paths.wikiDir, absolutePath)))
    .filter((relativePath) => !nextPagePaths.has(relativePath));
  const obsoletePaths = uniqueStrings([...obsoleteGraphPaths, ...existingProjectIndexPaths]);

  const changedFiles: Array<{ relativePath: string; content: string }> = [];
  for (const record of records) {
    const absolutePath = path.join(paths.wikiDir, record.page.path);
    const current = (await fileExists(absolutePath)) ? await fs.readFile(absolutePath, "utf8") : null;
    if (current !== record.content) {
      changedPages.push(record.page.path);
      changedFiles.push({ relativePath: record.page.path, content: record.content });
    }
  }
  changedPages.push(...obsoletePaths.filter((relativePath) => !changedPages.includes(relativePath)));

  if (input.approve) {
    const approval = await stageApprovalBundle(paths, changedFiles, obsoletePaths, previousGraph ?? null, graph);
    return {
      graph,
      allPages,
      changedPages,
      promotedPageIds,
      candidatePageCount: candidatePages.length,
      staged: true,
      approvalId: approval.approvalId,
      approvalDir: approval.approvalDir
    };
  }

  const writeChanges: string[] = [];
  for (const record of records) {
    await writePage(paths.wikiDir, record.page.path, record.content, writeChanges);
  }
  for (const relativePath of obsoletePaths) {
    await fs.rm(path.join(paths.wikiDir, relativePath), { force: true });
  }
  const archivedAggregatePages = await cleanupStaleAggregatePages(paths.wikiDir, new Set(allPages.map((page) => page.id)));
  changedPages.push(...archivedAggregatePages.filter((relativePath) => !changedPages.includes(relativePath)));

  await writeJsonFile(paths.graphPath, graph);
  await writeJsonFile(path.join(paths.wikiDir, "graph", "report.json"), graphOrientation.report);
  await writeFileIfChanged(path.join(paths.wikiDir, "graph", "share-card.svg"), graphOrientation.shareSvg);
  await writeGraphShareBundle(paths.wikiDir, graphOrientation.shareBundleFiles);
  await writeJsonFile(paths.codeIndexPath, input.codeIndex);
  await writeJsonFile(paths.compileStatePath, {
    generatedAt: graph.generatedAt,
    rootSchemaHash: input.schemas.root.hash,
    domainProfileHash: input.domainProfileHash,
    projectSchemaHashes: Object.fromEntries(
      Object.keys(input.schemas.projects)
        .sort((left, right) => left.localeCompare(right))
        .map((projectId) => [projectId, input.schemas.projects[projectId]?.hash ?? ""])
    ),
    effectiveSchemaHashes: {
      global: input.schemas.effective.global.hash,
      projects: Object.fromEntries(
        Object.keys(input.schemas.effective.projects)
          .sort((left, right) => left.localeCompare(right))
          .map((projectId) => [projectId, input.schemas.effective.projects[projectId]?.hash ?? input.schemas.effective.global.hash])
      )
    },
    projectConfigHash: projectConfigHash(config),
    analyses: Object.fromEntries(input.analyses.map((analysis) => [analysis.sourceId, analysisSignature(analysis)])),
    sourceHashes: Object.fromEntries(input.manifests.map((manifest) => [manifest.sourceId, manifest.contentHash])),
    sourceSemanticHashes: Object.fromEntries(input.manifests.map((manifest) => [manifest.sourceId, manifest.semanticHash])),
    sourceProjects: input.sourceProjects,
    outputHashes: input.outputHashes,
    insightHashes: input.insightHashes,
    memoryHashes: input.memoryHashes,
    candidateHistory
  } satisfies CompileState);
  await applyStandardRelationOverrides(paths.wikiDir, allPages);
  await rebuildSearchIndex(paths.searchDbPath, allPages, paths.wikiDir, { chunking: config.retrieval?.chunking });
  await writeRetrievalManifest(rootDir, graph);

  return {
    graph,
    allPages,
    changedPages: uniqueStrings([...changedPages, ...writeChanges]),
    promotedPageIds,
    candidatePageCount: candidatePages.length,
    staged: false
  };
}

async function refreshIndexesAndSearch(rootDir: string, pages: GraphPage[]): Promise<void> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const schemas = await loadVaultSchemas(rootDir);
  const compileState = await readJsonFile<CompileState>(paths.compileStatePath);
  const globalSchemaHash = schemas.effective.global.hash;
  const currentGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const orientationPages = uniqueBy(
    pages.filter((page) => page.kind !== "graph_report" && page.kind !== "community_summary"),
    (page) => page.id
  );
  const basePages = uniqueBy(
    pages.filter(
      (page) =>
        page.kind !== "graph_report" && page.kind !== "community_summary" && !(page.kind === "index" && page.path.startsWith("dashboards/"))
    ),
    (page) => page.id
  );
  const graphOrientation: {
    records: ManagedPageRecord[];
    report: GraphReportArtifact | null;
    shareSvg: string;
    shareBundleFiles: GraphShareBundleFile[];
  } = currentGraph
    ? await buildGraphOrientationPages(
        {
          ...currentGraph,
          pages: orientationPages
        },
        paths,
        globalSchemaHash,
        compileState?.generatedAt,
        [],
        config
      )
    : { records: [], report: null, shareSvg: "", shareBundleFiles: [] };
  const dashboardRecords = currentGraph
    ? await buildDashboardRecords(
        config,
        paths,
        {
          ...currentGraph,
          pages: [...basePages, ...graphOrientation.records.map((record) => record.page)]
        },
        globalSchemaHash,
        graphOrientation.report
      )
    : [];
  const pagesWithGraph = sortGraphPages(
    uniqueBy(
      [...basePages, ...graphOrientation.records.map((record) => record.page), ...dashboardRecords.map((record) => record.page)],
      (page) => page.id
    )
  );
  if (currentGraph) {
    await writeJsonFile(paths.graphPath, {
      ...currentGraph,
      pages: pagesWithGraph
    });
  }
  const configuredProjects = projectEntries(config);
  const projectIndexRefs = configuredProjects.map((project) =>
    emptyGraphPage({
      id: `project:${project.id}:index`,
      path: `projects/${project.id}/index.md`,
      title: `Project: ${project.id}`,
      kind: "index",
      sourceIds: [],
      projectIds: [project.id],
      nodeIds: [],
      schemaHash: effectiveHashForProject(schemas, project.id),
      sourceHashes: {},
      confidence: 1
    })
  );
  await Promise.all([
    ensureDir(path.join(paths.wikiDir, "sources")),
    ensureDir(path.join(paths.wikiDir, "code")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "outputs")),
    ensureDir(path.join(paths.wikiDir, "dashboards")),
    ensureDir(path.join(paths.wikiDir, "graph")),
    ensureDir(path.join(paths.wikiDir, "graph", "communities")),
    ensureDir(path.join(paths.wikiDir, "projects")),
    ensureDir(path.join(paths.wikiDir, "candidates"))
  ]);
  const projectsIndexPath = path.join(paths.wikiDir, "projects", "index.md");
  await writeFileIfChanged(
    projectsIndexPath,
    await buildManagedContent(
      projectsIndexPath,
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(projectIndexRefs)
      },
      (metadata) => buildProjectsIndex(projectIndexRefs, globalSchemaHash, metadata)
    )
  );

  for (const project of configuredProjects) {
    const sections = {
      sources: pages.filter((page) => page.kind === "source" && page.projectIds.includes(project.id)),
      code: pages.filter((page) => page.kind === "module" && page.projectIds.includes(project.id)),
      concepts: pages.filter((page) => page.kind === "concept" && page.status !== "candidate" && page.projectIds.includes(project.id)),
      entities: pages.filter((page) => page.kind === "entity" && page.status !== "candidate" && page.projectIds.includes(project.id)),
      outputs: pages.filter((page) => page.kind === "output" && page.projectIds.includes(project.id)),
      candidates: pages.filter((page) => page.status === "candidate" && page.projectIds.includes(project.id))
    } as const;
    const absolutePath = path.join(paths.wikiDir, "projects", project.id, "index.md");
    await writeFileIfChanged(
      absolutePath,
      await buildManagedContent(
        absolutePath,
        {
          managedBy: "system",
          compiledFrom: indexCompiledFrom(Object.values(sections).flat())
        },
        (metadata) =>
          buildProjectIndex({
            projectId: project.id,
            schemaHash: effectiveHashForProject(schemas, project.id),
            metadata,
            sections
          })
      )
    );
  }

  const rootIndexPath = path.join(paths.wikiDir, "index.md");
  await writeFileIfChanged(
    rootIndexPath,
    await buildManagedContent(
      rootIndexPath,
      {
        managedBy: "system",
        compiledFrom: indexCompiledFrom(pagesWithGraph)
      },
      (metadata) => buildIndexPage(pagesWithGraph, globalSchemaHash, metadata, projectIndexRefs)
    )
  );

  for (const [relativePath, kind, sectionPages] of [
    ["sources/index.md", "sources", pagesWithGraph.filter((page) => page.kind === "source")],
    ["code/index.md", "code", pagesWithGraph.filter((page) => page.kind === "module")],
    ["concepts/index.md", "concepts", pagesWithGraph.filter((page) => page.kind === "concept" && page.status !== "candidate")],
    ["entities/index.md", "entities", pagesWithGraph.filter((page) => page.kind === "entity" && page.status !== "candidate")],
    ["outputs/index.md", "outputs", pagesWithGraph.filter((page) => page.kind === "output")],
    [
      "dashboards/index.md",
      "dashboards",
      pagesWithGraph.filter((page) => page.kind === "index" && page.path.startsWith("dashboards/") && page.path !== "dashboards/index.md")
    ],
    ["candidates/index.md", "candidates", pagesWithGraph.filter((page) => page.status === "candidate")],
    ["graph/index.md", "graph", pagesWithGraph.filter((page) => page.kind === "graph_report" || page.kind === "community_summary")]
  ] as const) {
    const absolutePath = path.join(paths.wikiDir, relativePath);
    await writeFileIfChanged(
      absolutePath,
      await buildManagedContent(
        absolutePath,
        {
          managedBy: "system",
          compiledFrom: indexCompiledFrom(sectionPages)
        },
        (metadata) => buildSectionIndex(kind, sectionPages, globalSchemaHash, metadata)
      )
    );
  }

  for (const record of graphOrientation.records) {
    await writeFileIfChanged(path.join(paths.wikiDir, record.page.path), record.content);
  }
  for (const record of dashboardRecords) {
    await writeFileIfChanged(path.join(paths.wikiDir, record.page.path), record.content);
  }
  if (graphOrientation.report) {
    await writeJsonFile(path.join(paths.wikiDir, "graph", "report.json"), graphOrientation.report);
    await writeFileIfChanged(path.join(paths.wikiDir, "graph", "share-card.svg"), graphOrientation.shareSvg);
    await writeGraphShareBundle(paths.wikiDir, graphOrientation.shareBundleFiles);
  }

  const existingProjectIndexPaths = (await listFilesRecursive(paths.projectsDir))
    .filter((absolutePath) => absolutePath.endsWith(".md"))
    .map((absolutePath) => toPosix(path.relative(paths.wikiDir, absolutePath)));
  const allowedProjectIndexPaths = new Set([
    "projects/index.md",
    ...configuredProjects.map((project) => `projects/${project.id}/index.md`)
  ]);
  await Promise.all(
    existingProjectIndexPaths
      .filter((relativePath) => !allowedProjectIndexPaths.has(relativePath))
      .map((relativePath) => fs.rm(path.join(paths.wikiDir, relativePath), { force: true }))
  );

  const existingGraphPages = (await listFilesRecursive(path.join(paths.wikiDir, "graph").replace(/\/$/, "")).catch(() => []))
    .filter((absolutePath) => absolutePath.endsWith(".md"))
    .map((absolutePath) => toPosix(path.relative(paths.wikiDir, absolutePath)));
  const allowedGraphPages = new Set([
    "graph/index.md",
    "graph/share-kit/share-card.md",
    ...graphOrientation.records.map((record) => record.page.path)
  ]);
  await Promise.all(
    existingGraphPages
      .filter((relativePath) => !allowedGraphPages.has(relativePath))
      .map((relativePath) => fs.rm(path.join(paths.wikiDir, relativePath), { force: true }))
  );

  const existingDashboardPages = (await listFilesRecursive(path.join(paths.wikiDir, "dashboards")).catch(() => []))
    .filter((absolutePath) => absolutePath.endsWith(".md"))
    .map((absolutePath) => toPosix(path.relative(paths.wikiDir, absolutePath)));
  const allowedDashboardPages = new Set(["dashboards/index.md", ...dashboardRecords.map((record) => record.page.path)]);
  await Promise.all(
    existingDashboardPages
      .filter((relativePath) => !allowedDashboardPages.has(relativePath))
      .map((relativePath) => fs.rm(path.join(paths.wikiDir, relativePath), { force: true }))
  );
  await cleanupStaleAggregatePages(paths.wikiDir, new Set(pagesWithGraph.map((page) => page.id)));

  await applyStandardRelationOverrides(paths.wikiDir, pagesWithGraph);
  await rebuildSearchIndex(paths.searchDbPath, pagesWithGraph, paths.wikiDir, { chunking: config.retrieval?.chunking });
  if (currentGraph) {
    await writeRetrievalManifest(rootDir, {
      ...currentGraph,
      pages: pagesWithGraph
    });
  }
}

async function prepareOutputPageSave(
  rootDir: string,
  input: Omit<Parameters<typeof buildOutputPage>[0], "metadata"> & {
    assetFiles?: GeneratedOutputArtifacts["assetFiles"];
  }
): Promise<PersistedOutputPageResult & { content: string; assetFiles: GeneratedOutputArtifacts["assetFiles"] }> {
  const { paths } = await loadVaultConfig(rootDir);
  const slug = await resolveUniqueOutputSlug(paths.wikiDir, input.slug ?? slugify(input.question));
  const now = new Date().toISOString();
  const output = buildOutputPage({
    ...input,
    slug,
    metadata: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      compiledFrom: uniqueStrings(input.relatedSourceIds ?? input.citations),
      managedBy: "system",
      confidence: 0.74
    }
  });
  const absolutePath = path.join(paths.wikiDir, output.page.path);
  return {
    page: output.page,
    savedPath: absolutePath,
    outputAssets: output.page.outputAssets ?? [],
    content: output.content,
    assetFiles: input.assetFiles ?? []
  };
}

async function persistOutputPage(
  rootDir: string,
  input: Omit<Parameters<typeof buildOutputPage>[0], "metadata"> & {
    assetFiles?: GeneratedOutputArtifacts["assetFiles"];
  }
): Promise<PersistedOutputPageResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const prepared = await prepareOutputPageSave(rootDir, input);
  await ensureDir(path.dirname(prepared.savedPath));
  await fs.writeFile(prepared.savedPath, prepared.content, "utf8");
  for (const assetFile of prepared.assetFiles) {
    const assetPath = path.join(paths.wikiDir, assetFile.relativePath);
    await ensureDir(path.dirname(assetPath));
    if (typeof assetFile.content === "string") {
      await fs.writeFile(assetPath, assetFile.content, assetFile.encoding ?? "utf8");
    } else {
      await fs.writeFile(assetPath, assetFile.content);
    }
  }
  return { page: prepared.page, savedPath: prepared.savedPath, outputAssets: prepared.outputAssets };
}

async function prepareExploreHubSave(
  rootDir: string,
  input: Omit<Parameters<typeof buildExploreHubPage>[0], "metadata"> & {
    assetFiles?: GeneratedOutputArtifacts["assetFiles"];
  }
): Promise<PersistedOutputPageResult & { content: string; assetFiles: GeneratedOutputArtifacts["assetFiles"] }> {
  const { paths } = await loadVaultConfig(rootDir);
  const slug = await resolveUniqueOutputSlug(paths.wikiDir, input.slug ?? `explore-${slugify(input.question)}`);
  const now = new Date().toISOString();
  const hub = buildExploreHubPage({
    ...input,
    slug,
    metadata: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      compiledFrom: uniqueStrings(input.citations),
      managedBy: "system",
      confidence: 0.76
    }
  });
  const absolutePath = path.join(paths.wikiDir, hub.page.path);
  return {
    page: hub.page,
    savedPath: absolutePath,
    outputAssets: hub.page.outputAssets ?? [],
    content: hub.content,
    assetFiles: input.assetFiles ?? []
  };
}

async function persistExploreHub(
  rootDir: string,
  input: Omit<Parameters<typeof buildExploreHubPage>[0], "metadata"> & {
    assetFiles?: GeneratedOutputArtifacts["assetFiles"];
  }
): Promise<PersistedOutputPageResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const prepared = await prepareExploreHubSave(rootDir, input);
  await ensureDir(path.dirname(prepared.savedPath));
  await fs.writeFile(prepared.savedPath, prepared.content, "utf8");
  for (const assetFile of prepared.assetFiles) {
    const assetPath = path.join(paths.wikiDir, assetFile.relativePath);
    await ensureDir(path.dirname(assetPath));
    if (typeof assetFile.content === "string") {
      await fs.writeFile(assetPath, assetFile.content, assetFile.encoding ?? "utf8");
    } else {
      await fs.writeFile(assetPath, assetFile.content);
    }
  }
  return { page: prepared.page, savedPath: prepared.savedPath, outputAssets: prepared.outputAssets };
}

async function stageOutputApprovalBundle(
  rootDir: string,
  stagedPages: Array<{ page: GraphPage; content: string; assetFiles?: GeneratedOutputArtifacts["assetFiles"]; label?: ApprovalEntryLabel }>,
  options: {
    bundleType?: ApprovalBundleType;
    title?: string;
    sourceSessionId?: string;
  } = {}
): Promise<{ approvalId: string; approvalDir: string }> {
  const { paths } = await loadVaultConfig(rootDir);
  const previousGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const changedFiles = stagedPages.flatMap((item) => [
    { relativePath: item.page.path, content: item.content },
    ...((item.assetFiles ?? []).map((assetFile) => ({
      relativePath: assetFile.relativePath,
      content: typeof assetFile.content === "string" ? assetFile.content : Buffer.from(assetFile.content).toString("base64"),
      binary: typeof assetFile.content !== "string"
    })) as Array<{ relativePath: string; content: string; binary: boolean }>)
  ]);
  const labelsByPath = new Map(stagedPages.filter((item) => item.label).map((item) => [item.page.path, item.label as ApprovalEntryLabel]));

  const approvalId = `schedule-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const approvalDir = path.join(paths.approvalsDir, approvalId);
  await ensureDir(approvalDir);
  await ensureDir(path.join(approvalDir, "wiki"));
  await ensureDir(path.join(approvalDir, "state"));

  for (const file of changedFiles) {
    const targetPath = path.join(approvalDir, "wiki", file.relativePath);
    await ensureDir(path.dirname(targetPath));
    if ("binary" in file && file.binary) {
      await fs.writeFile(targetPath, Buffer.from(file.content, "base64"));
    } else {
      await fs.writeFile(targetPath, file.content, "utf8");
    }
  }

  const nextPages = sortGraphPages([
    ...(previousGraph?.pages ?? []).filter((page) => !stagedPages.some((item) => item.page.id === page.id || item.page.path === page.path)),
    ...stagedPages.map((item) => item.page)
  ]);
  const graph: GraphArtifact = {
    generatedAt: new Date().toISOString(),
    nodes: previousGraph?.nodes ?? [],
    edges: previousGraph?.edges ?? [],
    hyperedges: previousGraph?.hyperedges ?? [],
    sources: previousGraph?.sources ?? [],
    pages: nextPages
  };
  await fs.writeFile(path.join(approvalDir, "state", "graph.json"), JSON.stringify(graph, null, 2), "utf8");
  await writeApprovalManifest(paths, {
    approvalId,
    createdAt: new Date().toISOString(),
    bundleType: options.bundleType ?? "generated-output",
    title: options.title,
    sourceSessionId: options.sourceSessionId,
    entries: await buildApprovalEntries(
      paths,
      stagedPages.map((item) => ({ relativePath: item.page.path, content: item.content })),
      [],
      previousGraph ?? null,
      graph,
      labelsByPath
    )
  });

  return { approvalId, approvalDir };
}

export async function stageGeneratedOutputPages(
  rootDir: string,
  stagedPages: Array<{ page: GraphPage; content: string; assetFiles?: GeneratedOutputArtifacts["assetFiles"]; label?: ApprovalEntryLabel }>,
  options: {
    bundleType?: ApprovalBundleType;
    title?: string;
    sourceSessionId?: string;
  } = {}
): Promise<{ approvalId: string; approvalDir: string }> {
  return await stageOutputApprovalBundle(rootDir, stagedPages, options);
}

const groundedAnswerSchema = z.object({
  answer: z.string().min(1),
  usedEvidenceIds: z.array(z.string().min(1)).default([]),
  unsupportedClaims: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  recommendedNextTool: z.enum(["knowledge_base", "environment_data_mcp", "both"]).optional(),
  standardCoverage: z
    .array(
      z.object({
        standard: z.string().min(1),
        required: z.boolean().default(false),
        covered: z.boolean().default(false),
        evidenceIds: z.array(z.string().min(1)).default([]),
        status: z.string().optional()
      })
    )
    .optional(),
  evidenceCompleteness: z
    .object({
      requiredStandards: z.array(z.string()).default([]),
      coveredStandards: z.array(z.string()).default([]),
      missingStandards: z.array(z.string()).default([]),
      authorityPinnedEvidenceCount: z.number().int().nonnegative().default(0)
    })
    .optional()
});

type GroundedAnswer = z.infer<typeof groundedAnswerSchema>;
type EvidenceItem = RetrievalDebugInfo["evidenceItems"][number];

function buildQuerySearchOptions(queryOptions?: QueryOptions): SearchQueryOptions {
  const searchOptions: SearchQueryOptions = {
    limit: queryOptions?.debugContext ? 8 : 5,
    region: queryOptions?.region,
    pollutant: queryOptions?.pollutants?.[0],
    includeDrafts: queryOptions?.includeDrafts,
    includeSuperseded: queryOptions?.includeSuperseded,
    intent: queryOptions?.intent,
    requireCurrentBasis: queryOptions?.requireCurrentBasis,
    strictGrounding: queryOptions?.strictGrounding || queryOptions?.evidenceMode === "strict",
    project: queryOptions?.projectId,
    scope: queryOptions?.scope,
    tenantId: queryOptions?.tenantId
  };
  const queryIntent = queryOptions?.intent;
  if (queryIntent === "current_basis" || queryOptions?.requireCurrentBasis) {
    searchOptions.authorityLayer = queryOptions?.region ? ["core", "method", "local"] : ["core", "method"];
    searchOptions.includeDrafts = false;
    searchOptions.includeSuperseded = false;
    if (queryOptions?.strictGrounding || queryOptions?.evidenceMode === "strict") {
      searchOptions.legalStatus = "current_effective";
    }
  } else if (queryIntent === "evolution") {
    searchOptions.authorityLayer = ["core", "evolution", "method"];
    searchOptions.includeDrafts = true;
    searchOptions.includeSuperseded = true;
  } else if (queryIntent === "local") {
    searchOptions.authorityLayer = ["local", "core", "method"];
  } else if (queryIntent === "statistics") {
    searchOptions.documentRole = ["statistics", "whitepaper", "research_literature", "official_explanation"];
  } else if (queryIntent === "authority_boundary") {
    searchOptions.authorityLayer = ["core", "method", "evidence", "evolution", "local"];
    searchOptions.documentRole = [
      "standard",
      "technical_guide",
      "research_literature",
      "statistics",
      "whitepaper",
      "draft",
      "compilation_explanation",
      "amendment"
    ];
    searchOptions.includeDrafts = true;
    searchOptions.includeSuperseded = true;
  } else if (queryIntent === "operational_guidance") {
    searchOptions.authorityLayer = ["core", "method", "local", "evidence"];
  }
  if (queryOptions?.scope === "public_only") {
    searchOptions.visibility = "public";
  } else if (queryOptions?.scope === "tenant_only") {
    searchOptions.visibility = "tenant";
    searchOptions.tenantId = queryOptions.tenantId ?? "__missing_tenant__";
  } else if (queryOptions?.scope === "project_only") {
    searchOptions.visibility = "project";
    searchOptions.project = queryOptions.projectId ?? "__missing_project__";
  }
  return searchOptions;
}

function inferAnswerBasis(
  options: QueryOptions | undefined,
  recommendedNextTool: QueryResult["recommendedNextTool"],
  temporalIntent?: QueryResult["temporalIntent"]
): QueryResult["answerBasis"] {
  if (recommendedNextTool === "environment_data_mcp") {
    return "data_required";
  }
  if (temporalIntent?.mode === "historical_as_of" || temporalIntent?.mode === "evaluation_period") {
    return "historical_or_evolution";
  }
  switch (options?.intent) {
    case "current_basis":
      return "current_effective";
    case "evolution":
      return "historical_or_evolution";
    case "local":
      return "local_adaptation";
    case "statistics":
    case "research":
    case "explanation":
    case "report_writing":
    case "authority_boundary":
    case "operational_guidance":
      return "evidence_explanation";
    default:
      return options?.requireCurrentBasis ? "current_effective" : "evidence_explanation";
  }
}

function inferAuthorityBoundary(evidenceItems: EvidenceItem[]): NonNullable<QueryResult["agentDecision"]>["authorityBoundary"] {
  const hasCurrentAuthority = evidenceItems.some(
    (item) =>
      (item.authorityLayer === "core" || item.authorityLayer === "method" || item.authorityLayer === "local") &&
      (item.legalStatus === "current_effective" || !item.legalStatus) &&
      (item.documentRole === "standard" ||
        item.documentRole === "monitoring_method" ||
        item.documentRole === "amendment" ||
        !item.documentRole)
  );
  const hasReference = evidenceItems.some(
    (item) =>
      item.authorityLayer === "evidence" ||
      item.documentRole === "research_literature" ||
      item.documentRole === "statistics" ||
      item.documentRole === "whitepaper" ||
      item.documentRole === "official_explanation" ||
      item.documentRole === "technical_guide"
  );
  const hasDraftOrHistorical = evidenceItems.some(
    (item) =>
      item.authorityLayer === "evolution" ||
      item.legalStatus === "draft_consultation" ||
      item.legalStatus === "superseded" ||
      item.documentRole === "draft" ||
      item.documentRole === "compilation_explanation"
  );
  const classes = [hasCurrentAuthority, hasReference, hasDraftOrHistorical].filter(Boolean).length;
  if (classes > 1) {
    return "mixed";
  }
  if (hasCurrentAuthority) {
    return "current_mandatory";
  }
  if (hasDraftOrHistorical) {
    return "draft_or_historical";
  }
  if (hasReference) {
    return "recommended_guidance";
  }
  return "unknown";
}

function isCurrentAuthorityEvidence(item: EvidenceItem): boolean {
  return (
    (item.authorityLayer === "core" || item.authorityLayer === "method" || item.authorityLayer === "local") &&
    (item.legalStatus === "current_effective" || !item.legalStatus) &&
    (item.evidenceRole === "current_authority" ||
      item.evidenceRole === "method" ||
      item.evidenceRole === "local_adaptation" ||
      Boolean(item.factId))
  );
}

function splitEvidenceByAuthority(
  evidenceItems: EvidenceItem[],
  currentBasis: boolean
): {
  primary: EvidenceItem[];
  supporting: EvidenceItem[];
  excluded: Array<EvidenceItem & { exclusionReason: string }>;
} {
  if (!currentBasis) {
    return { primary: evidenceItems, supporting: [], excluded: [] };
  }
  const primary: EvidenceItem[] = [];
  const supporting: EvidenceItem[] = [];
  const excluded: Array<EvidenceItem & { exclusionReason: string }> = [];
  for (const item of evidenceItems) {
    if (item.kind === "web") {
      supporting.push(item);
      continue;
    }
    if (isCurrentAuthorityEvidence(item)) {
      primary.push(item);
      continue;
    }
    if (
      item.authorityLayer === "evidence" ||
      item.evidenceRole === "statistics" ||
      item.evidenceRole === "research" ||
      item.evidenceRole === "official_explanation" ||
      item.documentRole === "technical_guide"
    ) {
      supporting.push(item);
      continue;
    }
    if (item.legalStatus === "draft_consultation" || item.legalStatus === "superseded" || item.authorityLayer === "evolution") {
      excluded.push({ ...item, exclusionReason: "not_current_execution_basis" });
      continue;
    }
    supporting.push(item);
  }
  return { primary, supporting, excluded };
}

function buildAgentDecision(input: {
  evidenceState?: QueryResult["evidenceState"];
  recommendedNextTool?: QueryResult["recommendedNextTool"];
  evidenceItems: EvidenceItem[];
  projectIds: string[];
  standardCoverage?: StandardCoverage[];
  blockingReasons?: string[];
}): QueryResult["agentDecision"] {
  const recommendedNextTool = input.recommendedNextTool ?? "knowledge_base";
  const mustCallTools: Array<"environment_data_mcp"> =
    recommendedNextTool === "environment_data_mcp" || recommendedNextTool === "both" ? ["environment_data_mcp"] : [];
  const evidenceState = input.evidenceState ?? "partial";
  const reportUsability =
    evidenceState === "insufficient"
      ? "insufficient"
      : mustCallTools.length
        ? "needs_data_mcp"
        : evidenceState === "partial"
          ? "draft_only"
          : "direct";
  return {
    reportUsability,
    mustCallTools,
    shouldCallEnvironmentDataMcp: mustCallTools.includes("environment_data_mcp"),
    authorityBoundary: inferAuthorityBoundary(input.evidenceItems),
    privateKnowledgeUsed: input.projectIds.length > 0 || input.evidenceItems.some(isPrivateEvidence),
    publicAuthorityUsed: input.evidenceItems.some(
      (item) =>
        (item.authorityLayer === "core" || item.authorityLayer === "method" || item.authorityLayer === "local") &&
        (item.legalStatus === "current_effective" || !item.legalStatus)
    ),
    standardCoverage: input.standardCoverage,
    blockingReasons: input.blockingReasons,
    safeForReportSection:
      reportUsability === "insufficient"
        ? []
        : mustCallTools.length
          ? ["basis", "method", "interpretation", "draft_text"]
          : ["basis", "method", "interpretation", "draft_text", "data_conclusion"]
  };
}

function isPrivateEvidence(item: EvidenceItem): boolean {
  return (
    item.visibility === "tenant" ||
    item.visibility === "project" ||
    item.sourceScope === "tenant_private" ||
    item.sourceScope === "project_private" ||
    item.sourceScope === "generated_report" ||
    item.authorityLayer === "project"
  );
}

function buildScopeAudit(options: QueryOptions | undefined, evidenceItems: EvidenceItem[]): QueryResult["scopeAudit"] {
  const privateEvidenceCount = evidenceItems.filter(isPrivateEvidence).length;
  const publicEvidenceCount = evidenceItems.filter((item) => !isPrivateEvidence(item)).length;
  const warnings: string[] = [];
  if (options?.scope === "tenant_only" && !options.tenantId) {
    warnings.push("tenant_only_scope_without_tenant_id");
  }
  if (options?.scope === "project_only" && !options.projectId) {
    warnings.push("project_only_scope_without_project_id");
  }
  if (privateEvidenceCount && options?.scope === "public_only") {
    warnings.push("private_evidence_returned_in_public_scope");
  }
  return {
    requestedScope: options?.scope,
    tenantId: options?.tenantId,
    projectId: options?.projectId,
    privateEvidenceCount,
    publicEvidenceCount,
    warnings
  };
}

function retrievalStatusDebug(
  retrievalReady: Awaited<ReturnType<typeof ensureRetrievalReady>>
): NonNullable<RetrievalDebugInfo["retrievalStatus"]> {
  return {
    staleBeforeQuery: retrievalReady.staleBeforeQuery,
    repaired: retrievalReady.repaired,
    warnings: retrievalReady.warnings
  };
}

function finalizeToolRouting(
  base: ToolRoutingDecision,
  modelRecommendedNextTool?: QueryResult["recommendedNextTool"]
): ToolRoutingDecision {
  const baseConfidence = base.confidence ?? 0.75;
  const canTrustModelDataSuggestion =
    modelRecommendedNextTool &&
    modelRecommendedNextTool !== base.finalNextTool &&
    baseConfidence < 0.8 &&
    (base.dataSignals.length > 0 || base.dataNeeded === true) &&
    (modelRecommendedNextTool === "environment_data_mcp" || modelRecommendedNextTool === "both");
  const finalNextTool = canTrustModelDataSuggestion ? modelRecommendedNextTool : base.finalNextTool;
  return {
    ...base,
    modelRecommendedNextTool,
    finalNextTool,
    conflictResolvedBy:
      modelRecommendedNextTool && modelRecommendedNextTool === base.finalNextTool
        ? "model_agreement"
        : canTrustModelDataSuggestion
          ? "fallback"
          : base.conflictResolvedBy,
    reasons:
      modelRecommendedNextTool && modelRecommendedNextTool !== base.finalNextTool
        ? uniqueStrings([
            ...base.reasons,
            canTrustModelDataSuggestion
              ? `model_suggested_${modelRecommendedNextTool}_accepted_due_to_low_confidence_data_signals`
              : `model_suggested_${modelRecommendedNextTool}_but_policy_kept_${base.finalNextTool}`
          ])
        : base.reasons
  };
}

function summarizeCurrentStatus(evidenceItems: EvidenceItem[]): string | undefined {
  const statuses = uniqueBy(
    evidenceItems.map((item) => [item.standardCode, item.legalStatus].filter(Boolean).join("=")).filter(Boolean),
    (item) => item
  );
  if (!statuses.length) {
    return undefined;
  }
  return statuses.slice(0, 5).join("; ");
}

function formatEvidenceSet(evidenceItems: EvidenceItem[]): string {
  if (!evidenceItems.length) {
    return "No evidence was retrieved from the vault or web search.";
  }
  return evidenceItems
    .map((item) =>
      [
        `[${item.id}] kind=${item.kind} citation=${item.citation}`,
        `title=${item.title}`,
        item.authorityLayer ? `authority_layer=${item.authorityLayer}` : undefined,
        item.legalStatus ? `legal_status=${item.legalStatus}` : undefined,
        item.documentRole ? `document_role=${item.documentRole}` : undefined,
        item.standardCode ? `standard_code=${item.standardCode}` : undefined,
        item.standardIdentity ? `standard_identity=${item.standardIdentity}` : undefined,
        item.evidenceRole ? `evidence_role=${item.evidenceRole}` : undefined,
        item.reportingPeriod ? `reporting_period=${item.reportingPeriod}` : undefined,
        item.visibility ? `visibility=${item.visibility}` : undefined,
        item.region ? `region=${item.region}` : undefined,
        item.chunkId ? `chunk_id=${item.chunkId}` : undefined,
        item.chunkHeading ? `chunk_heading=${item.chunkHeading}` : undefined,
        item.chunkKind ? `chunk_kind=${item.chunkKind}` : undefined,
        item.chunkLocation ? `chunk_location=${item.chunkLocation}` : undefined,
        item.factId ? `fact_id=${item.factId}` : undefined,
        item.factStableId ? `fact_stable_id=${item.factStableId}` : undefined,
        item.factOrdinal ? `fact_ordinal=${item.factOrdinal}` : undefined,
        item.factLegacyIds?.length ? `fact_legacy_ids=${item.factLegacyIds.join("|")}` : undefined,
        item.factType ? `fact_type=${item.factType}` : undefined,
        item.factTable ? `fact_table=${item.factTable}` : undefined,
        item.factClauseNo ? `clause_no=${item.factClauseNo}` : undefined,
        item.factTableNo ? `table_no=${item.factTableNo}` : undefined,
        item.factFormulaNo ? `formula_no=${item.factFormulaNo}` : undefined,
        item.factSourceSection ? `source_section=${item.factSourceSection}` : undefined,
        item.factProvenance ? `fact_provenance=${item.factProvenance}` : undefined,
        "",
        item.excerpt
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n")
    )
    .join("\n\n---\n\n");
}

function evidenceIdAliasMap(evidenceItems: EvidenceItem[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const addAlias = (alias: string | undefined, id: string): void => {
    const normalized = alias?.trim();
    if (!normalized) {
      return;
    }
    if (aliases.has(normalized) || aliases.has(normalized.toLowerCase())) {
      return;
    }
    aliases.set(normalized, id);
    aliases.set(normalized.toLowerCase(), id);
  };
  for (const item of evidenceItems) {
    const itemAliases = [
      item.id,
      `[${item.id}]`,
      item.citation,
      item.pageId,
      item.sourceId,
      item.chunkId,
      item.factId,
      item.factStableId,
      ...(item.factLegacyIds ?? []),
      ...(item.canonicalAliases ?? [])
    ];
    if (item.sourceId && item.chunkId) {
      itemAliases.push(`${item.sourceId}#${item.chunkId}`);
    }
    if (item.factOrdinal) {
      itemAliases.push(`fact:${item.factOrdinal}`);
      if (item.factType) {
        itemAliases.push(`fact:${item.factOrdinal}:${item.factType}`);
      }
    }
    for (const factAlias of [item.factId, item.factStableId, ...(item.factLegacyIds ?? [])].filter((alias): alias is string =>
      Boolean(alias)
    )) {
      if (item.sourceId) {
        itemAliases.push(`${item.sourceId}#${factAlias}`);
        itemAliases.push(`source:${item.sourceId}:${factAlias}`);
        if (/^fact:[0-9]+(?::[a-z_]+)?$/i.test(factAlias)) {
          itemAliases.push(`${item.sourceId}#source:${item.sourceId}:${factAlias}`);
        }
      }
      if (item.pageId) {
        itemAliases.push(`${item.pageId}#${factAlias}`);
      }
    }
    for (const alias of itemAliases) {
      addAlias(alias, item.id);
    }
  }
  return aliases;
}

function normalizeAnswerEvidenceCitations(
  answer: string,
  evidenceItems: EvidenceItem[]
): { answer: string; evidenceIdAliases: Record<string, string>; warnings: string[] } {
  const aliasMap = evidenceIdAliasMap(evidenceItems);
  const evidenceIdAliases = Object.fromEntries(aliasMap.entries());
  const warnings: string[] = [];
  const normalizedAnswer = answer.replace(/\[([^\][]+)\]/g, (match, raw: string) => {
    const key = raw.trim();
    const id = aliasMap.get(key) ?? aliasMap.get(key.toLowerCase());
    if (!id || key === id) {
      return match;
    }
    warnings.push(`normalized_citation:${truncate(key, 80)}->${id}`);
    return `[${id}]`;
  });
  return {
    answer: normalizedAnswer,
    evidenceIdAliases,
    warnings: uniqueStrings(warnings)
  };
}

function parseEvidenceIds(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return uniqueBy(
    [...text.matchAll(/\[(E[0-9]+)\]/g)].map((match) => match[1]),
    (item) => item
  );
}

function strictExactQueryTerms(question: string): string[] {
  const standardFragments = new Set(
    extractStandardFragments(question).flatMap((item) => [item.number, item.year, item.compact, item.familyNumberCompact].filter(Boolean))
  );
  return uniqueBy(
    (question.match(/[a-z0-9][a-z0-9.-]*[0-9][a-z0-9.-]*/gi) ?? [])
      .map((term) => term.toLowerCase().replace(/[^a-z0-9]/g, ""))
      .filter((term) => term.length >= 3 && !standardFragments.has(term)),
    (item) => item
  ).slice(0, 8);
}

function extractStandardFragments(
  question: string
): Array<{ number: string; year?: string; compact: string; familyNumberCompact: string }> {
  return buildEnvAirQueryPlan(question).standardRefs.map((ref) => ({
    number: ref.number.toLowerCase(),
    year: ref.year?.toLowerCase(),
    compact: ref.compact.toLowerCase(),
    familyNumberCompact: `${ref.family}${ref.number}`.toLowerCase()
  }));
}

function normalizeEvidenceTerm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[₀０]/g, "0")
    .replace(/[₁１]/g, "1")
    .replace(/[₂２]/g, "2")
    .replace(/[₃３]/g, "3")
    .replace(/[₄４]/g, "4")
    .replace(/[₅５]/g, "5")
    .replace(/[₆６]/g, "6")
    .replace(/[₇７]/g, "7")
    .replace(/[₈８]/g, "8")
    .replace(/[₉９]/g, "9")
    .replace(/[^a-z0-9\p{Script=Han}]/gu, "");
}

function evidenceContainsExactTerms(evidenceItems: EvidenceItem[], terms: string[]): string[] {
  const haystack = evidenceItems
    .map((item) =>
      [
        item.title,
        item.standardCode,
        item.standardIdentity,
        item.citation,
        item.chunkId,
        item.chunkHeading,
        item.factId,
        item.factType,
        item.factRawText,
        item.excerpt
      ]
        .filter(Boolean)
        .join(" ")
    )
    .join("\n")
    .split(/\n/)
    .map(normalizeEvidenceTerm)
    .join("\n");
  return terms.filter((term) => !haystack.includes(term));
}

function evidenceContainsRequiredAliases(evidenceItems: EvidenceItem[], aliasGroups: string[][]): string[] {
  if (!aliasGroups.length) {
    return [];
  }
  const haystack = evidenceItems
    .map((item) =>
      [
        item.title,
        item.standardCode,
        item.standardIdentity,
        item.citation,
        item.chunkId,
        item.chunkHeading,
        item.factId,
        item.factType,
        item.factRawText,
        item.excerpt
      ]
        .filter(Boolean)
        .join(" ")
    )
    .join("\n");
  const normalizedHaystack = normalizeEvidenceTerm(haystack);
  return aliasGroups
    .filter((group) => !group.some((alias) => normalizedHaystack.includes(normalizeEvidenceTerm(alias))))
    .map((group) => group[0] ?? "pollutant");
}

function requiredStandardLabels(queryPlan: ReturnType<typeof buildEnvAirQueryPlan>): string[] {
  return uniqueStrings(standardRefsForExactRetrieval(queryPlan).map((ref) => standardIdentityKey(ref)));
}

function buildStandardCoverage(requiredStandards: string[], evidenceItems: EvidenceItem[]): StandardCoverage[] {
  return requiredStandards.map((standard) => {
    const matchingEvidence = evidenceItems.filter((item) => (item.standardIdentity || standardIdentityKey(item.standardCode)) === standard);
    const evidenceIds = matchingEvidence.map((item) => item.id);
    const statuses = uniqueStrings(matchingEvidence.map((item) => item.legalStatus ?? ""));
    return {
      standard,
      required: true,
      covered: evidenceIds.length > 0,
      evidenceIds,
      status: statuses.join("|") || undefined
    };
  });
}

function evidenceCompletenessFromCoverage(standardCoverage: StandardCoverage[]): NonNullable<QueryResult["evidenceCompleteness"]> {
  const requiredStandards = standardCoverage.filter((item) => item.required).map((item) => item.standard);
  const coveredStandards = standardCoverage.filter((item) => item.required && item.covered).map((item) => item.standard);
  const missingStandards = standardCoverage.filter((item) => item.required && !item.covered).map((item) => item.standard);
  const authorityPinnedEvidenceCount = standardCoverage.reduce((total, item) => total + item.evidenceIds.length, 0);
  return {
    requiredStandards,
    coveredStandards,
    missingStandards,
    authorityPinnedEvidenceCount
  };
}

function answerLooksIncomplete(question: string, answer: string): boolean {
  const normalized = answer.trim();
  if (!normalized) {
    return true;
  }
  const compactQuestion = question.replace(/\s+/g, "");
  const yesNoQuestion = /(是否|能否|可否|是不是|能不能|吗|should|can|whether)/i.test(compactQuestion);
  if (!yesNoQuestion && normalized.length < 80) {
    return true;
  }
  if (/(如下|包括|分别是|主要|第[0-9一二三四五六七八九十]+章|为|：|:)$/.test(normalized)) {
    return true;
  }
  if (/(多少|哪些|区别|改了什么|怎么处理|分别做什么|是什么)/.test(compactQuestion)) {
    const sentenceCount = (normalized.match(/[。！？.!?]/g) ?? []).length;
    const hasStructure = /(^|\n)\s*[-*0-9一二三四五六七八九十]+[、.)．]/m.test(normalized) || normalized.includes("|");
    if (!hasStructure && sentenceCount < 2) {
      return true;
    }
  }
  return false;
}

function evaluateGrounding(input: { evidenceItems: EvidenceItem[]; answer: string; structured?: GroundedAnswer }): {
  citations: string[];
  usedEvidenceIds: string[];
  invalidCitations: string[];
  evidenceState: QueryResult["evidenceState"];
  groundingWarnings: string[];
} {
  const evidenceById = new Map(input.evidenceItems.map((item) => [item.id, item]));
  const evidenceAliases = new Map<string, string>();
  for (const item of input.evidenceItems) {
    const aliases = [
      item.id,
      `[${item.id}]`,
      item.citation,
      item.pageId,
      item.sourceId,
      item.chunkId,
      item.factId,
      item.factStableId,
      ...(item.factLegacyIds ?? []),
      ...(item.canonicalAliases ?? [])
    ].filter((alias): alias is string => Boolean(alias));
    if (item.factOrdinal) {
      aliases.push(`fact:${item.factOrdinal}`);
      if (item.factType) {
        aliases.push(`fact:${item.factOrdinal}:${item.factType}`);
      }
    }
    for (const factAlias of [item.factId, item.factStableId, ...(item.factLegacyIds ?? [])].filter((alias): alias is string =>
      Boolean(alias)
    )) {
      if (item.sourceId) {
        aliases.push(`${item.sourceId}#${factAlias}`);
        aliases.push(`source:${item.sourceId}:${factAlias}`);
        if (/^fact:[0-9]+(?::[a-z_]+)?$/i.test(factAlias)) {
          aliases.push(`${item.sourceId}#source:${item.sourceId}:${factAlias}`);
        }
      }
      if (item.pageId) {
        aliases.push(`${item.pageId}#${factAlias}`);
      }
    }
    for (const alias of aliases) {
      if (!evidenceAliases.has(alias)) {
        evidenceAliases.set(alias, item.id);
      }
    }
  }
  const structuredIds = input.structured?.usedEvidenceIds ?? [];
  const inlineIds = parseEvidenceIds(input.answer);
  const proposedIds = uniqueBy(inlineIds.length ? inlineIds : structuredIds, (item) => item);
  const resolvedIds = uniqueBy(
    proposedIds.map((id) => evidenceAliases.get(id) ?? id),
    (item) => item
  );
  const invalidCitations = proposedIds.filter((id) => !evidenceAliases.has(id) && !evidenceById.has(id));
  const usedEvidenceIds = resolvedIds.filter((id) => evidenceById.has(id));
  const groundingWarnings: string[] = [];

  if (!input.evidenceItems.length) {
    groundingWarnings.push("no_retrieved_evidence");
    return {
      citations: [],
      usedEvidenceIds: [],
      invalidCitations,
      evidenceState: "insufficient",
      groundingWarnings
    };
  }
  if (!usedEvidenceIds.length) {
    groundingWarnings.push("answer_missing_evidence_ids");
  }
  for (const claim of input.structured?.unsupportedClaims ?? []) {
    groundingWarnings.push(`unsupported_claim:${claim}`);
  }
  for (const missing of input.structured?.missingEvidence ?? []) {
    groundingWarnings.push(`missing_evidence:${missing}`);
  }
  if (invalidCitations.length) {
    groundingWarnings.push(`invalid_evidence_ids:${invalidCitations.join(",")}`);
  }

  const effectiveIds = usedEvidenceIds.length ? usedEvidenceIds : input.evidenceItems.map((item) => item.id);
  const citations = uniqueBy(
    effectiveIds.map((id) => evidenceById.get(id)?.citation).filter((citation): citation is string => Boolean(citation)),
    (item) => item
  );
  const evidenceState: QueryResult["evidenceState"] = groundingWarnings.length || !usedEvidenceIds.length ? "partial" : "grounded";
  return { citations, usedEvidenceIds: effectiveIds, invalidCitations, evidenceState, groundingWarnings };
}

async function executeQuery(
  rootDir: string,
  question: string,
  format: OutputFormat,
  options: { gapFill?: boolean; gapFillTask?: "queryProvider" | "exploreProvider"; queryOptions?: QueryOptions } = {}
): Promise<QueryExecutionResult> {
  const { paths, config } = await loadVaultConfig(rootDir);
  const domainProfile = await loadDomainProfile(rootDir, config);
  const schemas = await loadVaultSchemas(rootDir);
  const provider = await getProviderForTask(rootDir, "queryProvider");
  if (!(await fileExists(paths.searchDbPath)) || !(await fileExists(paths.graphPath))) {
    await compileVault(rootDir, {});
  }
  const retrievalReady = await ensureRetrievalReady(rootDir, {
    policy: options.queryOptions?.retrievalStalePolicy ?? config.retrieval?.queryStalePolicy
  });

  const gapFillTask = options.gapFillTask ?? "queryProvider";
  const webResults: { title: string; url: string; snippet: string }[] = [];
  if (options.gapFill) {
    try {
      const webSearch = await getWebSearchAdapterForTask(rootDir, gapFillTask);
      const results = await webSearch.search(question, 5);
      webResults.push(...results);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `gap-fill requested but no usable "${gapFillTask}" web search provider is configured. ${message} Add webSearch.providers and webSearch.tasks.${gapFillTask} to swarmvault.config.json.`
      );
    }
  }

  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const pageMap = new Map((graph?.pages ?? []).map((page) => [page.id, page]));
  const sourceProjects = Object.fromEntries(
    (graph?.pages ?? [])
      .filter((page) => page.kind === "source" && page.sourceIds.length)
      .map((page) => [page.sourceIds[0], page.projectIds[0] ?? null])
  );
  const queryPlan = buildDomainQueryPlan(question, domainProfile, options.queryOptions);
  const searchOptions = buildQuerySearchOptions(options.queryOptions);
  searchOptions.domainProfile = domainProfile;
  const temporalNeedsHistorical =
    queryPlan.temporalIntent.mode === "evaluation_period" || queryPlan.temporalIntent.mode === "historical_as_of";
  if (temporalNeedsHistorical) {
    searchOptions.includeSuperseded = true;
  }
  const baseToolRouting = classifyEnvAirToolRouting(question, domainProfile);
  const recommendedNextTool = baseToolRouting.finalNextTool;
  const dataToolHints = buildEnvironmentDataToolHints(question, domainProfile);
  const currentBasisIntent =
    options.queryOptions?.intent === "current_basis" ||
    options.queryOptions?.intent === "report_writing" ||
    options.queryOptions?.requireCurrentBasis ||
    queryPlan.currentBasisIntent;
  const currentBasisQuery = currentBasisIntent && !temporalNeedsHistorical;
  if ((queryPlan.standardRefs.length > 0 || temporalNeedsHistorical) && !currentBasisQuery) {
    delete searchOptions.authorityLayer;
    delete searchOptions.documentRole;
    delete searchOptions.legalStatus;
    searchOptions.includeSuperseded = true;
  }
  const searchResults = await searchVault(rootDir, question, searchOptions);
  queryPlan.stages.push(
    {
      name: "standard_exact",
      status: queryPlan.standardRefs.length || queryPlan.pinnedStandards.length ? "used" : "skipped",
      reason: queryPlan.standardRefs.length ? "explicit or domain-pinned standard references" : "no standard reference inferred",
      resultCount: searchResults.filter((result) => result.retrievalStage === "standard_exact").length
    },
    {
      name: "structured_fact",
      status: searchResults.some((result) => result.retrievalStage === "structured_fact") ? "used" : "planned",
      resultCount: searchResults.filter((result) => result.retrievalStage === "structured_fact").length
    },
    {
      name: "chunk_fts",
      status: searchResults.some((result) => result.retrievalStage === "chunk_fts") ? "used" : "planned",
      resultCount: searchResults.filter((result) => result.retrievalStage === "chunk_fts").length
    },
    {
      name: "page_retrieval",
      status: searchResults.length ? "used" : "skipped",
      resultCount: searchResults.length
    }
  );
  const requiredStandards = requiredStandardLabels(queryPlan);
  const retrievalPlan: NonNullable<RetrievalDebugInfo["queryPlan"]> = {
    normalizedQuery: queryPlan.normalizedQuery,
    profileId: domainProfile.id,
    intent: options.queryOptions?.intent,
    scope: options.queryOptions?.scope,
    standardRefs: queryPlan.standardRefs.map((ref) => ref.normalized),
    expandedTerms: queryPlan.expandedTerms,
    pinnedStandards: queryPlan.pinnedStandards,
    standardClusters: queryPlan.standardClusters,
    matchedIntentRules: queryPlan.matchedIntentRules,
    temporalIntent: queryPlan.temporalIntent,
    requiredStandards,
    coveredStandards: [],
    missingStandards: requiredStandards,
    authorityPinnedEvidenceCount: 0,
    rankingSignals: queryPlan.rankingSignals,
    factTypeBoosts: queryPlan.factTypeBoosts,
    documentRoleBoosts: queryPlan.documentRoleBoosts,
    evidenceRoleBoosts: queryPlan.evidenceRoleBoosts,
    chunkTermBoosts: queryPlan.chunkTermBoosts,
    recommendedNextTool,
    toolRouting: baseToolRouting,
    stages: queryPlan.stages
  };
  const excerpts = await Promise.all(
    searchResults.map(async (result) => {
      if (result.chunkId && result.snippet.trim()) {
        const chunkMeta = [
          result.chunkHeading ? `Chunk heading: ${result.chunkHeading}` : undefined,
          result.chunkKind ? `Chunk kind: ${result.chunkKind}` : undefined,
          result.chunkLocation ? `Chunk location: ${result.chunkLocation}` : undefined
        ]
          .filter((item): item is string => Boolean(item))
          .join("\n");
        return [`# ${result.title}`, chunkMeta, result.snippet].filter(Boolean).join("\n");
      }
      const absolutePath = path.join(paths.wikiDir, result.path);
      try {
        const content = await fs.readFile(absolutePath, "utf8");
        const parsed = matter(content);
        return `# ${result.title}\n${truncate(normalizeWhitespace(parsed.content), 1200)}`;
      } catch {
        return `# ${result.title}\n${result.snippet}`;
      }
    })
  );

  const relatedPageIds = uniqueBy(
    searchResults.map((result) => result.pageId),
    (item) => item
  );
  const relatedNodeIds = uniqueBy(
    relatedPageIds.flatMap((pageId) => pageMap.get(pageId)?.nodeIds ?? []),
    (item) => item
  );
  const relatedSourceIds = uniqueBy(
    relatedPageIds.flatMap((pageId) => pageMap.get(pageId)?.sourceIds ?? []),
    (item) => item
  );
  const pageProjectIds = scopedProjectIdsFromSources(relatedSourceIds, sourceProjects);
  const explicitProjectIds =
    options.queryOptions?.projectId && options.queryOptions.scope !== "public_only" ? [options.queryOptions.projectId] : [];
  const schemaProjectIds = uniqueStrings([...explicitProjectIds, ...pageProjectIds, ...schemaProjectIdsFromPages(relatedPageIds, pageMap)]);
  const querySchema = composeVaultSchema(
    schemas.root,
    schemaProjectIds
      .map((projectId) => schemas.projects[projectId])
      .filter((schema): schema is NonNullable<typeof schema> => Boolean(schema?.hash))
  );

  const manifests = await listManifests(rootDir);
  const rawExcerpts: string[] = [];
  for (const sourceId of relatedSourceIds.slice(0, 5)) {
    const manifest = manifests.find((item) => item.sourceId === sourceId);
    if (!manifest) {
      continue;
    }
    const text = await readExtractedText(rootDir, manifest);
    if (text) {
      rawExcerpts.push(`# [source:${sourceId}] ${manifest.title}\n${truncate(normalizeWhitespace(text), 800)}`);
    }
  }

  const webExcerpts = webResults.map(
    (result) => `# ${result.title} [${result.url}]\n${truncate(normalizeWhitespace(result.snippet), 600)}`
  );
  const evidenceItems: EvidenceItem[] = [];
  searchResults.forEach((result, index) => {
    const page = pageMap.get(result.pageId);
    const sourceId = page?.sourceIds[0];
    evidenceItems.push({
      id: `E${evidenceItems.length + 1}`,
      kind: "source",
      citation: sourceId ? (result.chunkId ? `${sourceId}#${result.chunkId}` : sourceId) : result.pageId,
      pageId: result.pageId,
      sourceId,
      chunkId: result.chunkId,
      chunkHeading: result.chunkHeading,
      chunkKind: result.chunkKind,
      chunkLocation: result.chunkLocation,
      title: result.title,
      authorityLayer: result.authorityLayer,
      legalStatus: result.legalStatus,
      documentRole: result.documentRole,
      standardCode: result.standardCode,
      standardIdentity: result.standardIdentity,
      evidenceRole: result.evidenceRole,
      reportingPeriod: result.reportingPeriod,
      evidencePeriod: result.evidencePeriod,
      visibility: result.visibility,
      tenantId: result.tenantId,
      sourceScope: result.sourceScope,
      factId: result.factId,
      factStableId: result.factStableId,
      factOrdinal: result.factOrdinal,
      factLegacyIds: result.factLegacyIds,
      factType: result.factType,
      factTable: result.factTable,
      factRawText: result.factRawText,
      factClauseNo: result.factClauseNo,
      factTableNo: result.factTableNo,
      factFormulaNo: result.factFormulaNo,
      factSourceSection: result.factSourceSection,
      factSubject: result.factSubject,
      factPredicate: result.factPredicate,
      factObjectValue: result.factObjectValue,
      factQualifiers: result.factQualifiers,
      factProvenance: result.factProvenance,
      region: result.region,
      canonicalAliases: uniqueStrings(
        [result.factId, result.factStableId, ...(result.factLegacyIds ?? []), result.chunkId, result.pageId, sourceId].filter(
          (alias): alias is string => Boolean(alias)
        )
      ),
      excerpt: truncate(normalizeWhitespace(excerpts[index] ?? result.snippet), 1800)
    });
  });
  webResults.forEach((result) => {
    evidenceItems.push({
      id: `E${evidenceItems.length + 1}`,
      kind: "web",
      citation: result.url,
      title: result.title,
      excerpt: truncate(normalizeWhitespace(result.snippet), 600)
    });
  });
  if (queryPlan.rankingSignals.includes("authority_boundary_question")) {
    evidenceItems.push({
      id: `E${evidenceItems.length + 1}`,
      kind: "source",
      citation: `schema:${querySchema.hash}`,
      title: "Vault schema authority-boundary rules",
      excerpt: truncate(
        normalizeWhitespace(
          [
            "Knowledge-base authority rules for environmental air work:",
            "mandatory/current-effective standards and regulations are execution basis;",
            "research papers, reports, gazettes, white papers, interpretations, drafts and compilation notes are explanatory or reference materials unless an effective legal instrument explicitly incorporates them.",
            querySchema.content
          ].join("\n")
        ),
        1400
      )
    });
  }
  const evidenceLayers = splitEvidenceByAuthority(evidenceItems, currentBasisQuery);
  const evidenceForCoverage = currentBasisQuery && evidenceLayers.primary.length ? evidenceLayers.primary : evidenceItems;
  const standardCoverage = buildStandardCoverage(requiredStandards, evidenceForCoverage);
  const evidenceCompleteness = evidenceCompletenessFromCoverage(standardCoverage);
  retrievalPlan.coveredStandards = evidenceCompleteness.coveredStandards;
  retrievalPlan.missingStandards = evidenceCompleteness.missingStandards;
  retrievalPlan.authorityPinnedEvidenceCount = evidenceCompleteness.authorityPinnedEvidenceCount;

  if (!evidenceItems.length) {
    const answer = [
      "知识库中没有检索到足够证据来回答这个问题。",
      recommendedNextTool === "environment_data_mcp"
        ? "这个问题更像是监测数据查询或计算分析，应优先调用环境数据 MCP 工具。"
        : recommendedNextTool === "both"
          ? "建议先调用环境数据 MCP 获取监测数据，再结合知识库中的标准和技术依据进行解释。"
          : "可以补充更明确的标准名称、地区、污染物或业务场景后重新查询。"
    ].join("\n\n");
    return {
      answer,
      citations: [],
      relatedPageIds,
      relatedNodeIds,
      relatedSourceIds,
      schemaHash: querySchema.hash,
      projectIds: pageProjectIds,
      evidenceState: "insufficient",
      groundingWarnings: ["no_retrieved_evidence"],
      invalidCitations: [],
      recommendedNextTool,
      toolRouting: baseToolRouting,
      answerBasis: inferAnswerBasis(options.queryOptions, recommendedNextTool, queryPlan.temporalIntent),
      currentStatus: undefined,
      dataToolHints,
      agentDecision: buildAgentDecision({
        evidenceState: "insufficient",
        recommendedNextTool,
        evidenceItems: currentBasisQuery && evidenceLayers.primary.length ? evidenceLayers.primary : evidenceItems,
        projectIds: pageProjectIds,
        standardCoverage,
        blockingReasons: ["no_retrieved_evidence"]
      }),
      standardCoverage,
      evidenceSet: evidenceItems,
      primaryEvidenceSet: evidenceLayers.primary,
      supportingEvidenceSet: evidenceLayers.supporting,
      excludedEvidenceSet: evidenceLayers.excluded,
      evidenceCompleteness,
      temporalIntent: queryPlan.temporalIntent,
      scopeAudit: buildScopeAudit(options.queryOptions, evidenceItems),
      retrievalDebug: options.queryOptions?.debugContext
        ? {
            query: question,
            searchOptions: searchOptions as unknown as Record<string, unknown>,
            queryPlan: retrievalPlan,
            retrievalStatus: retrievalStatusDebug(retrievalReady),
            evidenceItems,
            usedEvidenceIds: [],
            warnings: ["no_retrieved_evidence"]
          }
        : undefined
    };
  }
  const strictGrounding = options.queryOptions?.strictGrounding || options.queryOptions?.evidenceMode === "strict";
  const pollutantAliasGroups = pollutantAliasGroupsForQuery(question, options.queryOptions?.pollutants);
  const standardAliasGroups = standardAliasGroupsForQuery(question);
  const aliasTerms = new Set(pollutantAliasGroups.flatMap((group) => group.map(normalizeEvidenceTerm)));
  const exactTerms = strictExactQueryTerms(question).filter((term) => !aliasTerms.has(term));
  const missingExactTerms = strictGrounding ? evidenceContainsExactTerms(evidenceItems, exactTerms) : [];
  const missingAliasGroups = strictGrounding ? evidenceContainsRequiredAliases(evidenceItems, pollutantAliasGroups) : [];
  const missingStandardGroups = strictGrounding ? evidenceContainsRequiredAliases(evidenceItems, standardAliasGroups) : [];
  const strictMissingTerms = uniqueStrings([...missingExactTerms, ...missingAliasGroups]);
  const strictMissingStandards = uniqueStrings(missingStandardGroups);
  const strictMissingShouldBlock = recommendedNextTool !== "environment_data_mcp";
  if ((strictMissingTerms.length || strictMissingStandards.length) && strictMissingShouldBlock) {
    const warnings = [
      ...(strictMissingTerms.length ? [`strict_exact_terms_not_found:${strictMissingTerms.join(",")}`] : []),
      ...(strictMissingStandards.length ? [`strict_required_standard_not_found:${strictMissingStandards.join(",")}`] : [])
    ];
    const missingLabels = [...strictMissingTerms, ...strictMissingStandards];
    return {
      answer: `知识库检索到了相关背景材料，但没有检索到问题中关键精确项（${missingLabels.join(", ")}）的直接证据，因此不能给出有依据的结论。`,
      citations: [],
      relatedPageIds,
      relatedNodeIds,
      relatedSourceIds,
      schemaHash: querySchema.hash,
      projectIds: pageProjectIds,
      evidenceState: "insufficient",
      groundingWarnings: warnings,
      invalidCitations: [],
      recommendedNextTool,
      toolRouting: baseToolRouting,
      answerBasis: inferAnswerBasis(options.queryOptions, recommendedNextTool, queryPlan.temporalIntent),
      currentStatus: summarizeCurrentStatus(currentBasisQuery && evidenceLayers.primary.length ? evidenceLayers.primary : evidenceItems),
      dataToolHints,
      agentDecision: buildAgentDecision({
        evidenceState: "insufficient",
        recommendedNextTool,
        evidenceItems,
        projectIds: pageProjectIds,
        standardCoverage,
        blockingReasons: warnings
      }),
      standardCoverage,
      evidenceSet: evidenceItems,
      primaryEvidenceSet: evidenceLayers.primary,
      supportingEvidenceSet: evidenceLayers.supporting,
      excludedEvidenceSet: evidenceLayers.excluded,
      evidenceCompleteness,
      temporalIntent: queryPlan.temporalIntent,
      scopeAudit: buildScopeAudit(options.queryOptions, evidenceItems),
      retrievalDebug: options.queryOptions?.debugContext
        ? {
            query: question,
            searchOptions: searchOptions as unknown as Record<string, unknown>,
            queryPlan: retrievalPlan,
            retrievalStatus: retrievalStatusDebug(retrievalReady),
            evidenceItems,
            usedEvidenceIds: [],
            warnings
          }
        : undefined
    };
  }

  let answer: string;
  let usage: QueryExecutionResult["usage"];
  let structuredAnswer: GroundedAnswer | undefined;
  const evidenceIdAliases = Object.fromEntries(evidenceIdAliasMap(evidenceItems).entries());
  const providerWarnings: string[] =
    strictMissingTerms.length && !strictMissingShouldBlock ? [`strict_exact_terms_not_found:${strictMissingTerms.join(",")}`] : [];
  if (strictMissingStandards.length && !strictMissingShouldBlock) {
    providerWarnings.push(`strict_required_standard_not_found:${strictMissingStandards.join(",")}`);
  }
  if (provider.type === "heuristic") {
    answer = formatHeuristicAnswer(question, excerpts, rawExcerpts, searchResults, format);
  } else {
    const context = [
      currentBasisQuery ? "Primary evidence set:" : "Evidence set:",
      formatEvidenceSet(currentBasisQuery ? evidenceLayers.primary : evidenceItems),
      ...(currentBasisQuery && evidenceLayers.supporting.length
        ? ["", "Supporting evidence set:", formatEvidenceSet(evidenceLayers.supporting)]
        : []),
      ...(currentBasisQuery && evidenceLayers.excluded.length
        ? [
            "",
            "Excluded from current execution basis:",
            evidenceLayers.excluded.map((item) => `[${item.id}] ${item.title}: ${item.exclusionReason}`).join("\n")
          ]
        : []),
      "",
      ...(webExcerpts.length ? ["Web search evidence:", webExcerpts.join("\n\n---\n\n"), ""] : []),
      "Wiki context:",
      excerpts.join("\n\n---\n\n"),
      ...(rawExcerpts.length ? ["", "Raw source material:", rawExcerpts.join("\n\n---\n\n")] : [])
    ].join("\n\n");
    const system = buildSchemaPrompt(
      querySchema,
      [
        `Current date: ${new Date().toISOString().slice(0, 10)}.`,
        "You answer for environmental air pollution regulatory and technical work.",
        "Use only the provided evidence set. Cite evidence item IDs like [E1] for every substantive claim.",
        "For current-basis questions, answer execution requirements from the primary evidence set first; supporting evidence can explain background but must not override or create binding requirements.",
        "Evidence items may include chunk_id, chunk_heading, chunk_kind, and chunk_location; prefer table/formula chunks for limits, formulas, and numeric requirements.",
        "Distinguish mandatory/current-effective standards from recommended guides, drafts, explanations, and historical versions.",
        "Research papers, bulletins, white papers, public interpretations, and technical guides may explain background or method choices, but they cannot by themselves be stated as enforcement or mandatory execution basis.",
        "Drafts, consultation versions, compilation explanations, and superseded standards must be labeled as draft, explanatory, historical, or superseded unless another current-effective source makes them binding.",
        "When answering authority-boundary questions, cite the schema/rule evidence if present and state which materials are mandatory basis, recommended guidance, explanatory background, historical/evolution material, or local-only practice.",
        "When a user asks about a named historical standard, explain that standard and its replacement status instead of answering only with the current replacement.",
        "For current-basis questions, prioritize current effective standards and explicitly mark drafts/history as non-binding.",
        "For local questions, state jurisdiction boundaries and do not generalize local口径 to other regions.",
        "Only recommend environment_data_mcp when the user asks for actual monitoring data, station/city/time-window values, rankings,同比/环比, abnormal time-series diagnosis, or process analysis. Do not recommend it for pure standard limits, formulas, methods, version relationships, or authority-boundary questions.",
        "Do not apply knowledge-base standard limit values directly to proxy metrics or derived values produced by a data MCP unless the evidence states that the calculation and averaging period are the same compliance metric.",
        "For report-writing answers, separate standard basis, monitoring data, statistical conclusion, professional interpretation, and caveats.",
        "If evidence is insufficient, say so instead of filling gaps from general knowledge.",
        outputFormatInstruction(format)
      ].join(" ")
    );
    const wantsStructuredGrounding =
      provider.capabilities.has("structured") &&
      (options.queryOptions?.debugContext || options.queryOptions?.strictGrounding || options.queryOptions?.evidenceMode === "strict");
    if (wantsStructuredGrounding) {
      try {
        structuredAnswer = await provider.generateStructured(
          {
            system,
            prompt: [
              `Question: ${question}`,
              "",
              context,
              "",
              "Return JSON with: answer, usedEvidenceIds, unsupportedClaims, missingEvidence, recommendedNextTool, standardCoverage, evidenceCompleteness."
            ].join("\n")
          },
          groundedAnswerSchema,
          {
            schemaName: "grounded_answer",
            allowedEvidenceIds: evidenceItems.map((item) => item.id),
            evidenceIdAliases,
            repairWarnings: providerWarnings
          }
        );
        answer = structuredAnswer.answer;
        if (answerLooksIncomplete(question, answer)) {
          providerWarnings.push("structured_answer_incomplete_fallback");
          const response = await provider.generateText({
            system,
            prompt: `Question: ${question}\n\n${context}`
          });
          answer = response.text;
          usage = response.usage;
          structuredAnswer = undefined;
        }
      } catch (error) {
        providerWarnings.push(`structured_query_fallback:${error instanceof Error ? error.message : String(error)}`);
        const response = await provider.generateText({
          system,
          prompt: `Question: ${question}\n\n${context}`
        });
        answer = response.text;
        usage = response.usage;
      }
    } else {
      const response = await provider.generateText({
        system,
        prompt: `Question: ${question}\n\n${context}`
      });
      answer = response.text;
      usage = response.usage;
    }
  }

  const normalizedCitations = normalizeAnswerEvidenceCitations(answer, evidenceItems);
  answer = normalizedCitations.answer;
  providerWarnings.push(...normalizedCitations.warnings);
  const grounding = evaluateGrounding({ evidenceItems, answer, structured: structuredAnswer });
  const heuristicGapFillWebEvidence =
    options.gapFill && provider.type === "heuristic" ? evidenceItems.filter((item) => item.kind === "web") : [];
  const finalCitations = uniqueBy(
    [
      ...grounding.citations,
      ...heuristicGapFillWebEvidence.map((item) => item.citation).filter((citation): citation is string => Boolean(citation))
    ],
    (item) => item
  );
  const finalUsedEvidenceIds = uniqueBy(
    [...grounding.usedEvidenceIds, ...heuristicGapFillWebEvidence.map((item) => item.id)],
    (item) => item
  );
  const groundingWarnings = uniqueBy([...grounding.groundingWarnings, ...providerWarnings], (item) => item);
  const evidenceStateWarnings = groundingWarnings.filter((warning) => !warning.startsWith("normalized_citation:"));
  const evidenceState =
    grounding.evidenceState === "insufficient" ? "insufficient" : evidenceStateWarnings.length ? "partial" : grounding.evidenceState;
  const finalToolRouting = finalizeToolRouting(baseToolRouting, structuredAnswer?.recommendedNextTool);
  const finalRecommendedNextTool = finalToolRouting.finalNextTool;

  return {
    answer,
    citations: finalCitations,
    relatedPageIds,
    relatedNodeIds,
    relatedSourceIds,
    schemaHash: querySchema.hash,
    projectIds: pageProjectIds,
    usage,
    evidenceState,
    groundingWarnings,
    invalidCitations: grounding.invalidCitations,
    recommendedNextTool: finalRecommendedNextTool,
    toolRouting: finalToolRouting,
    answerBasis: inferAnswerBasis(options.queryOptions, finalRecommendedNextTool, queryPlan.temporalIntent),
    currentStatus: summarizeCurrentStatus(currentBasisQuery && evidenceLayers.primary.length ? evidenceLayers.primary : evidenceItems),
    dataToolHints,
    agentDecision: buildAgentDecision({
      evidenceState,
      recommendedNextTool: finalRecommendedNextTool,
      evidenceItems: currentBasisQuery && evidenceLayers.primary.length ? evidenceLayers.primary : evidenceItems,
      projectIds: pageProjectIds,
      standardCoverage,
      blockingReasons: groundingWarnings
    }),
    standardCoverage,
    evidenceSet: evidenceItems,
    primaryEvidenceSet: evidenceLayers.primary,
    supportingEvidenceSet: evidenceLayers.supporting,
    excludedEvidenceSet: evidenceLayers.excluded,
    evidenceCompleteness,
    temporalIntent: queryPlan.temporalIntent,
    scopeAudit: buildScopeAudit(options.queryOptions, evidenceItems),
    retrievalDebug: options.queryOptions?.debugContext
      ? {
          query: question,
          searchOptions: searchOptions as unknown as Record<string, unknown>,
          queryPlan: retrievalPlan,
          retrievalStatus: retrievalStatusDebug(retrievalReady),
          evidenceItems,
          usedEvidenceIds: finalUsedEvidenceIds,
          warnings: groundingWarnings
        }
      : undefined
  };
}

async function generateFollowUpQuestions(rootDir: string, question: string, answer: string): Promise<string[]> {
  const provider = await getProviderForTask(rootDir, "queryProvider");
  const schema = (await loadVaultSchemas(rootDir)).effective.global;

  if (provider.type === "heuristic") {
    return uniqueBy(
      [
        `What evidence best supports ${question}?`,
        `What contradicts ${question}?`,
        `Which sources should be added to answer ${question} better?`
      ],
      (item) => item
    ).slice(0, 3);
  }

  const response = await provider.generateStructured(
    {
      system: buildSchemaPrompt(schema, "Propose concise follow-up research questions for the vault. Return only useful next questions."),
      prompt: `Root question: ${question}\n\nCurrent answer:\n${answer}`
    },
    z.object({
      questions: z.array(z.string().min(1)).max(5)
    })
  );

  return uniqueBy(response.questions, (item) => item).filter((item) => item !== question);
}

export async function refreshVaultAfterOutputSave(rootDir: string): Promise<void> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const schemas = await loadVaultSchemas(rootDir);
  const manifests = await listManifests(rootDir);
  const sourceProjects = resolveSourceProjects(rootDir, manifests, config);
  const cachedAnalyses = manifests.length ? await loadAvailableCachedAnalyses(paths, manifests) : [];
  const codeIndex = await buildCodeIndex(rootDir, manifests, cachedAnalyses);
  const analyses = cachedAnalyses.map((analysis) => {
    const manifest = manifests.find((item) => item.sourceId === analysis.sourceId);
    return manifest ? enrichResolvedCodeImports(manifest, analysis, codeIndex) : analysis;
  });
  const storedOutputs = await loadSavedOutputPages(paths.wikiDir);
  const storedInsights = await loadInsightPages(paths.wikiDir);
  const storedMemoryPages = await loadMemoryTaskPages(rootDir);
  const currentDomainProfileHash = await domainProfileHash(rootDir, config);
  await syncVaultArtifacts(rootDir, {
    schemas,
    manifests,
    analyses,
    codeIndex,
    sourceProjects,
    outputPages: storedOutputs.map((page) => page.page),
    insightPages: storedInsights.map((page) => page.page),
    memoryRecords: storedMemoryPages.map((record) => ({ page: record.page, content: record.content })),
    memoryTasks: storedMemoryPages.map((record) => record.task),
    outputHashes: pageHashes(storedOutputs),
    insightHashes: pageHashes(storedInsights),
    memoryHashes: memoryTaskHashes(storedMemoryPages),
    domainProfileHash: currentDomainProfileHash,
    domainProfile: await loadDomainProfile(rootDir, config),
    previousState: await readJsonFile<CompileState>(paths.compileStatePath),
    approve: false,
    promoteCandidates: false
  });
}

function resolveApprovalTargets(manifest: ApprovalManifest, targets: string[]): ApprovalEntry[] {
  const pendingEntries = manifest.entries.filter((entry) => entry.status === "pending");
  if (!targets.length) {
    return pendingEntries;
  }

  const resolved = pendingEntries.filter(
    (entry) =>
      targets.includes(entry.pageId) ||
      (entry.nextPath ? targets.includes(entry.nextPath) : false) ||
      (entry.previousPath ? targets.includes(entry.previousPath) : false)
  );
  if (!resolved.length) {
    throw new Error(`No pending approval entries matched: ${targets.join(", ")}`);
  }
  return uniqueBy(resolved, (entry) => `${entry.pageId}:${entry.nextPath ?? ""}:${entry.previousPath ?? ""}`);
}

function emptyCompileState(): CompileState {
  return {
    generatedAt: new Date().toISOString(),
    rootSchemaHash: "",
    projectSchemaHashes: {},
    effectiveSchemaHashes: {
      global: "",
      projects: {}
    },
    projectConfigHash: "",
    analyses: {},
    sourceHashes: {},
    sourceSemanticHashes: {},
    sourceProjects: {},
    outputHashes: {},
    insightHashes: {},
    candidateHistory: {}
  };
}

function updateCandidateHistory(compileState: CompileState, page: GraphPage | null, deleted = false): void {
  if (!page || (page.kind !== "concept" && page.kind !== "entity")) {
    return;
  }
  if (deleted) {
    delete compileState.candidateHistory[page.id];
    return;
  }
  compileState.candidateHistory[page.id] = {
    sourceIds: page.sourceIds,
    status: page.status === "candidate" ? "candidate" : "active"
  };
}

function sortGraphPages(pages: GraphPage[]): GraphPage[] {
  return [...pages].sort((left, right) => left.path.localeCompare(right.path) || left.title.localeCompare(right.title));
}

function diffLines(current: string, staged: string): ApprovalDiffLine[] {
  const currentLines = current.split("\n");
  const stagedLines = staged.split("\n");
  const n = currentLines.length;
  const m = stagedLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = currentLines[i] === stagedLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: ApprovalDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && currentLines[i] === stagedLines[j]) {
      lines.push({ type: "context", value: currentLines[i] });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      lines.push({ type: "add", value: stagedLines[j] });
      j++;
    } else {
      lines.push({ type: "remove", value: currentLines[i] });
      i++;
    }
  }
  return lines;
}

function computeUnifiedDiff(current: string, staged: string, label: string): string {
  const output: string[] = [`--- a/${label}`, `+++ b/${label}`];
  for (const line of diffLines(current, staged)) {
    const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    output.push(`${prefix}${line.value}`);
  }
  return output.join("\n");
}

const PROTECTED_FRONTMATTER_FIELDS = new Set([
  "page_id",
  "source_ids",
  "node_ids",
  "freshness",
  "source_hashes",
  "source_semantic_hashes",
  "schema_hash"
]);

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function compareFrontmatter(currentData: Record<string, unknown>, stagedData: Record<string, unknown>): ApprovalFrontmatterChange[] {
  const keys = new Set<string>([...Object.keys(currentData), ...Object.keys(stagedData)]);
  const changes: ApprovalFrontmatterChange[] = [];
  for (const key of keys) {
    const before = currentData[key];
    const after = stagedData[key];
    if (stableSerialize(before) === stableSerialize(after)) continue;
    changes.push({
      key,
      before,
      after,
      protected: PROTECTED_FRONTMATTER_FIELDS.has(key)
    });
  }
  return changes.sort((left, right) => left.key.localeCompare(right.key));
}

function computeStructuredDiff(
  current: string | undefined,
  staged: string | undefined,
  isBinaryAsset: boolean
): ApprovalStructuredDiff | undefined {
  if (isBinaryAsset) {
    return {
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      frontmatterChanges: []
    };
  }
  if (!current && !staged) return undefined;

  let currentData: Record<string, unknown> = {};
  let stagedData: Record<string, unknown> = {};
  let currentBody = current ?? "";
  let stagedBody = staged ?? "";
  if (current) {
    const parsed = matter(current);
    currentData = parsed.data ?? {};
    currentBody = parsed.content;
  }
  if (staged) {
    const parsed = matter(staged);
    stagedData = parsed.data ?? {};
    stagedBody = parsed.content;
  }

  const lines = diffLines(currentBody, stagedBody);
  const addedLines = lines.filter((line) => line.type === "add").length;
  const removedLines = lines.filter((line) => line.type === "remove").length;
  const hunks: ApprovalDiffHunk[] = lines.length
    ? [
        {
          oldStart: 1,
          oldLines: currentBody.split("\n").length,
          newStart: 1,
          newLines: stagedBody.split("\n").length,
          lines
        }
      ]
    : [];

  return {
    hunks,
    addedLines,
    removedLines,
    frontmatterChanges: compareFrontmatter(currentData, stagedData)
  };
}

function computeChangeSummary(current: string | undefined, staged: string | undefined, changeType: ApprovalChangeType): string {
  if (changeType === "create") return "New page";
  if (changeType === "delete") return "Removed page";
  if (changeType === "promote") return "Promoted from candidate";
  if (!current || !staged) return "Updated page";

  const currentParsed = matter(current);
  const stagedParsed = matter(staged);
  const changes: string[] = [];

  const currentTags = (currentParsed.data.tags ?? []) as string[];
  const stagedTags = (stagedParsed.data.tags ?? []) as string[];
  const addedTags = stagedTags.filter((t: string) => !currentTags.includes(t));
  const removedTags = currentTags.filter((t: string) => !stagedTags.includes(t));
  if (addedTags.length) changes.push(`added ${addedTags.length} tag(s)`);
  if (removedTags.length) changes.push(`removed ${removedTags.length} tag(s)`);

  if (currentParsed.data.title !== stagedParsed.data.title) changes.push("updated title");

  const currentLines = currentParsed.content.trim().split("\n").length;
  const stagedLines = stagedParsed.content.trim().split("\n").length;
  const lineDelta = stagedLines - currentLines;
  if (lineDelta > 0) changes.push(`added ${lineDelta} line(s)`);
  else if (lineDelta < 0) changes.push(`removed ${Math.abs(lineDelta)} line(s)`);
  else if (currentParsed.content !== stagedParsed.content) changes.push("modified content");

  return changes.length ? changes.join(", ") : "no visible changes";
}

export async function listApprovals(rootDir: string): Promise<ApprovalSummary[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifests = await Promise.all(
    (await fs.readdir(paths.approvalsDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await readApprovalManifest(paths, entry.name);
        } catch {
          return null;
        }
      })
  );

  return manifests
    .filter((manifest): manifest is ApprovalManifest => Boolean(manifest))
    .map(approvalSummary)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readApproval(rootDir: string, approvalId: string, options?: { diff?: boolean }): Promise<ApprovalDetail> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifest = await readApprovalManifest(paths, approvalId);
  const details = await Promise.all(
    manifest.entries.map(async (entry) => {
      const currentPath = entry.previousPath ?? entry.nextPath;
      const currentContent = currentPath
        ? await fs.readFile(path.join(paths.wikiDir, currentPath), "utf8").catch(() => undefined)
        : undefined;
      const stagedContent = entry.nextPath
        ? await fs.readFile(path.join(paths.approvalsDir, approvalId, "wiki", entry.nextPath), "utf8").catch(() => undefined)
        : undefined;
      const detail: ApprovalEntryDetail = {
        ...entry,
        currentContent,
        stagedContent
      };
      detail.changeSummary = computeChangeSummary(detail.currentContent, detail.stagedContent, detail.changeType);

      const isBinaryAsset = detail.kind === "output";
      const structured = computeStructuredDiff(detail.currentContent, detail.stagedContent, isBinaryAsset);
      if (structured) {
        detail.structuredDiff = structured;
        const protectedChanges = structured.frontmatterChanges.filter((change) => change.protected);
        if (protectedChanges.length) {
          detail.warnings = ["protected_frontmatter_changed"];
        }
      }
      if (options?.diff && detail.currentContent && detail.stagedContent && !isBinaryAsset) {
        detail.diff = computeUnifiedDiff(detail.currentContent, detail.stagedContent, detail.nextPath ?? detail.pageId);
      }
      return detail;
    })
  );

  return {
    ...approvalSummary(manifest),
    entries: details
  };
}

export async function acceptApproval(rootDir: string, approvalId: string, targets: string[] = []): Promise<ReviewActionResult> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const manifest = await readApprovalManifest(paths, approvalId);
  const selectedEntries = resolveApprovalTargets(manifest, targets);
  const bundleGraph = await readJsonFile<GraphArtifact>(approvalGraphPath(paths, approvalId));
  const currentGraph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const basePages =
    currentGraph?.pages ??
    (bundleGraph?.pages ?? []).filter((page) => page.kind === "index" || page.kind === "output" || page.kind === "insight");
  let nextPages = [...basePages];
  const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();

  for (const entry of selectedEntries) {
    if (entry.changeType !== "delete") {
      if (!entry.nextPath) {
        throw new Error(`Approval entry ${entry.pageId} is missing a staged path.`);
      }
      const stagedAbsolutePath = path.join(paths.approvalsDir, approvalId, "wiki", entry.nextPath);
      const stagedContent = await fs.readFile(stagedAbsolutePath, "utf8");
      const targetAbsolutePath = path.join(paths.wikiDir, entry.nextPath);
      await ensureDir(path.dirname(targetAbsolutePath));
      await fs.writeFile(targetAbsolutePath, stagedContent, "utf8");

      if (entry.changeType === "promote" && entry.previousPath) {
        await fs.rm(path.join(paths.wikiDir, entry.previousPath), { force: true });
      }

      const nextPage =
        bundleGraph?.pages.find((page) => page.id === entry.pageId && page.path === entry.nextPath) ??
        parseStoredPage(entry.nextPath, stagedContent);
      if (nextPage.kind === "output" && nextPage.outputAssets?.length) {
        const outputAssetDir = path.join(paths.wikiDir, "outputs", "assets", path.basename(nextPage.path, ".md"));
        await fs.rm(outputAssetDir, { recursive: true, force: true });
        for (const asset of nextPage.outputAssets) {
          const stagedAssetPath = path.join(paths.approvalsDir, approvalId, "wiki", asset.path);
          if (!(await fileExists(stagedAssetPath))) {
            continue;
          }
          const targetAssetPath = path.join(paths.wikiDir, asset.path);
          await ensureDir(path.dirname(targetAssetPath));
          await fs.copyFile(stagedAssetPath, targetAssetPath);
        }
      }
      nextPages = nextPages.filter(
        (page) => page.id !== entry.pageId && page.path !== entry.nextPath && (!entry.previousPath || page.path !== entry.previousPath)
      );
      nextPages.push(nextPage);
      updateCandidateHistory(compileState, nextPage);
    } else {
      const deletedPage =
        nextPages.find((page) => page.id === entry.pageId || page.path === entry.previousPath) ??
        bundleGraph?.pages.find((page) => page.id === entry.pageId || page.path === entry.previousPath) ??
        null;
      if (entry.previousPath) {
        await fs.rm(path.join(paths.wikiDir, entry.previousPath), { force: true });
      }
      if (deletedPage?.kind === "output") {
        await fs.rm(path.join(paths.wikiDir, "outputs", "assets", path.basename(deletedPage.path, ".md")), {
          recursive: true,
          force: true
        });
      }
      nextPages = nextPages.filter((page) => page.id !== entry.pageId && page.path !== entry.previousPath);
      updateCandidateHistory(compileState, deletedPage, true);
    }
    entry.status = "accepted";
  }

  const nextGraph: GraphArtifact = {
    generatedAt: new Date().toISOString(),
    nodes: currentGraph?.nodes ?? bundleGraph?.nodes ?? [],
    edges: currentGraph?.edges ?? bundleGraph?.edges ?? [],
    hyperedges: currentGraph?.hyperedges ?? bundleGraph?.hyperedges ?? [],
    sources: currentGraph?.sources ?? bundleGraph?.sources ?? [],
    pages: sortGraphPages(nextPages)
  };
  compileState.generatedAt = nextGraph.generatedAt;

  await writeJsonFile(paths.graphPath, nextGraph);
  await writeJsonFile(paths.compileStatePath, compileState);
  await refreshIndexesAndSearch(rootDir, nextGraph.pages);
  await writeApprovalManifest(paths, manifest);
  if (manifest.sourceSessionId) {
    await updateGuidedSourceSessionStatus(rootDir, manifest.sourceSessionId, "accepted");
  }
  await recordSession(rootDir, {
    operation: "review",
    title: `Accepted review entries from ${approvalId}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: selectedEntries.map((entry) => entry.pageId),
    changedPages: selectedEntries.flatMap((entry) =>
      [entry.nextPath, entry.previousPath].filter((value): value is string => Boolean(value))
    ),
    lines: selectedEntries.map((entry) => `accepted=${entry.pageId}`)
  });

  return {
    ...approvalSummary(manifest),
    updatedEntries: selectedEntries.map((entry) => entry.pageId)
  };
}

export async function rejectApproval(rootDir: string, approvalId: string, targets: string[] = []): Promise<ReviewActionResult> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const manifest = await readApprovalManifest(paths, approvalId);
  const selectedEntries = resolveApprovalTargets(manifest, targets);
  for (const entry of selectedEntries) {
    entry.status = "rejected";
  }
  await writeApprovalManifest(paths, manifest);
  if (manifest.sourceSessionId) {
    await updateGuidedSourceSessionStatus(rootDir, manifest.sourceSessionId, "rejected");
  }
  await recordSession(rootDir, {
    operation: "review",
    title: `Rejected review entries from ${approvalId}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: selectedEntries.map((entry) => entry.pageId),
    changedPages: [],
    lines: selectedEntries.map((entry) => `rejected=${entry.pageId}`)
  });

  return {
    ...approvalSummary(manifest),
    updatedEntries: selectedEntries.map((entry) => entry.pageId)
  };
}

export async function listCandidates(rootDir: string): Promise<CandidateRecord[]> {
  const pages = await listPages(rootDir);
  const candidates = pages.filter(
    (page): page is GraphPage & { kind: "concept" | "entity" } =>
      page.status === "candidate" && (page.kind === "concept" || page.kind === "entity")
  );

  // Best-effort scoring using the auto-promotion gates. If config/graph/state
  // can't be loaded, fall back to records without scores rather than failing.
  let scoreLookup: Map<string, { score: number; breakdown: Record<string, number> }> | null = null;
  try {
    const { config, paths } = await loadVaultConfig(rootDir);
    const promotionConfig = resolvePromotionConfig(config);
    const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
    if (graph) {
      const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();
      const now = Date.now();
      const decisions = candidates.map((page) =>
        evaluateCandidateForPromotion(page, graph, compileState.candidateHistory, promotionConfig, now)
      );
      scoreLookup = new Map(
        decisions.map((decision) => [
          decision.pageId,
          {
            score: decision.score,
            breakdown: Object.fromEntries(decision.gates.map((gate) => [gate.gate, gate.value]))
          }
        ])
      );
    }
  } catch {
    scoreLookup = null;
  }

  return candidates
    .map((page) => {
      const scored = scoreLookup?.get(page.id);
      return {
        pageId: page.id,
        title: page.title,
        kind: page.kind,
        path: page.path,
        activePath: candidateActivePath(page),
        sourceIds: page.sourceIds,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        ...(scored ? { score: scored.score, scoreBreakdown: scored.breakdown } : {})
      };
    })
    .sort((left, right) => {
      const ls = left.score ?? -1;
      const rs = right.score ?? -1;
      if (ls !== rs) return rs - ls;
      return left.title.localeCompare(right.title);
    });
}

function resolveCandidateTarget(pages: GraphPage[], target: string): GraphPage {
  const candidate = pages.find((page) => page.status === "candidate" && (page.id === target || page.path === target));
  if (!candidate || (candidate.kind !== "concept" && candidate.kind !== "entity")) {
    throw new Error(`Candidate not found: ${target}`);
  }
  return candidate;
}

export async function promoteCandidate(rootDir: string, target: string): Promise<CandidateRecord> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const candidate = resolveCandidateTarget(graph?.pages ?? [], target);
  const raw = await fs.readFile(path.join(paths.wikiDir, candidate.path), "utf8");
  const parsed = matter(raw);
  const nextUpdatedAt = new Date().toISOString();
  const nextContent = matter.stringify(parsed.content, {
    ...parsed.data,
    status: "active",
    updated_at: nextUpdatedAt,
    tags: uniqueStrings([candidate.kind, ...((Array.isArray(parsed.data.tags) ? parsed.data.tags : []) as string[])]).filter(
      (tag) => tag !== "candidate"
    )
  });
  const nextPath = candidateActivePath(candidate);
  const nextAbsolutePath = path.join(paths.wikiDir, nextPath);
  await ensureDir(path.dirname(nextAbsolutePath));
  await fs.writeFile(nextAbsolutePath, nextContent, "utf8");
  await fs.rm(path.join(paths.wikiDir, candidate.path), { force: true });

  const nextPage = parseStoredPage(nextPath, nextContent, { createdAt: candidate.createdAt, updatedAt: nextUpdatedAt });
  const nextPages = sortGraphPages(
    (graph?.pages ?? []).filter((page) => page.id !== candidate.id && page.path !== candidate.path).concat(nextPage)
  );
  const nextGraph: GraphArtifact = {
    generatedAt: nextUpdatedAt,
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
    hyperedges: graph?.hyperedges ?? [],
    sources: graph?.sources ?? [],
    pages: nextPages
  };
  const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();
  compileState.generatedAt = nextUpdatedAt;
  updateCandidateHistory(compileState, nextPage);

  await writeJsonFile(paths.graphPath, nextGraph);
  await writeJsonFile(paths.compileStatePath, compileState);
  await refreshIndexesAndSearch(rootDir, nextPages);
  await recordSession(rootDir, {
    operation: "candidate",
    title: `Promoted ${candidate.id}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: [candidate.id],
    changedPages: [candidate.path, nextPath],
    lines: [`promoted=${candidate.id}`]
  });

  return {
    pageId: nextPage.id,
    title: nextPage.title,
    kind: nextPage.kind as "concept" | "entity",
    path: nextPage.path,
    activePath: nextPage.path,
    sourceIds: nextPage.sourceIds,
    createdAt: nextPage.createdAt,
    updatedAt: nextPage.updatedAt
  };
}

function resolvePromotionConfig(config: VaultConfig): CandidatePromotionConfig {
  const overrides = config.candidate?.autoPromote ?? {};
  return { ...DEFAULT_PROMOTION_CONFIG, ...overrides };
}

function promotionSessionTitle(promotionConfig: CandidatePromotionConfig): string {
  return promotionConfig.dryRun ? "auto-promote-dry-run" : "auto-promote";
}

export async function runAutoPromotion(rootDir: string, options: { dryRun?: boolean } = {}): Promise<PromotionSession> {
  const startedAt = new Date().toISOString();
  const { config, paths } = await loadVaultConfig(rootDir);
  const base = resolvePromotionConfig(config);
  const promotionConfig: CandidatePromotionConfig = { ...base, dryRun: options.dryRun ?? base.dryRun };
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();

  const candidates = (graph?.pages ?? []).filter(
    (page): page is GraphPage & { kind: "concept" | "entity" } =>
      page.status === "candidate" && (page.kind === "concept" || page.kind === "entity")
  );

  const now = Date.now();
  const decisions: PromotionDecision[] = candidates.map((page) =>
    evaluateCandidateForPromotion(page, graph as GraphArtifact, compileState.candidateHistory, promotionConfig, now)
  );

  const sorted = sortDecisionsForPromotion(decisions);
  const acceptedIds = sorted
    .filter((decision) => decision.promote)
    .slice(0, promotionConfig.maxPerRun)
    .map((d) => d.pageId);
  const skippedIds = sorted.filter((decision) => !acceptedIds.includes(decision.pageId)).map((d) => d.pageId);

  const promotedPageIds: string[] = [];
  if (!promotionConfig.dryRun) {
    for (const pageId of acceptedIds) {
      try {
        await promoteCandidate(rootDir, pageId);
        promotedPageIds.push(pageId);
      } catch {
        // Candidate may have been archived or promoted by another process between
        // the evaluation snapshot and this apply step; record it as skipped.
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const sessionBody = renderPromotionSessionMarkdown(decisions, promotedPageIds, {
    dryRun: promotionConfig.dryRun,
    startedAt,
    finishedAt
  });

  const { sessionPath } = await recordSession(rootDir, {
    operation: "candidate",
    title: promotionSessionTitle(promotionConfig),
    startedAt,
    finishedAt,
    success: true,
    relatedPageIds: decisions.map((decision) => decision.pageId),
    changedPages: promotedPageIds,
    lines: [
      `mode=${promotionConfig.dryRun ? "dry-run" : "applied"}`,
      `evaluated=${decisions.length}`,
      `promoted=${promotedPageIds.length}`,
      ...sessionBody.split("\n")
    ]
  });
  return {
    startedAt,
    finishedAt,
    dryRun: promotionConfig.dryRun,
    promotedPageIds,
    skippedPageIds: skippedIds,
    decisions: sorted,
    sessionPath
  };
}

export async function previewCandidatePromotions(rootDir: string): Promise<PromotionDecision[]> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const promotionConfig = resolvePromotionConfig(config);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();
  const candidates = (graph?.pages ?? []).filter(
    (page): page is GraphPage & { kind: "concept" | "entity" } =>
      page.status === "candidate" && (page.kind === "concept" || page.kind === "entity")
  );
  const now = Date.now();
  return sortDecisionsForPromotion(
    candidates.map((page) =>
      evaluateCandidateForPromotion(page, graph as GraphArtifact, compileState.candidateHistory, promotionConfig, now)
    )
  );
}

/**
 * Human-in-the-loop supersession: wire up a `superseded_by` edge between
 * two existing pages and flip the older page's frontmatter to stale. The
 * edge is written into `state/graph.json` and the older page's markdown
 * file is updated via `markSuperseded`. Caller supplies either page ids
 * or page paths for resolution convenience.
 */
export async function createSupersessionEdge(
  rootDir: string,
  oldPageIdOrPath: string,
  newPageIdOrPath: string
): Promise<{
  oldPageId: string;
  newPageId: string;
  edgeId: string;
  graphPath: string;
  updatedPagePath: string;
}> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("No compiled graph found. Run `swarmvault compile` first.");
  }
  const byIdOrPath = (target: string): GraphPage | undefined => graph.pages.find((page) => page.id === target || page.path === target);
  const oldPage = byIdOrPath(oldPageIdOrPath);
  const newPage = byIdOrPath(newPageIdOrPath);
  if (!oldPage) {
    throw new Error(`Supersession source page not found: ${oldPageIdOrPath}`);
  }
  if (!newPage) {
    throw new Error(`Supersession replacement page not found: ${newPageIdOrPath}`);
  }
  if (oldPage.id === newPage.id) {
    throw new Error("Supersession requires two distinct pages.");
  }

  const now = new Date();
  const nextOldPage = markSuperseded(oldPage, newPage.id, now);

  // Rewrite the older page's frontmatter in place.
  const oldAbsolutePath = path.join(paths.wikiDir, oldPage.path);
  if (await fileExists(oldAbsolutePath)) {
    const current = await fs.readFile(oldAbsolutePath, "utf8");
    const parsed = matter(current);
    const nextData: Record<string, unknown> = {
      ...parsed.data,
      freshness: "stale",
      decay_score: 0,
      superseded_by: newPage.id,
      updated_at: nextOldPage.updatedAt
    };
    await fs.writeFile(oldAbsolutePath, matter.stringify(parsed.content, nextData), "utf8");
  }

  const resolveNodeId = (pageId: string): string => {
    const node = graph.nodes.find((item) => item.pageId === pageId);
    return node?.id ?? pageId;
  };
  const sourceNodeId = resolveNodeId(oldPage.id);
  const targetNodeId = resolveNodeId(newPage.id);
  const edgeId = `${sourceNodeId}->${targetNodeId}:superseded_by`;
  const edge: GraphEdge = {
    id: edgeId,
    source: sourceNodeId,
    target: targetNodeId,
    relation: "superseded_by",
    status: "inferred",
    evidenceClass: "inferred",
    confidence: 1,
    provenance: [oldPage.id, newPage.id]
  };

  const nextEdges = graph.edges.filter((existing) => existing.id !== edgeId).concat(edge);
  const nextPages = graph.pages.map((page) => (page.id === oldPage.id ? nextOldPage : page));
  const nextGraph: GraphArtifact = {
    ...graph,
    generatedAt: now.toISOString(),
    edges: nextEdges,
    pages: nextPages
  };
  await writeJsonFile(paths.graphPath, nextGraph);

  await recordSession(rootDir, {
    operation: "supersede",
    title: `Superseded ${oldPage.id} by ${newPage.id}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: [oldPage.id, newPage.id],
    changedPages: [oldPage.path],
    lines: [`old=${oldPage.id}`, `new=${newPage.id}`, `edge=${edgeId}`]
  });

  return {
    oldPageId: oldPage.id,
    newPageId: newPage.id,
    edgeId,
    graphPath: paths.graphPath,
    updatedPagePath: oldPage.path
  };
}

export async function archiveCandidate(rootDir: string, target: string): Promise<CandidateRecord> {
  const startedAt = new Date().toISOString();
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  const candidate = resolveCandidateTarget(graph?.pages ?? [], target);
  await fs.rm(path.join(paths.wikiDir, candidate.path), { force: true });

  const nextPages = sortGraphPages((graph?.pages ?? []).filter((page) => page.id !== candidate.id && page.path !== candidate.path));
  const nextGraph: GraphArtifact = {
    generatedAt: new Date().toISOString(),
    nodes: graph?.nodes ?? [],
    edges: graph?.edges ?? [],
    hyperedges: graph?.hyperedges ?? [],
    sources: graph?.sources ?? [],
    pages: nextPages
  };
  const compileState = (await readJsonFile<CompileState>(paths.compileStatePath)) ?? emptyCompileState();
  compileState.generatedAt = nextGraph.generatedAt;
  updateCandidateHistory(compileState, candidate, true);

  await writeJsonFile(paths.graphPath, nextGraph);
  await writeJsonFile(paths.compileStatePath, compileState);
  await refreshIndexesAndSearch(rootDir, nextPages);
  await recordSession(rootDir, {
    operation: "candidate",
    title: `Archived ${candidate.id}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: true,
    relatedPageIds: [candidate.id],
    changedPages: [candidate.path],
    lines: [`archived=${candidate.id}`]
  });

  return {
    pageId: candidate.id,
    title: candidate.title,
    kind: candidate.kind as "concept" | "entity",
    path: candidate.path,
    activePath: candidateActivePath(candidate),
    sourceIds: candidate.sourceIds,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt
  };
}

async function ensureObsidianWorkspace(rootDir: string): Promise<void> {
  const { config } = await loadVaultConfig(rootDir);
  const obsidianDir = path.join(rootDir, ".obsidian");
  const projectIds = projectEntries(config).map((project) => project.id);
  await ensureDir(obsidianDir);
  await Promise.all([
    writeJsonFile(path.join(obsidianDir, "app.json"), {
      alwaysUpdateLinks: true,
      newFileLocation: "folder",
      newFileFolderPath: "wiki/insights",
      useMarkdownLinks: false,
      attachmentFolderPath: "raw/assets"
    }),
    writeJsonFile(path.join(obsidianDir, "core-plugins.json"), [
      "file-explorer",
      "global-search",
      "switcher",
      "graph",
      "backlink",
      "outgoing-link",
      "tag-pane",
      "page-preview"
    ]),
    writeJsonFile(path.join(obsidianDir, "graph.json"), {
      "collapse-filter": false,
      search: "",
      showTags: true,
      showAttachments: false,
      hideUnresolved: false,
      colorGroups: [
        { query: "tag:#source", color: { a: 1, rgb: 0xf59e0b } },
        { query: "tag:#module", color: { a: 1, rgb: 0xfb7185 } },
        { query: "tag:#concept", color: { a: 1, rgb: 0x0ea5e9 } },
        { query: "tag:#entity", color: { a: 1, rgb: 0x22c55e } },
        { query: "tag:#rationale", color: { a: 1, rgb: 0x14b8a6 } },
        { query: "tag:#symbol", color: { a: 1, rgb: 0x8b5cf6 } },
        ...projectIds.map((projectId, index) => ({
          query: `tag:#project/${projectId}`,
          color: { a: 1, rgb: [0x0ea5e9, 0x22c55e, 0xf59e0b, 0xfb7185, 0x8b5cf6, 0x14b8a6][index % 6] }
        }))
      ],
      localJumps: false
    }),
    writeJsonFile(path.join(obsidianDir, "types.json"), {
      types: {
        page_id: "text",
        kind: "text",
        title: "text",
        tags: "tags",
        aliases: "aliases",
        source_ids: "multitext",
        project_ids: "multitext",
        node_ids: "multitext",
        freshness: "text",
        status: "text",
        confidence: "number",
        created_at: "datetime",
        updated_at: "datetime",
        compiled_from: "multitext",
        managed_by: "text",
        backlinks: "multitext",
        cssclasses: "multitext"
      }
    }),
    writeJsonFile(path.join(obsidianDir, "workspace.json"), {
      active: "root",
      lastOpenFiles: ["wiki/index.md", "wiki/projects/index.md", "wiki/candidates/index.md", "wiki/insights/index.md"],
      left: {
        collapsed: false
      },
      right: {
        collapsed: false
      }
    })
  ]);
}

async function initLiteVault(rootDir: string, options: InitOptions): Promise<void> {
  const rawDir = path.join(rootDir, "raw");
  const wikiDir = path.join(rootDir, "wiki");
  const schemaPath = path.join(rootDir, PRIMARY_SCHEMA_FILENAME);
  const indexPath = path.join(wikiDir, "index.md");
  const logPath = path.join(wikiDir, "log.md");

  await Promise.all([ensureDir(rawDir), ensureDir(wikiDir)]);

  if (!(await fileExists(schemaPath))) {
    await fs.writeFile(schemaPath, defaultVaultSchema("default"), "utf8");
  }

  const now = new Date().toISOString();
  if (!(await fileExists(indexPath))) {
    await fs.writeFile(
      indexPath,
      matter.stringify(
        [
          "# Wiki Index",
          "",
          "This lite vault is agent-maintained. Drop sources into `raw/`, edit `swarmvault.schema.md` to teach the agent how the wiki should be organized, then ask your agent to read sources and update pages here.",
          "",
          "- Summaries, entity pages, and concept pages live under `wiki/`.",
          "- Append every ingest/query/lint operation to `wiki/log.md`.",
          "- Run `swarmvault init` (without `--lite`) when you want the full toolchain with graph, search, and approvals.",
          ""
        ].join("\n"),
        {
          page_id: "wiki:index",
          kind: "index",
          title: "Wiki Index",
          tags: ["index"],
          source_ids: [],
          project_ids: [],
          node_ids: [],
          freshness: "fresh",
          status: "active",
          confidence: 1,
          created_at: now,
          updated_at: now,
          compiled_from: [],
          managed_by: "agent",
          backlinks: [],
          schema_hash: "",
          source_hashes: {},
          source_semantic_hashes: {}
        }
      ),
      "utf8"
    );
  }

  if (!(await fileExists(logPath))) {
    await fs.writeFile(
      logPath,
      matter.stringify(
        [
          "# Activity Log",
          "",
          "Append-only chronological record. One line per ingest/query/lint operation, newest at the bottom.",
          "",
          "Format: `## [YYYY-MM-DD] <verb> | <subject>`",
          ""
        ].join("\n"),
        {
          page_id: "wiki:log",
          kind: "index",
          title: "Activity Log",
          tags: ["log", "append-only"],
          source_ids: [],
          project_ids: [],
          node_ids: [],
          freshness: "fresh",
          status: "active",
          confidence: 1,
          created_at: now,
          updated_at: now,
          compiled_from: [],
          managed_by: "agent",
          backlinks: [],
          schema_hash: "",
          source_hashes: {},
          source_semantic_hashes: {}
        }
      ),
      "utf8"
    );
  }

  if (options.obsidian) {
    const obsidianDir = path.join(rootDir, ".obsidian");
    await ensureDir(obsidianDir);
  }
}

export async function initVault(rootDir: string, options: InitOptions = {}): Promise<void> {
  if (options.lite) {
    await initLiteVault(rootDir, options);
    return;
  }

  const requestedProfile = options.profile ?? "default";
  const { config, paths } = await initWorkspace(rootDir, { profile: requestedProfile });
  const profile = config.profile;
  const isResearchProfile = profile.presets.length > 0 || profile.guidedSessionMode === "canonical_review" || profile.dataviewBlocks;
  await installConfiguredAgents(rootDir);
  const insightsIndexPath = path.join(paths.wikiDir, "insights", "index.md");
  const now = new Date().toISOString();
  await writeFileIfChanged(
    insightsIndexPath,
    matter.stringify(
      (isResearchProfile
        ? [
            "# Insights",
            "",
            "Human-authored research notes live here.",
            "",
            "- Use this folder for thesis notes, reading reflections, synthesis drafts, and decisions you want to keep explicitly human-authored.",
            ...(profile.guidedSessionMode === "canonical_review"
              ? [
                  "- Guided sessions can stage approval-queued updates for canonical pages and fall back to `wiki/insights/` when a claim still needs judgment."
                ]
              : [
                  "- Guided sessions fall back to `wiki/insights/` for exploratory synthesis until you decide what should become canonical."
                ]),
            "- Treat these pages as the human judgment layer for your vault.",
            ""
          ]
        : [
            "# Insights",
            "",
            "Human-authored notes live here.",
            "",
            "- SwarmVault can read these pages during compile and query.",
            "- SwarmVault can stage insight-page updates through guided sessions, but it never applies them without review.",
            ""
          ]
      ).join("\n"),
      {
        page_id: "insights:index",
        kind: "index",
        title: "Insights",
        tags: ["index", "insights"],
        source_ids: [],
        project_ids: [],
        node_ids: [],
        freshness: "fresh",
        status: "active",
        confidence: 1,
        created_at: now,
        updated_at: now,
        compiled_from: [],
        managed_by: "human",
        backlinks: [],
        schema_hash: "",
        source_hashes: {},
        source_semantic_hashes: {}
      }
    )
  );
  await writeFileIfChanged(
    path.join(paths.wikiDir, "projects", "index.md"),
    matter.stringify(["# Projects", "", "- Run `swarmvault compile` to build project rollups.", ""].join("\n"), {
      page_id: "projects:index",
      kind: "index",
      title: "Projects",
      tags: ["index", "projects"],
      source_ids: [],
      project_ids: [],
      node_ids: [],
      freshness: "fresh",
      status: "active",
      confidence: 1,
      created_at: now,
      updated_at: now,
      compiled_from: [],
      managed_by: "system",
      backlinks: [],
      schema_hash: "",
      source_hashes: {},
      source_semantic_hashes: {}
    })
  );
  await writeFileIfChanged(
    path.join(paths.wikiDir, "candidates", "index.md"),
    matter.stringify(["# Candidates", "", "- Run `swarmvault compile` to stage candidate pages.", ""].join("\n"), {
      page_id: "candidates:index",
      kind: "index",
      title: "Candidates",
      tags: ["index", "candidates"],
      source_ids: [],
      project_ids: [],
      node_ids: [],
      freshness: "fresh",
      status: "active",
      confidence: 1,
      created_at: now,
      updated_at: now,
      compiled_from: [],
      managed_by: "system",
      backlinks: [],
      schema_hash: "",
      source_hashes: {},
      source_semantic_hashes: {}
    })
  );
  if (options.obsidian) {
    await ensureObsidianWorkspace(rootDir);
  }

  if (isResearchProfile) {
    await writeFileIfChanged(
      path.join(paths.wikiDir, "insights", "research-playbook.md"),
      matter.stringify(
        [
          `# ${requestedProfile === "personal-research" ? "Personal Research Playbook" : "Research Playbook"}`,
          "",
          "- Add one source at a time with `swarmvault ingest <input> --guide` or `swarmvault source add <input> --guide`.",
          "- Resume a guided session with `swarmvault source session <source-id-or-session-id>` whenever you want to answer the session prompts directly.",
          "- Review `wiki/outputs/source-briefs/`, `wiki/outputs/source-reviews/`, `wiki/outputs/source-guides/`, and `wiki/outputs/source-sessions/` before accepting staged updates.",
          ...(profile.guidedSessionMode === "canonical_review"
            ? ["- Use `swarmvault review show --diff` to inspect staged canonical page edits before accepting them."]
            : ["- Keep exploratory synthesis in `wiki/insights/` until you are ready to promote it into canonical pages."]),
          ...(profile.dataviewBlocks
            ? [
                "- Dataview-friendly fields are enabled in the dashboards, but every generated page should still read cleanly as plain markdown."
              ]
            : []),
          ...(profile.presets.length ? [`- Active profile presets: ${profile.presets.map((preset) => `\`${preset}\``).join(", ")}.`] : []),
          "- Keep unresolved questions visible in `wiki/dashboards/open-questions.md`.",
          "- Use `swarmvault review list` and `swarmvault review show --diff` to decide what becomes canonical.",
          ""
        ].join("\n"),
        {
          page_id: "insights:research-playbook",
          kind: "insight",
          title: requestedProfile === "personal-research" ? "Personal Research Playbook" : "Research Playbook",
          tags: ["insight", "research", "playbook"],
          source_ids: [],
          project_ids: [],
          node_ids: [],
          freshness: "fresh",
          status: "active",
          confidence: 1,
          created_at: now,
          updated_at: now,
          compiled_from: [],
          managed_by: "human",
          backlinks: [],
          schema_hash: "",
          source_hashes: {},
          source_semantic_hashes: {}
        }
      )
    );
  }
}

async function runConfiguredBenchmark(
  rootDir: string,
  config: VaultConfig,
  options: Pick<CompileOptions, "skipBenchmark"> = {}
): Promise<NonNullable<CompileResult["benchmark"]>> {
  if (options.skipBenchmark || config.benchmark?.enabled === false) {
    return { ok: true, skipped: true };
  }

  try {
    await benchmarkVault(rootDir);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarizeAnalysisStats(analyses: SourceAnalysis[]): NonNullable<CompileResult["analysisStats"]> {
  const stats: NonNullable<CompileResult["analysisStats"]> = {
    total: analyses.length,
    provider: 0,
    heuristic: 0,
    vision: 0,
    code: 0,
    empty: 0,
    fallbackCount: 0,
    fallbackRatio: 0,
    failedSourceIds: []
  };
  for (const analysis of analyses) {
    const mode = analysis.analysisMode ?? "heuristic";
    if (mode === "provider") stats.provider += 1;
    else if (mode === "vision") stats.vision += 1;
    else if (mode === "code") stats.code += 1;
    else if (mode === "empty") stats.empty += 1;
    else stats.heuristic += 1;

    const hasProviderFailure = (analysis.warnings ?? []).some((warning) => /provider analysis failed/i.test(warning));
    if (hasProviderFailure) {
      stats.fallbackCount += 1;
      stats.failedSourceIds.push(analysis.sourceId);
    }
  }
  stats.fallbackRatio = stats.total > 0 ? stats.fallbackCount / stats.total : 0;
  return stats;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, maxParallel: number): Promise<T[]> {
  const limit = Math.max(1, maxParallel);
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await tasks[index]();
      }
    })
  );
  return results;
}

function createCompileLifecycle(enabled: boolean | undefined): {
  steps: CompileLifecycleStep[];
  record(phase: string, startedAt: number, details?: Record<string, string | number | boolean | null>, ok?: boolean): void;
} {
  const steps: CompileLifecycleStep[] = [];
  return {
    steps,
    record(phase, startedAt, details, ok = true) {
      if (!enabled) {
        return;
      }
      const finished = Date.now();
      steps.push({
        phase,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - startedAt,
        ok,
        details
      });
    }
  };
}

function attachCompileLifecycle(
  result: CompileResult,
  lifecycle: CompileLifecycleStep[],
  benchmark?: CompileResult["benchmark"]
): CompileResult {
  return {
    ...result,
    ...(benchmark ? { benchmark } : {}),
    ...(lifecycle.length ? { lifecycle } : {})
  };
}

export async function compileVault(rootDir: string, options: CompileOptions = {}): Promise<CompileResult> {
  return withCompileLock(rootDir, options, () => compileVaultUnlocked(rootDir, options));
}

async function compileVaultUnlocked(rootDir: string, options: CompileOptions = {}): Promise<CompileResult> {
  const startedAt = new Date().toISOString();
  const lifecycle = createCompileLifecycle(options.debugLifecycle);
  const initStarted = Date.now();
  const { config, paths } = await initWorkspace(rootDir);
  lifecycle.record("init_workspace", initStarted);
  const domainHashStarted = Date.now();
  const nextDomainProfileHash = await domainProfileHash(rootDir, config);
  lifecycle.record("domain_profile_hash", domainHashStarted, { hash: nextDomainProfileHash.slice(0, 12) });
  const domainProfileStarted = Date.now();
  const domainProfile = await loadDomainProfile(rootDir, config);
  lifecycle.record("load_domain_profile", domainProfileStarted, { profile: domainProfile.id });
  const schemas = await loadVaultSchemas(rootDir);
  const provider = await getProviderForTask(rootDir, "compileProvider");
  const manifests = await listManifests(rootDir);
  const sourceProjects = resolveSourceProjects(rootDir, manifests, config);
  const storedOutputPages = await loadSavedOutputPages(paths.wikiDir);
  const storedInsightPages = await loadInsightPages(paths.wikiDir);
  const storedMemoryPages = await loadMemoryTaskPages(rootDir);
  const outputPages = storedOutputPages.map((page) => page.page);
  const insightPages = storedInsightPages.map((page) => page.page);
  const memoryPages = storedMemoryPages.map((page) => page.page);
  const memoryTasks = storedMemoryPages.map((page) => page.task);
  const currentOutputHashes = pageHashes(storedOutputPages);
  const currentInsightHashes = pageHashes(storedInsightPages);
  const currentMemoryHashes = memoryTaskHashes(storedMemoryPages);

  const previousState = await readJsonFile<CompileState>(paths.compileStatePath);
  const rootSchemaChanged = !previousState || previousState.rootSchemaHash !== schemas.root.hash;
  const effectiveSchemaChanged =
    !previousState ||
    previousGlobalSchemaHash(previousState) !== schemas.effective.global.hash ||
    uniqueStrings([...Object.keys(previousState?.effectiveSchemaHashes?.projects ?? {}), ...Object.keys(schemas.effective.projects)]).some(
      (projectId) => previousProjectSchemaHash(previousState, projectId) !== effectiveHashForProject(schemas, projectId)
    );
  const nextProjectConfigHash = projectConfigHash(config);
  const projectConfigChanged = !previousState || previousState.projectConfigHash !== nextProjectConfigHash;
  const domainProfileChanged = !previousState || previousState.domainProfileHash !== nextDomainProfileHash;
  const previousSourceHashes = previousState?.sourceSemanticHashes ?? previousState?.sourceHashes ?? {};
  const previousAnalyses = previousState?.analyses ?? {};
  const previousSourceProjects = previousState?.sourceProjects ?? {};
  const previousOutputHashes = previousState?.outputHashes ?? {};
  const previousInsightHashes = previousState?.insightHashes ?? {};
  const previousMemoryHashes = previousState?.memoryHashes ?? {};
  const currentSourceIds = new Set(manifests.map((item) => item.sourceId));
  const previousSourceIds = new Set(Object.keys(previousSourceHashes));
  const sourcesChanged =
    currentSourceIds.size !== previousSourceIds.size || [...currentSourceIds].some((sourceId) => !previousSourceIds.has(sourceId));
  const outputsChanged = !recordsEqual(currentOutputHashes, previousOutputHashes);
  const insightsChanged = !recordsEqual(currentInsightHashes, previousInsightHashes);
  const memoryChanged = !recordsEqual(currentMemoryHashes, previousMemoryHashes);
  const artifactsExist = await requiredCompileArtifactsExist(paths);
  const pendingCandidatePromotion = Object.values(previousState?.candidateHistory ?? {}).some((entry) => entry.status === "candidate");

  const dirty: SourceManifest[] = [];
  const clean: SourceManifest[] = [];
  const dirtyReasons: CompileInvalidationReport["dirtyReasons"] = [];
  const forceAnalysis = options.forceAnalysis ?? false;
  for (const manifest of manifests) {
    if (forceAnalysis) {
      if (options.codeOnly && manifest.sourceKind !== "code") {
        clean.push(manifest);
      } else {
        dirty.push(manifest);
        dirtyReasons.push({ sourceId: manifest.sourceId, reasons: ["force_analysis"] });
      }
      continue;
    }
    const hashChanged = previousSourceHashes[manifest.sourceId] !== manifest.semanticHash;
    const noAnalysis = !previousAnalyses[manifest.sourceId];
    const projectId = sourceProjects[manifest.sourceId] ?? null;
    const projectChanged = (previousSourceProjects[manifest.sourceId] ?? null) !== projectId;
    const effectiveHashChanged = previousProjectSchemaHash(previousState, projectId) !== effectiveHashForProject(schemas, projectId);
    if (hashChanged || noAnalysis || projectChanged || effectiveHashChanged) {
      if (options.codeOnly && manifest.sourceKind !== "code") {
        clean.push(manifest);
      } else {
        dirty.push(manifest);
        dirtyReasons.push({
          sourceId: manifest.sourceId,
          reasons: [
            ...(hashChanged ? ["source_hash_changed"] : []),
            ...(noAnalysis ? ["missing_analysis"] : []),
            ...(projectChanged ? ["project_changed"] : []),
            ...(effectiveHashChanged ? ["effective_schema_changed"] : [])
          ]
        });
      }
    } else {
      clean.push(manifest);
    }
  }

  const invalidation: CompileInvalidationReport = {
    dirtySourceCount: dirty.length,
    cleanSourceCount: clean.length,
    rootSchemaChanged,
    effectiveSchemaChanged,
    projectConfigChanged,
    domainProfileChanged,
    sourcesChanged,
    outputsChanged,
    insightsChanged,
    memoryChanged,
    artifactsExist,
    pendingCandidatePromotion,
    dirtyReasons
  };
  lifecycle.record("dirty_check", Date.now(), {
    dirty: dirty.length,
    clean: clean.length,
    rootSchemaChanged,
    effectiveSchemaChanged,
    projectConfigChanged,
    domainProfileChanged,
    sourcesChanged,
    outputsChanged,
    insightsChanged,
    memoryChanged,
    artifactsExist,
    pendingCandidatePromotion
  });

  if (
    dirty.length === 0 &&
    !rootSchemaChanged &&
    !effectiveSchemaChanged &&
    !projectConfigChanged &&
    !domainProfileChanged &&
    !sourcesChanged &&
    !outputsChanged &&
    !insightsChanged &&
    !memoryChanged &&
    !pendingCandidatePromotion &&
    artifactsExist &&
    !options.topicSynthesis &&
    !options.approve
  ) {
    const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
    const benchmarkStarted = Date.now();
    const benchmark = await runConfiguredBenchmark(rootDir, config, options);
    lifecycle.record("benchmark", benchmarkStarted, { ok: benchmark.ok, skipped: benchmark.skipped ?? false }, benchmark.ok);
    if (graph && benchmark.ok && options.refreshIndex !== false) {
      const refreshStarted = Date.now();
      await refreshIndexesAndSearch(rootDir, graph.pages);
      lifecycle.record("refresh_indexes", refreshStarted, { pages: graph.pages.length });
    }
    await recordSession(rootDir, {
      operation: "compile",
      title: `Compiled ${manifests.length} source(s)`,
      startedAt,
      finishedAt: new Date().toISOString(),
      providerId: provider.id,
      success: true,
      relatedSourceIds: manifests.map((manifest) => manifest.sourceId),
      relatedPageIds: graph?.pages.map((page) => page.id) ?? [...outputPages, ...insightPages, ...memoryPages].map((page) => page.id),
      changedPages: [],
      lines: [
        `provider=${provider.id}`,
        `pages=${graph?.pages.length ?? outputPages.length + insightPages.length}`,
        `dirty=0`,
        `clean=${manifests.length}`,
        `outputs=${outputPages.length}`,
        `insights=${insightPages.length}`,
        `memory=${memoryPages.length}`,
        `schema=${schemas.effective.global.hash.slice(0, 12)}`,
        `benchmark=${benchmark.skipped ? "skipped" : benchmark.ok ? "ok" : `error:${benchmark.error}`}`
      ]
    });
    return attachCompileLifecycle(
      {
        graphPath: paths.graphPath,
        pageCount: graph?.pages.length ?? outputPages.length + insightPages.length + memoryPages.length,
        changedPages: [],
        sourceCount: manifests.length,
        staged: false,
        promotedPageIds: [],
        candidatePageCount: (graph?.pages ?? []).filter((page) => page.status === "candidate").length,
        invalidation
      },
      lifecycle.steps,
      benchmark
    );
  }

  const analysisProgress = createCompileProgressReporter("analyze", manifests.length);
  const analysisConcurrency = Math.max(1, config.analysis?.concurrency ?? 8);
  const analyses = await runWithConcurrency(
    manifests.map(
      (manifest) => async () =>
        await analyzeSource(
          manifest,
          await readExtractedText(rootDir, manifest),
          provider,
          paths,
          getEffectiveSchema(schemas, sourceProjects[manifest.sourceId] ?? null),
          {
            bypassCache: forceAnalysis,
            domainProfileHash: nextDomainProfileHash,
            domainProfile,
            maxInputChars: config.analysis?.maxInputChars,
            compactRetryChars: config.analysis?.compactRetryChars,
            longDocumentMode: config.analysis?.longDocumentMode
          }
        ).then((analysis) => {
          analysisProgress.tick(manifest.title);
          return analysis;
        })
    ),
    analysisConcurrency
  );
  analysisProgress.finish(`dirty=${dirty.length}, clean=${clean.length}`);

  const codeIndex = await buildCodeIndex(rootDir, manifests, analyses);
  const enrichedAnalyses = await Promise.all(
    analyses.map(async (analysis) => {
      const manifest = manifests.find((item) => item.sourceId === analysis.sourceId);
      if (!manifest || !analysis.code) {
        return analysis;
      }
      const enriched = enrichResolvedCodeImports(manifest, analysis, codeIndex);
      if (analysisSignature(enriched) !== analysisSignature(analysis)) {
        await writeJsonFile(path.join(paths.analysesDir, `${analysis.sourceId}.json`), enriched);
      }
      return enriched;
    })
  );
  const analysisStats = summarizeAnalysisStats(enrichedAnalyses);
  const fallbackPolicy = options.failOnFallback ? "fail" : (config.analysis?.failurePolicy ?? "warn");
  const maxFallbackRatio = Math.min(1, Math.max(0, config.analysis?.maxFallbackRatio ?? 1));
  const fallbackRatioExceeded = analysisStats.fallbackRatio > maxFallbackRatio;
  const shouldFailOnFallback = (fallbackPolicy === "fail" && analysisStats.fallbackCount > 0) || fallbackRatioExceeded;
  if (shouldFailOnFallback) {
    const ratioPct = (analysisStats.fallbackRatio * 100).toFixed(2);
    const thresholdPct = (maxFallbackRatio * 100).toFixed(2);
    const failedPreview = analysisStats.failedSourceIds.slice(0, 12).join(", ");
    throw new Error(
      `Compile aborted: provider fallbacks=${analysisStats.fallbackCount}/${analysisStats.total} (${ratioPct}%), threshold=${thresholdPct}%.` +
        (failedPreview ? ` sources=${failedPreview}` : "")
    );
  }

  await Promise.all([
    ensureDir(path.join(paths.wikiDir, "sources")),
    ensureDir(path.join(paths.wikiDir, "code")),
    ensureDir(path.join(paths.wikiDir, "concepts")),
    ensureDir(path.join(paths.wikiDir, "entities")),
    ensureDir(path.join(paths.wikiDir, "outputs")),
    ensureDir(path.join(paths.wikiDir, "projects")),
    ensureDir(path.join(paths.wikiDir, "insights")),
    ensureDir(path.join(paths.wikiDir, "candidates")),
    ensureDir(path.join(paths.wikiDir, "candidates", "concepts")),
    ensureDir(path.join(paths.wikiDir, "candidates", "entities"))
  ]);
  const sync = await syncVaultArtifacts(rootDir, {
    schemas,
    manifests,
    analyses: enrichedAnalyses,
    codeIndex,
    sourceProjects,
    outputPages,
    insightPages,
    memoryRecords: storedMemoryPages.map((record) => ({ page: record.page, content: record.content })),
    memoryTasks,
    outputHashes: currentOutputHashes,
    insightHashes: currentInsightHashes,
    memoryHashes: currentMemoryHashes,
    domainProfileHash: nextDomainProfileHash,
    domainProfile,
    previousState,
    approve: options.approve,
    topicSynthesis: options.topicSynthesis
  });
  let postPassApprovalId: string | undefined;
  let postPassApprovalDir: string | undefined;
  if (!options.approve && !sync.staged && config.orchestration?.compilePostPass) {
    const roleResults = await runConfiguredRoles(rootDir, ["context", "safety"], {
      title: "Compile post-pass",
      instructions:
        "Review the compiled vault and optionally propose markdown page updates. Proposals must be complete markdown files with frontmatter.",
      context: [
        `Pages: ${sync.allPages.length}`,
        `Changed pages: ${sync.changedPages.join(", ") || "none"}`,
        "",
        sync.allPages
          .slice(0, 18)
          .map((page) => [`# ${page.title}`, `path=${page.path}`, `kind=${page.kind}`, `status=${page.status}`].join("\n"))
          .join("\n\n---\n\n")
      ].join("\n")
    });
    const proposals = roleResults
      .flatMap((result) => result.proposals)
      .map((proposal) => ({
        ...proposal,
        path: toPosix(proposal.path.replace(/^wiki\//, "").replace(/^\/+/, ""))
      }))
      .filter((proposal) => proposal.path.endsWith(".md"))
      .filter((proposal) => !proposal.path.startsWith("insights/"))
      .filter((proposal) => !proposal.path.startsWith("../"));

    if (proposals.length) {
      const proposedPages = proposals.map((proposal) => parseStoredPage(proposal.path, proposal.content));
      const proposalGraph: GraphArtifact = {
        ...sync.graph,
        generatedAt: new Date().toISOString(),
        pages: sortGraphPages(
          sync.graph.pages
            .filter((page) => !proposedPages.some((proposalPage) => proposalPage.id === page.id || proposalPage.path === page.path))
            .concat(proposedPages)
        )
      };
      const staged = await stageApprovalBundle(
        paths,
        proposals.map((proposal) => ({ relativePath: proposal.path, content: proposal.content })),
        [],
        sync.graph,
        proposalGraph
      );
      postPassApprovalId = staged.approvalId;
      postPassApprovalDir = staged.approvalDir;
    }
  }
  // Decay pass: re-confirm pages produced by this compile run and
  // recompute decayScore/freshness/lastConfirmedAt for all live pages.
  // Staged approvals write into an approval bundle instead of the live
  // wiki, so decay persistence waits for the bundle to be accepted.
  if (!options.approve && !sync.staged) {
    try {
      const decayResult = await runDecayPass({
        wikiDir: paths.wikiDir,
        graphPath: paths.graphPath,
        pages: sync.allPages,
        confirmedPageIds: sync.allPages.map((page) => page.id),
        config: config.freshness
      });
      if (decayResult.updatedPaths.length) {
        sync.changedPages = uniqueStrings([...sync.changedPages, ...decayResult.updatedPaths]);
      }
    } catch {
      // Never fail compile for a decay persistence error.
    }
  }

  // Consolidation pass: roll up working-tier insights into episodic,
  // semantic, and procedural tiers. Runs after decay so we operate on
  // the freshly-updated decay signals. Staged approvals skip this pass
  // for the same reason as decay — the pass writes directly into the
  // live wiki rather than into an approval bundle.
  if (!options.approve && !sync.staged) {
    try {
      const consolidation = await runConsolidation(rootDir, config.consolidation ?? {});
      if (consolidation.newPages.length) {
        sync.changedPages = uniqueStrings([...sync.changedPages, ...consolidation.newPages.map((page) => page.path)]);
      }
    } catch {
      // Never fail compile for a consolidation error.
    }
  }

  const benchmarkStarted = Date.now();
  const benchmark = options.approve ? { ok: true, skipped: true } : await runConfiguredBenchmark(rootDir, config, options);
  lifecycle.record("benchmark", benchmarkStarted, { ok: benchmark.ok, skipped: benchmark.skipped ?? false }, benchmark.ok);
  if (!options.approve && benchmark.ok && options.refreshIndex !== false) {
    const refreshStarted = Date.now();
    await refreshIndexesAndSearch(rootDir, sync.allPages);
    lifecycle.record("refresh_indexes", refreshStarted, { pages: sync.allPages.length });
  }

  await recordSession(rootDir, {
    operation: "compile",
    title: `Compiled ${manifests.length} source(s)`,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: manifests.map((manifest) => manifest.sourceId),
    relatedPageIds: sync.allPages.map((page) => page.id),
    changedPages: sync.changedPages,
    lines: [
      `provider=${provider.id}`,
      `pages=${sync.allPages.length}`,
      `dirty=${dirty.length}`,
      `clean=${clean.length}`,
      `outputs=${outputPages.length}`,
      `insights=${insightPages.length}`,
      `memory=${memoryPages.length}`,
      `candidates=${sync.candidatePageCount}`,
      `promoted=${sync.promotedPageIds.length}`,
      `analysis.total=${analysisStats.total}`,
      `analysis.provider=${analysisStats.provider}`,
      `analysis.heuristic=${analysisStats.heuristic}`,
      `analysis.fallback=${analysisStats.fallbackCount}`,
      `analysis.fallbackRatio=${analysisStats.fallbackRatio.toFixed(4)}`,
      `staged=${sync.staged}`,
      `postPassApproval=${postPassApprovalId ?? "none"}`,
      `schema=${schemas.effective.global.hash.slice(0, 12)}`,
      `benchmark=${benchmark.skipped ? "skipped" : benchmark.ok ? "ok" : `error:${benchmark.error}`}`
    ]
  });

  // Token budgeting: when maxTokens is set, remove low-priority pages that exceed the budget
  let tokenStats: CompileResult["tokenStats"];
  if (options.maxTokens && options.maxTokens > 0) {
    const { estimatePageTokens, trimToTokenBudget } = await import("./token-estimation.js");
    const nodeDegreeLookup = new Map<string, number>();
    const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
    if (graph) {
      for (const node of graph.nodes) {
        if (node.pageId && node.degree) {
          const existing = nodeDegreeLookup.get(node.pageId) ?? 0;
          nodeDegreeLookup.set(node.pageId, Math.max(existing, node.degree));
        }
      }
    }

    const estimates = await Promise.all(
      sync.allPages.map(async (page) => {
        const fullPath = path.join(paths.wikiDir, page.path);
        let content = "";
        try {
          content = await fs.readFile(fullPath, "utf8");
        } catch {
          // Page may have been removed
        }
        return estimatePageTokens(page.id, page.path, page.kind, content, nodeDegreeLookup.get(page.id), page.confidence);
      })
    );

    const budgetResult = trimToTokenBudget(estimates, options.maxTokens);

    // Remove dropped pages from disk
    for (const dropped of budgetResult.dropped) {
      const fullPath = path.join(paths.wikiDir, dropped.path);
      try {
        await fs.unlink(fullPath);
      } catch {
        // Ignore if already removed
      }
    }

    tokenStats = {
      estimatedTokens: budgetResult.totalTokens,
      maxTokens: options.maxTokens,
      pagesKept: budgetResult.kept.length,
      pagesDropped: budgetResult.dropped.length
    };
  }

  let autoPromotionSummary: CompileResult["autoPromotion"];
  const promotionConfig = resolvePromotionConfig(config);
  const promotedFromAuto: string[] = [];
  if (promotionConfig.enabled && !options.approve) {
    const autoRun = await runAutoPromotion(rootDir, { dryRun: promotionConfig.dryRun });
    autoPromotionSummary = {
      evaluated: autoRun.decisions.length,
      promoted: autoRun.promotedPageIds.length,
      dryRun: autoRun.dryRun,
      sessionPath: autoRun.sessionPath
    };
    promotedFromAuto.push(...autoRun.promotedPageIds);
  }

  return attachCompileLifecycle(
    {
      graphPath: paths.graphPath,
      pageCount: sync.allPages.length,
      changedPages: sync.changedPages,
      sourceCount: manifests.length,
      staged: sync.staged,
      approvalId: sync.approvalId,
      approvalDir: sync.approvalDir,
      postPassApprovalId,
      postPassApprovalDir,
      promotedPageIds: [...sync.promotedPageIds, ...promotedFromAuto],
      candidatePageCount: sync.candidatePageCount,
      autoPromotion: autoPromotionSummary,
      tokenStats,
      analysisStats,
      invalidation
    },
    lifecycle.steps,
    benchmark
  );
}

export async function providerSmokeTest(rootDir: string, providerId: string): Promise<ProviderSmokeTestResult> {
  const { config } = await loadVaultConfig(rootDir);
  const providerConfig = config.providers[providerId];
  if (!providerConfig) {
    throw new Error(`Provider not found: ${providerId}`);
  }
  const provider = await createProvider(providerId, providerConfig, rootDir);
  const result: ProviderSmokeTestResult = {
    providerId,
    providerType: provider.type,
    providerModel: provider.model,
    textOk: false,
    structuredOk: false,
    errors: []
  };

  try {
    const textResponse = await provider.generateText({
      prompt: "Return exactly: ok"
    });
    result.textOk = true;
    result.textPreview = truncate(normalizeWhitespace(textResponse.text), 120);
  } catch (error) {
    result.errors.push(`text:${error instanceof Error ? error.message : String(error)}`);
  }

  if (provider.capabilities.has("structured")) {
    try {
      const structured = await provider.generateStructured(
        {
          prompt: "Return JSON object with keys ok (boolean true) and provider (string)."
        },
        z.object({
          ok: z.boolean(),
          provider: z.string().optional()
        })
      );
      result.structuredOk = Boolean(structured.ok);
      result.structuredPreview = structured;
    } catch (error) {
      result.errors.push(`structured:${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    result.structuredOk = false;
    result.errors.push("structured:provider does not advertise structured capability");
  }

  return result;
}

export async function analysisStatusVault(rootDir: string): Promise<AnalysisStatusResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifests = await listManifests(rootDir);
  const entries = await Promise.all(
    manifests.map(async (manifest) => {
      const analysisPath = path.join(paths.analysesDir, `${manifest.sourceId}.json`);
      const analysis = await readJsonFile<SourceAnalysis>(analysisPath).catch(() => null);
      return {
        sourceId: manifest.sourceId,
        title: manifest.title,
        analysisMode: analysis?.analysisMode ?? (analysis ? "heuristic" : "missing"),
        providerId: analysis?.providerId,
        providerModel: analysis?.providerModel,
        warningCount: analysis?.warnings?.length ?? 0,
        providerFailureCount: analysis?.providerFailures?.length ?? 0,
        analysisPath
      } satisfies AnalysisStatusResult["entries"][number];
    })
  );
  const byMode: Record<string, number> = {};
  for (const entry of entries) {
    byMode[entry.analysisMode] = (byMode[entry.analysisMode] ?? 0) + 1;
  }
  const fallbackCount = entries.filter((entry) => entry.analysisMode === "heuristic" && entry.providerFailureCount > 0).length;
  return {
    totalSources: manifests.length,
    analyzedSources: entries.filter((entry) => entry.analysisMode !== "missing").length,
    missingAnalyses: entries.filter((entry) => entry.analysisMode === "missing").length,
    byMode,
    fallbackCount,
    entries
  };
}

export async function retryAnalysisVault(
  rootDir: string,
  options: { mode?: "heuristic" | "missing" | "all"; sourceId?: string; failOnFallback?: boolean } = {}
): Promise<AnalysisRetryResult> {
  const { paths } = await loadVaultConfig(rootDir);
  const status = await analysisStatusVault(rootDir);
  const targetEntries = status.entries.filter((entry) => {
    if (options.sourceId) {
      return entry.sourceId === options.sourceId;
    }
    if (options.mode === "all") {
      return true;
    }
    if (options.mode === "missing") {
      return entry.analysisMode === "missing";
    }
    return entry.analysisMode === "heuristic";
  });
  let deletedAnalysisCount = 0;
  for (const entry of targetEntries) {
    const analysisPath = path.join(paths.analysesDir, `${entry.sourceId}.json`);
    if (await fileExists(analysisPath)) {
      await fs.rm(analysisPath, { force: true });
      deletedAnalysisCount += 1;
    }
  }
  const compile = await compileVault(rootDir, {
    failOnFallback: options.failOnFallback ?? false,
    forceAnalysis: false
  });
  return {
    targetSourceIds: targetEntries.map((entry) => entry.sourceId),
    deletedAnalysisCount,
    compile
  };
}

type SemanticSearchHit = { pageId: string; path: string; title: string; kind: string; status: string; score: number };

function matchesScalarOrList(value: string, filter: string | string[] | undefined): boolean {
  const values = (Array.isArray(filter) ? filter : filter ? [filter] : []).filter((item) => item && item !== "all");
  return !values.length || values.includes(value);
}

async function filterSemanticHitsBySearchOptions(
  wikiDir: string,
  graph: GraphArtifact,
  hits: SemanticSearchHit[],
  options: SearchQueryOptions
): Promise<SemanticSearchHit[]> {
  const pageMap = new Map(graph.pages.map((page) => [page.id, page]));
  const filtered: SemanticSearchHit[] = [];
  for (const hit of hits) {
    const page = pageMap.get(hit.pageId);
    if (!page) {
      continue;
    }
    if (options.kind && options.kind !== "all" && page.kind !== options.kind) {
      continue;
    }
    if (options.status && options.status !== "all" && page.status !== options.status) {
      continue;
    }
    if (options.project && options.project !== "all") {
      if (options.project === "unassigned" ? page.projectIds.length > 0 : !page.projectIds.includes(options.project)) {
        continue;
      }
    }
    let data: Record<string, unknown> = {};
    try {
      data = matter(await fs.readFile(path.join(wikiDir, page.path), "utf8")).data;
    } catch {
      // Graph metadata is still enough for kind/status/project filters.
    }
    const authorityLayer = typeof data.authority_layer === "string" ? data.authority_layer : "";
    const legalStatus = typeof data.legal_status === "string" ? data.legal_status : "";
    const documentRole = typeof data.document_role === "string" ? data.document_role : "";
    const jurisdiction = typeof data.jurisdiction === "string" ? data.jurisdiction : "";
    const region = typeof data.region === "string" ? data.region : "";
    const pollutants = Array.isArray(data.pollutants)
      ? data.pollutants
          .filter((item): item is string => typeof item === "string")
          .join("|")
          .toLowerCase()
      : typeof data.pollutants === "string"
        ? data.pollutants.toLowerCase()
        : "";

    if (!matchesScalarOrList(authorityLayer, options.authorityLayer)) {
      continue;
    }
    if (!matchesScalarOrList(legalStatus, options.legalStatus)) {
      continue;
    }
    if (!matchesScalarOrList(documentRole, options.documentRole)) {
      continue;
    }
    if (!matchesScalarOrList(jurisdiction, options.jurisdiction)) {
      continue;
    }
    if (options.region && options.region !== "all" && !region.includes(options.region)) {
      continue;
    }
    if (options.pollutant && options.pollutant !== "all" && !pollutants.includes(options.pollutant.toLowerCase())) {
      continue;
    }
    if (options.includeDrafts !== true && legalStatus === "draft_consultation") {
      continue;
    }
    if (options.includeSuperseded !== true && legalStatus === "superseded") {
      continue;
    }
    filtered.push(hit);
  }
  return filtered;
}

export async function queryVault(rootDir: string, options: QueryOptions): Promise<QueryResult> {
  const startedAt = new Date().toISOString();
  const save = options.save ?? true;
  const review = options.review ?? false;
  const outputFormat = normalizeOutputFormat(options.format);
  const schemas = await loadVaultSchemas(rootDir);
  const query = await executeQuery(rootDir, options.question, outputFormat, {
    gapFill: options.gapFill,
    gapFillTask: "queryProvider",
    queryOptions: options
  });
  let savedPath: string | undefined;
  let stagedPath: string | undefined;
  let savedPageId: string | undefined;
  let approvalId: string | undefined;
  let approvalDir: string | undefined;
  let outputAssets: OutputAsset[] = [];

  if (save) {
    const assetBundle = await generateOutputArtifacts(rootDir, {
      slug: slugify(options.question),
      title: options.question,
      question: options.question,
      answer: query.answer,
      citations: query.citations,
      format: outputFormat,
      relatedPageCount: query.relatedPageIds.length,
      relatedNodeCount: query.relatedNodeIds.length,
      projectId: query.projectIds[0] ?? null
    });
    outputAssets = assetBundle.outputAssets;
    const outputInput = {
      question: options.question,
      answer: assetBundle.answer,
      citations: query.citations,
      schemaHash: query.schemaHash,
      outputFormat,
      outputAssets: assetBundle.outputAssets,
      relatedPageIds: query.relatedPageIds,
      relatedNodeIds: query.relatedNodeIds,
      relatedSourceIds: query.relatedSourceIds,
      projectIds: query.projectIds,
      extraTags: categoryTagsForSchema(getEffectiveSchema(schemas, query.projectIds[0] ?? null), [options.question, assetBundle.answer]),
      origin: "query"
    } satisfies Omit<Parameters<typeof buildOutputPage>[0], "metadata">;
    if (review) {
      const staged = await prepareOutputPageSave(rootDir, {
        ...outputInput,
        assetFiles: assetBundle.assetFiles
      });
      const approval = await stageOutputApprovalBundle(rootDir, [
        {
          page: staged.page,
          content: staged.content,
          assetFiles: staged.assetFiles
        }
      ]);
      stagedPath = path.join(approval.approvalDir, "wiki", staged.page.path);
      savedPageId = staged.page.id;
      approvalId = approval.approvalId;
      approvalDir = approval.approvalDir;
    } else {
      const saved = await persistOutputPage(rootDir, {
        ...outputInput,
        assetFiles: assetBundle.assetFiles
      });
      await refreshVaultAfterOutputSave(rootDir);
      savedPath = saved.savedPath;
      savedPageId = saved.page.id;
    }
  }

  const provider = await getProviderForTask(rootDir, "queryProvider");
  await recordSession(rootDir, {
    operation: "query",
    title: options.question,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: query.relatedSourceIds,
    relatedPageIds: savedPageId ? [...query.relatedPageIds, savedPageId] : query.relatedPageIds,
    relatedNodeIds: query.relatedNodeIds,
    citations: query.citations,
    tokenUsage: query.usage,
    lines: [
      `citations=${query.citations.join(",") || "none"}`,
      `evidenceState=${query.evidenceState ?? "unknown"}`,
      `recommendedNextTool=${query.recommendedNextTool ?? "knowledge_base"}`,
      `answerBasis=${query.answerBasis ?? "unknown"}`,
      `saved=${Boolean(savedPath)}`,
      `staged=${Boolean(stagedPath)}`,
      `format=${outputFormat}`,
      `rawSources=${query.relatedSourceIds.length}`
    ]
  });
  if (options.memoryTaskId) {
    await updateMemoryTask(rootDir, options.memoryTaskId, {
      note: `Query: ${options.question}`,
      pageId: savedPageId,
      sourceId: query.relatedSourceIds[0],
      nodeId: query.relatedNodeIds[0]
    });
  }

  return {
    answer: query.answer,
    savedPath,
    stagedPath,
    savedPageId,
    citations: query.citations,
    relatedPageIds: query.relatedPageIds,
    relatedNodeIds: query.relatedNodeIds,
    relatedSourceIds: query.relatedSourceIds,
    outputFormat,
    saved: Boolean(savedPath),
    staged: Boolean(stagedPath),
    approvalId,
    approvalDir,
    outputAssets,
    evidenceState: query.evidenceState,
    groundingWarnings: query.groundingWarnings,
    invalidCitations: query.invalidCitations,
    recommendedNextTool: query.recommendedNextTool,
    toolRouting: query.toolRouting,
    answerBasis: query.answerBasis,
    currentStatus: query.currentStatus,
    dataToolHints: query.dataToolHints,
    agentDecision: query.agentDecision,
    evidenceSet: query.evidenceSet,
    primaryEvidenceSet: query.primaryEvidenceSet,
    supportingEvidenceSet: query.supportingEvidenceSet,
    excludedEvidenceSet: query.excludedEvidenceSet,
    standardCoverage: query.standardCoverage,
    evidenceCompleteness: query.evidenceCompleteness,
    temporalIntent: query.temporalIntent,
    retrievalDebug: query.retrievalDebug,
    scopeAudit: query.scopeAudit
  };
}

export async function exploreVault(rootDir: string, options: ExploreOptions): Promise<ExploreResult> {
  const startedAt = new Date().toISOString();
  const stepLimit = Math.max(1, options.steps ?? 3);
  const outputFormat = normalizeOutputFormat(options.format);
  const review = options.review ?? false;
  const schemas = await loadVaultSchemas(rootDir);
  const stepResults: ExploreStepResult[] = [];
  const stepPages: GraphPage[] = [];
  const stagedStepPages: Array<{ page: GraphPage; content: string; assetFiles?: GeneratedOutputArtifacts["assetFiles"] }> = [];
  const visited = new Set<string>();
  const suggestedQuestions: string[] = [];
  const relatedPageIds = new Set<string>();
  const relatedNodeIds = new Set<string>();
  const relatedSourceIds = new Set<string>();
  const tokenUsage = {
    inputTokens: 0,
    outputTokens: 0
  };
  let currentQuestion = options.question;
  let approvalId: string | undefined;
  let approvalDir: string | undefined;

  for (let step = 1; step <= stepLimit; step++) {
    const normalizedQuestion = normalizeWhitespace(currentQuestion).toLowerCase();
    if (!normalizedQuestion || visited.has(normalizedQuestion)) {
      break;
    }

    visited.add(normalizedQuestion);
    const query = await executeQuery(rootDir, currentQuestion, outputFormat, {
      gapFill: options.gapFill,
      gapFillTask: "exploreProvider"
    });
    query.relatedPageIds.forEach((pageId) => {
      relatedPageIds.add(pageId);
    });
    query.relatedNodeIds.forEach((nodeId) => {
      relatedNodeIds.add(nodeId);
    });
    query.relatedSourceIds.forEach((sourceId) => {
      relatedSourceIds.add(sourceId);
    });
    tokenUsage.inputTokens += query.usage?.inputTokens ?? 0;
    tokenUsage.outputTokens += query.usage?.outputTokens ?? 0;
    const roleResults = await runConfiguredRoles(rootDir, ["research", "context", "safety"], {
      title: currentQuestion,
      instructions:
        "Review this exploration step. Research should suggest follow-up questions, context should highlight cross-links, and safety should flag caveats.",
      context: [
        `Question: ${currentQuestion}`,
        "",
        "Answer:",
        query.answer,
        "",
        `Related pages: ${query.relatedPageIds.join(", ") || "none"}`,
        `Related nodes: ${query.relatedNodeIds.join(", ") || "none"}`,
        `Citations: ${query.citations.join(", ") || "none"}`
      ].join("\n")
    });
    const orchestrationNotes = roleResults.flatMap((result) => result.findings.map((finding) => `- [${result.role}] ${finding.message}`));
    const enrichedAnswer = orchestrationNotes.length
      ? `${query.answer}\n\n## Agent Review\n\n${orchestrationNotes.join("\n")}\n`
      : query.answer;
    const assetBundle = await generateOutputArtifacts(rootDir, {
      slug: `explore-${slugify(options.question)}-step-${step}`,
      title: `Explore Step ${step}: ${currentQuestion}`,
      question: currentQuestion,
      answer: enrichedAnswer,
      citations: query.citations,
      format: outputFormat,
      relatedPageCount: query.relatedPageIds.length,
      relatedNodeCount: query.relatedNodeIds.length,
      projectId: query.projectIds[0] ?? null
    });
    const outputInput = {
      title: `Explore Step ${step}: ${currentQuestion}`,
      question: currentQuestion,
      answer: assetBundle.answer,
      citations: query.citations,
      schemaHash: query.schemaHash,
      outputFormat,
      outputAssets: assetBundle.outputAssets,
      relatedPageIds: query.relatedPageIds,
      relatedNodeIds: query.relatedNodeIds,
      relatedSourceIds: query.relatedSourceIds,
      projectIds: query.projectIds,
      extraTags: categoryTagsForSchema(getEffectiveSchema(schemas, query.projectIds[0] ?? null), [currentQuestion, assetBundle.answer]),
      origin: "explore",
      slug: `explore-${slugify(options.question)}-step-${step}`
    } satisfies Omit<Parameters<typeof buildOutputPage>[0], "metadata">;
    let savedPathForStep: string | undefined;
    let stagedPathForStep: string | undefined;
    let savedPage: GraphPage;
    let savedAssets: OutputAsset[];
    if (review) {
      const staged = await prepareOutputPageSave(rootDir, {
        ...outputInput,
        assetFiles: assetBundle.assetFiles
      });
      stagedStepPages.push({
        page: staged.page,
        content: staged.content,
        assetFiles: staged.assetFiles
      });
      savedPage = staged.page;
      savedAssets = staged.outputAssets;
      stagedPathForStep = staged.savedPath;
    } else {
      const saved = await persistOutputPage(rootDir, {
        ...outputInput,
        assetFiles: assetBundle.assetFiles
      });
      savedPage = saved.page;
      savedAssets = saved.outputAssets;
      savedPathForStep = saved.savedPath;
    }

    const followUpQuestions = uniqueBy(
      [...(await generateFollowUpQuestions(rootDir, currentQuestion, enrichedAnswer)), ...summarizeRoleQuestions(roleResults)],
      (item) => item
    );
    stepResults.push({
      step,
      question: currentQuestion,
      answer: enrichedAnswer,
      savedPath: savedPathForStep,
      stagedPath: stagedPathForStep,
      savedPageId: savedPage.id,
      citations: query.citations,
      followUpQuestions,
      outputFormat,
      outputAssets: savedAssets
    });
    stepPages.push(savedPage);
    suggestedQuestions.push(...followUpQuestions);

    const nextQuestion = followUpQuestions.find((item) => !visited.has(normalizeWhitespace(item).toLowerCase()));
    if (!nextQuestion) {
      break;
    }
    currentQuestion = nextQuestion;
  }

  const allCitations = uniqueBy(
    stepResults.flatMap((step) => step.citations),
    (item) => item
  );
  const hubAssetBundle = await generateOutputArtifacts(rootDir, {
    slug: `explore-${slugify(options.question)}`,
    title: `Explore: ${options.question}`,
    question: options.question,
    answer: stepResults.map((step) => step.answer).join("\n\n"),
    citations: allCitations,
    format: outputFormat,
    relatedPageCount: stepPages.length,
    relatedNodeCount: uniqueStrings(stepPages.flatMap((page) => page.nodeIds)).length,
    projectId: stepPages[0]?.projectIds[0] ?? null
  });
  const hubInput = {
    question: options.question,
    stepPages,
    followUpQuestions: uniqueBy(suggestedQuestions, (item) => item),
    citations: allCitations,
    schemaHash: composeVaultSchema(
      schemas.root,
      uniqueStrings(stepPages.flatMap((page) => page.projectIds).sort((left, right) => left.localeCompare(right)))
        .map((projectId) => schemas.projects[projectId])
        .filter((schema): schema is NonNullable<typeof schema> => Boolean(schema?.hash))
    ).hash,
    outputFormat,
    outputAssets: hubAssetBundle.outputAssets,
    projectIds: scopedProjectIdsFromSources(
      allCitations,
      Object.fromEntries(stepPages.flatMap((page) => page.sourceIds.map((sourceId) => [sourceId, page.projectIds[0] ?? null])))
    ),
    extraTags: categoryTagsForSchema(schemas.effective.global, [options.question, ...stepResults.map((step) => step.answer)]),
    slug: `explore-${slugify(options.question)}`
  } satisfies Omit<Parameters<typeof buildExploreHubPage>[0], "metadata">;
  let hubPath: string | undefined;
  let stagedHubPath: string | undefined;
  let hubPage: GraphPage;
  let hubAssets: OutputAsset[];
  let stagedHubRecord: (PersistedOutputPageResult & { content: string; assetFiles: GeneratedOutputArtifacts["assetFiles"] }) | undefined;
  if (review) {
    stagedHubRecord = await prepareExploreHubSave(rootDir, {
      ...hubInput,
      assetFiles: hubAssetBundle.assetFiles
    });
    hubPage = stagedHubRecord.page;
    hubAssets = stagedHubRecord.outputAssets;
    stagedHubPath = stagedHubRecord.savedPath;
  } else {
    const savedHub = await persistExploreHub(rootDir, {
      ...hubInput,
      assetFiles: hubAssetBundle.assetFiles
    });
    hubPage = savedHub.page;
    hubAssets = savedHub.outputAssets;
    hubPath = savedHub.savedPath;
  }
  if (review) {
    const approval = await stageOutputApprovalBundle(rootDir, [
      ...stagedStepPages,
      {
        page: stagedHubRecord?.page ?? hubPage,
        content: stagedHubRecord?.content ?? "",
        assetFiles: stagedHubRecord?.assetFiles
      }
    ]);
    approvalId = approval.approvalId;
    approvalDir = approval.approvalDir;
    stepResults.forEach((result, index) => {
      result.stagedPath = path.join(approval.approvalDir as string, "wiki", stagedStepPages[index]?.page.path ?? "");
    });
    stagedHubPath = path.join(approval.approvalDir, "wiki", hubPage.path);
  } else {
    await refreshVaultAfterOutputSave(rootDir);
  }

  const provider = await getProviderForTask(rootDir, "queryProvider");
  await recordSession(rootDir, {
    operation: "explore",
    title: options.question,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider.id,
    success: true,
    relatedSourceIds: [...relatedSourceIds],
    relatedPageIds: uniqueStrings([...relatedPageIds, ...stepPages.map((page) => page.id), hubPage.id]),
    relatedNodeIds: [...relatedNodeIds],
    citations: allCitations,
    tokenUsage:
      tokenUsage.inputTokens > 0 || tokenUsage.outputTokens > 0
        ? {
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens
          }
        : undefined,
    lines: [
      `steps=${stepResults.length}`,
      `hub=${hubPage.id}`,
      `format=${outputFormat}`,
      `citations=${allCitations.join(",") || "none"}`,
      `staged=${review}`
    ]
  });
  if (options.memoryTaskId) {
    await updateMemoryTask(rootDir, options.memoryTaskId, {
      note: `Explore: ${options.question}`,
      pageId: hubPage.id,
      sourceId: [...relatedSourceIds][0],
      nodeId: [...relatedNodeIds][0]
    });
  }

  return {
    rootQuestion: options.question,
    hubPath,
    stagedHubPath,
    hubPageId: hubPage.id,
    stepCount: stepResults.length,
    steps: stepResults,
    suggestedQuestions: uniqueBy(suggestedQuestions, (item) => item),
    outputFormat,
    staged: review,
    approvalId,
    approvalDir,
    hubAssets
  };
}

export async function searchVault(
  rootDir: string,
  query: string,
  limitOrOptions: number | (SearchQueryOptions & { intent?: QueryOptions["intent"] }) = 5
): Promise<SearchResult[]> {
  const { paths, config } = await loadVaultConfig(rootDir);
  if (!(await fileExists(paths.searchDbPath))) {
    await compileVault(rootDir, {});
  }
  const options = typeof limitOrOptions === "number" ? ({ limit: limitOrOptions } as SearchQueryOptions) : limitOrOptions;
  const limit = options.limit ?? 5;
  const domainProfile = await loadDomainProfile(rootDir, config);

  const retrieval = resolveRetrievalConfig(config);
  const hybrid = retrieval.hybrid;
  const ftsResults = searchPages(paths.searchDbPath, query, {
    ...options,
    domainProfile,
    limit: hybrid ? limit * 3 : limit
  });

  if (!hybrid || !(await fileExists(paths.graphPath))) {
    return ftsResults.slice(0, limit);
  }

  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    return ftsResults.slice(0, limit);
  }

  const semanticHits = await semanticPageSearch(rootDir, graph, query, limit * 3).catch(() => []);
  const filteredSemanticHits = await filterSemanticHitsBySearchOptions(paths.wikiDir, graph, semanticHits, options);
  if (!filteredSemanticHits.length) {
    return ftsResults.slice(0, limit);
  }

  const merged = mergeSearchResults(ftsResults, filteredSemanticHits, limit);

  if (retrieval.rerank && merged.length > 1) {
    return rerankSearchResults(rootDir, query, merged, limit);
  }

  return merged;
}

async function rerankSearchResults(rootDir: string, query: string, results: SearchResult[], limit: number): Promise<SearchResult[]> {
  const provider = await getProviderForTask(rootDir, "queryProvider");
  const candidates = results
    .slice(0, Math.min(results.length, 20))
    .map((r, i) => `[${i}] ${r.title} — ${r.snippet || r.path}`)
    .join("\n");
  const prompt = `Given the search query: "${query}"\n\nRank these results by relevance (most relevant first).\n\n${candidates}`;
  try {
    const indices = await provider.generateStructured(
      { prompt, system: "You are a search result ranker." },
      z.array(z.number().int().nonnegative())
    );
    const reranked: SearchResult[] = [];
    const seen = new Set<number>();
    for (const idx of indices) {
      if (idx >= 0 && idx < results.length && !seen.has(idx)) {
        seen.add(idx);
        reranked.push(results[idx]);
      }
    }
    for (let i = 0; i < results.length && reranked.length < limit; i++) {
      if (!seen.has(i)) {
        reranked.push(results[i]);
      }
    }
    const llmPosition = new Map(reranked.map((result, index) => [result.pageId, index] as const));
    return results
      .map((result, originalIndex) => {
        const rerankIndex = llmPosition.get(result.pageId) ?? originalIndex;
        const retrievalWeight = originalIndex < 3 ? 0.75 : originalIndex < 10 ? 0.6 : 0.4;
        const llmWeight = 1 - retrievalWeight;
        const exactBoost = result.retrievalStage === "standard_exact" ? 0.25 : result.retrievalStage === "structured_fact" ? 0.2 : 0;
        const blendedScore = retrievalWeight * (1 / (originalIndex + 1)) + llmWeight * (1 / (rerankIndex + 1)) + exactBoost;
        return {
          ...result,
          rank: -blendedScore,
          retrievalStage:
            result.retrievalStage === "standard_exact" || result.retrievalStage === "structured_fact"
              ? result.retrievalStage
              : ("rerank" as const),
          rankingSignals: uniqueBy([...(result.rankingSignals ?? []), "position_aware_llm_rerank"], (item) => item)
        };
      })
      .sort((left, right) => left.rank - right.rank)
      .slice(0, limit);
  } catch {
    return results.slice(0, limit);
  }
}

async function ensureCompiledGraph(rootDir: string): Promise<GraphArtifact> {
  const { paths } = await loadVaultConfig(rootDir);
  if (!(await fileExists(paths.searchDbPath)) || !(await fileExists(paths.graphPath))) {
    await compileVault(rootDir, {});
  }
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    throw new Error("Graph artifact not found. Run `swarmvault compile` first.");
  }
  return graph;
}

async function runResolvedGraphQuery(
  rootDir: string,
  graph: GraphArtifact,
  question: string,
  options: {
    traversal?: "bfs" | "dfs";
    budget?: number;
  } = {}
): Promise<GraphQueryResult> {
  const searchResults = await searchVault(rootDir, question, Math.max(5, options.budget ?? 10));
  const semanticMatches = await semanticGraphMatches(rootDir, graph, question, Math.max(8, options.budget ?? 12)).catch(() => []);
  return queryGraph(graph, question, searchResults, {
    ...options,
    semanticMatches
  });
}

export async function queryGraphVault(
  rootDir: string,
  question: string,
  options: {
    traversal?: "bfs" | "dfs";
    budget?: number;
  } = {}
): Promise<GraphQueryResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return runResolvedGraphQuery(rootDir, graph, question, options);
}

export async function benchmarkVault(rootDir: string, options: BenchmarkOptions = {}): Promise<BenchmarkArtifact> {
  const { config, paths } = await loadVaultConfig(rootDir);
  const graph = await ensureCompiledGraph(rootDir);
  const manifests = await listManifests(rootDir);
  const pageContentsById = new Map<string, string>();
  let corpusWords = 0;
  const perClassCorpusWords: Record<SourceClass, number> = {
    first_party: 0,
    third_party: 0,
    resource: 0,
    generated: 0
  };

  for (const manifest of manifests) {
    const extractedText = await readExtractedText(rootDir, manifest);
    if (extractedText) {
      const words = estimateCorpusWords([extractedText]);
      corpusWords += words;
      const manifestClass = manifest.sourceClass ?? "first_party";
      perClassCorpusWords[manifestClass] = (perClassCorpusWords[manifestClass] ?? 0) + words;
    }
  }

  for (const page of graph.pages) {
    const absolutePath = path.join(paths.wikiDir, page.path);
    if (!(await fileExists(absolutePath))) {
      continue;
    }
    const parsed = matter(await fs.readFile(absolutePath, "utf8"));
    pageContentsById.set(page.id, parsed.content);
  }

  const configuredQuestions = (config.benchmark?.questions ?? []).map((question) => normalizeWhitespace(question)).filter(Boolean);
  const maxQuestions = Math.max(1, options.maxQuestions ?? config.benchmark?.maxQuestions ?? 3);
  const questions = (options.questions ?? []).map((question) => normalizeWhitespace(question)).filter(Boolean);
  const sampleQuestions = (
    questions.length ? questions : configuredQuestions.length ? configuredQuestions : defaultBenchmarkQuestionsForGraph(graph, maxQuestions)
  ).slice(0, maxQuestions);
  const perQuestion = await Promise.all(
    sampleQuestions.map(async (question) => {
      const result = await runResolvedGraphQuery(rootDir, graph, question, { budget: 12 });
      const metrics = benchmarkQueryTokens(graph, result, pageContentsById);
      return {
        question,
        queryTokens: metrics.queryTokens,
        reduction: metrics.reduction,
        visitedNodeIds: result.visitedNodeIds,
        visitedEdgeIds: result.visitedEdgeIds,
        pageIds: result.pageIds
      };
    })
  );

  // Per-class traversal: restrict seeds and traversal to a class-filtered
  // graph view so the graph-guided token numbers for each class are honest
  // rather than a naive re-slice of the corpus-wide result.
  const perClassPerQuestion: Record<SourceClass, BenchmarkQuestionResult[]> = {
    first_party: [],
    third_party: [],
    resource: [],
    generated: []
  };
  for (const sourceClass of ALL_SOURCE_CLASSES) {
    const filteredGraph = filterGraphBySourceClass(graph, sourceClass);
    if (!filteredGraph.nodes.length) {
      continue;
    }
    const classPageContents = new Map<string, string>();
    for (const page of filteredGraph.pages) {
      const content = pageContentsById.get(page.id);
      if (content !== undefined) {
        classPageContents.set(page.id, content);
      }
    }
    const classResults = await Promise.all(
      sampleQuestions.map(async (question) => {
        const result = await runResolvedGraphQuery(rootDir, filteredGraph, question, { budget: 12 });
        const metrics = benchmarkQueryTokens(filteredGraph, result, classPageContents);
        return {
          question,
          queryTokens: metrics.queryTokens,
          reduction: metrics.reduction,
          visitedNodeIds: result.visitedNodeIds,
          visitedEdgeIds: result.visitedEdgeIds,
          pageIds: result.pageIds
        } satisfies BenchmarkQuestionResult;
      })
    );
    perClassPerQuestion[sourceClass] = classResults;
  }

  const byClass = buildBenchmarkByClass({
    graph,
    perClassCorpusWords,
    perClassPerQuestion
  });

  const artifact = buildBenchmarkArtifact({
    graph,
    corpusWords,
    questions: sampleQuestions,
    perQuestion,
    byClass
  });

  await writeJsonFile(paths.benchmarkPath, artifact);
  await refreshIndexesAndSearch(rootDir, graph.pages);
  const refreshedGraph = (await readJsonFile<GraphArtifact>(paths.graphPath)) ?? graph;
  const refreshedHash = graphHash(refreshedGraph);
  if (artifact.graphHash === refreshedHash) {
    return artifact;
  }
  const refreshedArtifact = {
    ...artifact,
    graphHash: refreshedHash
  } satisfies BenchmarkArtifact;
  await writeJsonFile(paths.benchmarkPath, refreshedArtifact);
  return refreshedArtifact;
}

export async function pathGraphVault(rootDir: string, from: string, to: string): Promise<GraphPathResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return shortestGraphPath(graph, from, to);
}

export async function explainGraphVault(rootDir: string, target: string): Promise<GraphExplainResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return explainGraphTarget(graph, target);
}

export async function listGraphHyperedges(rootDir: string, target?: string, limit = 25): Promise<GraphHyperedge[]> {
  const graph = await ensureCompiledGraph(rootDir);
  return listHyperedges(graph, target, limit);
}

export async function readGraphReport(rootDir: string): Promise<GraphReportArtifact | null> {
  const { paths } = await loadVaultConfig(rootDir);
  return readJsonFile<GraphReportArtifact>(path.join(paths.wikiDir, "graph", "report.json"));
}

export async function listGodNodes(rootDir: string, limit?: number): Promise<GraphNode[]> {
  const graph = await ensureCompiledGraph(rootDir);
  const { config } = await loadVaultConfig(rootDir);
  const defaults = resolveLargeRepoDefaults({
    nodeCount: graph.nodes.length,
    config
  });
  const effectiveLimit = limit ?? defaults.godNodeLimit;
  return topGodNodes(graph, effectiveLimit);
}

export async function blastRadiusVault(rootDir: string, target: string, options?: { maxDepth?: number }): Promise<BlastRadiusResult> {
  const graph = await ensureCompiledGraph(rootDir);
  return blastRadius(graph, target, options);
}

export async function listPages(rootDir: string): Promise<GraphPage[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  return graph?.pages ?? [];
}

export async function readPage(
  rootDir: string,
  relativePath: string
): Promise<{
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  content: string;
} | null> {
  if (!relativePath) {
    return null;
  }
  const { paths } = await loadVaultConfig(rootDir);
  const absolutePath = path.resolve(paths.wikiDir, relativePath);
  if (!isPathWithin(paths.wikiDir, absolutePath)) {
    return null;
  }
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (!stats?.isFile()) {
    return null;
  }

  const raw = await fs.readFile(absolutePath, "utf8");
  const parsed = matter(raw);
  return {
    path: relativePath,
    title: typeof parsed.data.title === "string" ? parsed.data.title : path.basename(relativePath, path.extname(relativePath)),
    frontmatter: parsed.data,
    content: parsed.content
  };
}

export async function getWorkspaceInfo(rootDir: string): Promise<{
  rootDir: string;
  configPath: string;
  schemaPath: string;
  rawDir: string;
  wikiDir: string;
  stateDir: string;
  agentDir: string;
  inboxDir: string;
  sourceCount: number;
  pageCount: number;
}> {
  const { paths } = await loadVaultConfig(rootDir);
  const manifests = await listManifests(rootDir);
  const pages = await listPages(rootDir);

  return {
    rootDir,
    configPath: paths.configPath,
    schemaPath: paths.schemaPath,
    rawDir: paths.rawDir,
    wikiDir: paths.wikiDir,
    stateDir: paths.stateDir,
    agentDir: paths.agentDir,
    inboxDir: paths.inboxDir,
    sourceCount: manifests.length,
    pageCount: pages.length
  };
}

function extractClaimSectionLines(content: string): string[] | null {
  const lines = content.split("\n");
  let inClaims = false;
  let found = false;
  const claimLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "## Claims") {
      inClaims = true;
      found = true;
      continue;
    }
    if (inClaims) {
      if (/^#{1,2}\s/.test(trimmed)) {
        inClaims = false;
        continue;
      }
      claimLines.push(line);
    }
  }
  return found ? claimLines : null;
}

function isClaimPlaceholderBullet(line: string): boolean {
  // Compiler fallbacks emit marker bullets like "- No claims extracted." when
  // a source has nothing to extract. These are intentional "no claims" markers
  // rather than genuine uncited claims and should not trigger the linter.
  const trimmed = line.trim();
  return /^-\s+No\s+claims\s+extracted\.?$/i.test(trimmed);
}

function tierLintFindings(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  graph: GraphArtifact,
  consolidationConfig: VaultConfig["consolidation"],
  now: Date = new Date()
): LintFinding[] {
  const findings: LintFinding[] = [];
  const resolved = {
    sessionWindowHours: consolidationConfig?.workingToEpisodic?.sessionWindowHours ?? 24
  };
  const pageIndex = new Map(graph.pages.map((page) => [page.id, page] as const));
  const staleCutoffMs = now.getTime() - resolved.sessionWindowHours * 60 * 60 * 1000 * 2;
  for (const page of graph.pages) {
    if (page.kind !== "insight") {
      continue;
    }
    const tier = page.tier ?? "working";
    if (tier === "working" && !page.supersededBy) {
      const updatedMs = Date.parse(page.updatedAt);
      if (!Number.isNaN(updatedMs) && updatedMs < staleCutoffMs) {
        findings.push({
          severity: "info",
          code: "stale_working_tier",
          message: `Working-tier insight ${page.title} has not been consolidated after the session window.`,
          pagePath: path.join(paths.wikiDir, page.path),
          relatedPageIds: [page.id]
        });
      }
    }
    if ((tier === "episodic" || tier === "semantic" || tier === "procedural") && page.consolidatedFromPageIds?.length) {
      const missing = page.consolidatedFromPageIds.filter((id) => !pageIndex.has(id));
      if (missing.length > 0) {
        findings.push({
          severity: "warning",
          code: "broken_consolidation_basis",
          message: `Tier page ${page.title} references missing lower-tier page ids: ${missing.join(", ")}.`,
          pagePath: path.join(paths.wikiDir, page.path),
          relatedPageIds: [page.id]
        });
      }
    }
    if (tier === "semantic" && (!page.consolidatedFromPageIds || page.consolidatedFromPageIds.length === 0)) {
      findings.push({
        severity: "warning",
        code: "semantic_without_episodic_basis",
        message: `Semantic-tier page ${page.title} has no episodic basis recorded.`,
        pagePath: path.join(paths.wikiDir, page.path),
        relatedPageIds: [page.id]
      });
    }
  }
  return findings;
}

function decayLintFindings(
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  graph: GraphArtifact,
  freshnessConfig: VaultConfig["freshness"],
  now: Date = new Date()
): LintFinding[] {
  const findings: LintFinding[] = [];
  const decayConfig = resolveDecayConfig(freshnessConfig);
  const staleThreshold = decayConfig.staleThreshold ?? 0.3;
  const pageIndex = new Map(graph.pages.map((page) => [page.id, page] as const));
  for (const page of graph.pages) {
    const score = typeof page.decayScore === "number" ? page.decayScore : 1;
    const belowThreshold = score < staleThreshold;
    const supersededBy = page.supersededBy;

    if (belowThreshold && !supersededBy) {
      findings.push({
        severity: "info",
        code: "decayed-pages",
        message: `Page ${page.title} has decayed (score=${score.toFixed(2)}, below threshold ${staleThreshold}).`,
        pagePath: path.join(paths.wikiDir, page.path),
        relatedPageIds: [page.id]
      });
    }

    if (supersededBy && !pageIndex.has(supersededBy)) {
      findings.push({
        severity: "warning",
        code: "broken_supersession",
        message: `Page ${page.title} is marked supersededBy ${supersededBy}, but that page does not exist.`,
        pagePath: path.join(paths.wikiDir, page.path),
        relatedPageIds: [page.id]
      });
    }

    if (page.freshness === "stale" && !supersededBy && score >= staleThreshold) {
      findings.push({
        severity: "info",
        code: "inconsistent_decay",
        message: `Page ${page.title} is marked stale but decay score ${score.toFixed(2)} is above the threshold.`,
        pagePath: path.join(paths.wikiDir, page.path),
        relatedPageIds: [page.id]
      });
    }
  }
  // `now` participates in the signature so callers can pass a fixed clock in tests.
  void now;
  return findings;
}

function structuralLintFindings(
  _rootDir: string,
  paths: Awaited<ReturnType<typeof loadVaultConfig>>["paths"],
  graph: GraphArtifact,
  schemas: LoadedVaultSchemas,
  manifests: SourceManifest[],
  sourceProjects: Record<string, string | null>
): Promise<LintFinding[]> {
  const manifestMap = new Map(manifests.map((manifest) => [manifest.sourceId, manifest]));
  const pageMap = new Map(graph.pages.map((page) => [page.id, page]));
  return Promise.all(
    graph.pages.map(async (page) => {
      const findings: LintFinding[] = [];

      if (page.kind === "insight") {
        return findings;
      }

      if (page.schemaHash !== expectedSchemaHashForPage(page, schemas, pageMap, sourceProjects)) {
        findings.push({
          severity: "warning",
          code: "stale_page",
          message: `Page ${page.title} is stale because the vault schema changed.`,
          pagePath: path.join(paths.wikiDir, page.path),
          relatedPageIds: [page.id]
        });
      }

      const freshnessHashes = Object.keys(page.sourceSemanticHashes).length ? page.sourceSemanticHashes : page.sourceHashes;
      for (const [sourceId, knownHash] of Object.entries(freshnessHashes)) {
        const manifest = manifestMap.get(sourceId);
        const manifestHash = manifest?.semanticHash ?? manifest?.contentHash;
        if (manifestHash && manifestHash !== knownHash) {
          findings.push({
            severity: "warning",
            code: "stale_page",
            message: `Page ${page.title} is stale because source ${sourceId} changed.`,
            pagePath: path.join(paths.wikiDir, page.path),
            relatedSourceIds: [sourceId],
            relatedPageIds: [page.id]
          });
        }
      }

      if (page.kind !== "index" && page.backlinks.length === 0) {
        findings.push({
          severity: "info",
          code: "orphan_page",
          message: `Page ${page.title} has no backlinks.`,
          pagePath: path.join(paths.wikiDir, page.path),
          relatedPageIds: [page.id]
        });
      }

      const absolutePath = path.join(paths.wikiDir, page.path);
      if (await fileExists(absolutePath)) {
        const content = await fs.readFile(absolutePath, "utf8");
        const parsed = matter(content);
        const replacedBy =
          Array.isArray(parsed.data.replaced_by) || (typeof parsed.data.replaced_by === "string" && parsed.data.replaced_by.trim());
        if (replacedBy && parsed.data.legal_status === "current_effective") {
          findings.push({
            severity: "error",
            code: "superseded_marked_current",
            message: `Page ${page.title} declares replacement metadata but is still marked current_effective.`,
            pagePath: absolutePath,
            relatedPageIds: [page.id]
          });
        }
        if (parsed.data.legal_status === "draft_consultation" && parsed.data.authority_layer === "core") {
          findings.push({
            severity: "warning",
            code: "draft_in_core_layer",
            message: `Page ${page.title} is a draft consultation document but is classified as core authority.`,
            pagePath: absolutePath,
            relatedPageIds: [page.id]
          });
        }
        if (
          (page.kind === "concept" || page.kind === "entity") &&
          /(扫描件|目录|附件|正文|未知|文件|raw|curated|pdf)$/i.test(page.title.trim())
        ) {
          findings.push({
            severity: "warning",
            code: "noisy_promoted_page",
            message: `Page ${page.title} looks like a file artifact rather than a stable professional concept/entity.`,
            pagePath: absolutePath,
            relatedPageIds: [page.id]
          });
        }
        if (page.kind === "output") {
          const citations = Array.isArray(parsed.data.citations)
            ? parsed.data.citations.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
            : [];
          if (!citations.length) {
            findings.push({
              severity: "warning",
              code: "ungrounded_output",
              message: `Output page ${page.title} has no recorded citations.`,
              pagePath: absolutePath,
              relatedPageIds: [page.id]
            });
          }
        }
        const claimLines = extractClaimSectionLines(content);
        if (claimLines !== null) {
          const uncited = claimLines.filter(
            (line) => line.startsWith("- ") && !line.includes("[source:") && !isClaimPlaceholderBullet(line)
          );
          if (uncited.length) {
            findings.push({
              severity: "warning",
              code: "uncited_claims",
              message: `Page ${page.title} contains uncited claim bullets.`,
              pagePath: absolutePath,
              relatedPageIds: [page.id]
            });
          }
        }
      }

      return findings;
    })
  ).then((results) => results.flat());
}

export async function lintVault(rootDir: string, options: LintOptions = {}): Promise<LintFinding[]> {
  const startedAt = new Date().toISOString();
  if (options.web && !options.deep) {
    throw new Error("`--web` can only be used together with `--deep`.");
  }

  const { config, paths } = await loadVaultConfig(rootDir);
  const schemas = await loadVaultSchemas(rootDir);
  const manifests = await listManifests(rootDir);
  const sourceProjects = resolveSourceProjects(rootDir, manifests, config);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);

  if (!graph) {
    const findings: LintFinding[] = [
      {
        severity: "warning",
        code: "graph_missing",
        message: "No graph artifact found. Run `swarmvault compile` first."
      }
    ];
    await recordSession(rootDir, {
      operation: "lint",
      title: "Linted 0 page(s)",
      startedAt,
      finishedAt: new Date().toISOString(),
      success: true,
      lintFindingCount: findings.length,
      lines: [
        `findings=${findings.length}`,
        `deep=${Boolean(options.deep)}`,
        `web=${Boolean(options.web)}`,
        `conflicts=${Boolean(options.conflicts)}`
      ]
    });
    return findings;
  }

  // Build deterministic contradiction findings from graph edges
  const contradictionFindings: LintFinding[] = options.conflicts
    ? graph.edges
        .filter((edge) => edge.relation === "contradicts")
        .map((edge) => {
          const sourceIdA = edge.provenance[0] ?? edge.source.replace(/^source:/, "");
          const sourceIdB = edge.provenance[1] ?? edge.target.replace(/^source:/, "");
          return {
            severity: "warning" as const,
            code: "contradiction",
            message: `Contradicting claims detected between source "${sourceIdA}" and source "${sourceIdB}".`,
            relatedSourceIds: [sourceIdA, sourceIdB]
          };
        })
    : [];

  // If conflicts-only mode (no deep or structural lint requested), return only contradiction findings
  if (options.conflicts && !options.deep && !options.decay) {
    await recordSession(rootDir, {
      operation: "lint",
      title: `Linted ${graph.pages.length} page(s)`,
      startedAt,
      finishedAt: new Date().toISOString(),
      success: true,
      relatedPageIds: graph.pages.map((page) => page.id),
      relatedSourceIds: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
      lintFindingCount: contradictionFindings.length,
      lines: [`findings=${contradictionFindings.length}`, `deep=false`, `web=false`, `conflicts=true`]
    });
    return contradictionFindings;
  }

  // Decay-only mode: surface only decay-related lint rules.
  if (options.decay && !options.deep && !options.conflicts && !options.tiers) {
    const decayFindings = decayLintFindings(paths, graph, config.freshness);
    await recordSession(rootDir, {
      operation: "lint",
      title: `Linted ${graph.pages.length} page(s)`,
      startedAt,
      finishedAt: new Date().toISOString(),
      success: true,
      relatedPageIds: graph.pages.map((page) => page.id),
      relatedSourceIds: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
      lintFindingCount: decayFindings.length,
      lines: [`findings=${decayFindings.length}`, `deep=false`, `web=false`, `conflicts=false`, `decay=true`]
    });
    return decayFindings;
  }

  // Tier-only mode: surface only consolidation-tier lint rules.
  if (options.tiers && !options.deep && !options.conflicts && !options.decay) {
    const tierFindings = tierLintFindings(paths, graph, config.consolidation);
    await recordSession(rootDir, {
      operation: "lint",
      title: `Linted ${graph.pages.length} page(s)`,
      startedAt,
      finishedAt: new Date().toISOString(),
      success: true,
      relatedPageIds: graph.pages.map((page) => page.id),
      relatedSourceIds: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
      lintFindingCount: tierFindings.length,
      lines: [`findings=${tierFindings.length}`, `deep=false`, `web=false`, `conflicts=false`, `tiers=true`]
    });
    return tierFindings;
  }

  const findings = await structuralLintFindings(rootDir, paths, graph, schemas, manifests, sourceProjects);
  findings.push(...decayLintFindings(paths, graph, config.freshness));
  findings.push(...tierLintFindings(paths, graph, config.consolidation));

  // Include deterministic contradiction findings when conflicts flag is set
  if (options.conflicts) {
    findings.push(...contradictionFindings);
  }

  if (options.deep) {
    findings.push(...(await runDeepLint(rootDir, findings, { web: options.web })));
  }

  const provider = options.deep ? await getProviderForTask(rootDir, "lintProvider") : undefined;
  await recordSession(rootDir, {
    operation: "lint",
    title: `Linted ${graph.pages.length} page(s)`,
    startedAt,
    finishedAt: new Date().toISOString(),
    providerId: provider?.id,
    success: true,
    relatedPageIds: graph.pages.map((page) => page.id),
    relatedSourceIds: uniqueStrings(graph.pages.flatMap((page) => page.sourceIds)),
    lintFindingCount: findings.length,
    lines: [
      `findings=${findings.length}`,
      `deep=${Boolean(options.deep)}`,
      `web=${Boolean(options.web)}`,
      `conflicts=${Boolean(options.conflicts)}`,
      `decay=${Boolean(options.decay)}`
    ]
  });

  return findings;
}

export async function bootstrapDemo(rootDir: string, input?: string): Promise<{ manifestId?: string; compile?: CompileResult }> {
  await initVault(rootDir);
  if (!input) {
    return {};
  }

  const manifest = await ingestInput(rootDir, input);
  const compile = await compileVault(rootDir, {});
  return {
    manifestId: manifest.sourceId,
    compile
  };
}

/**
 * Vault-level wrapper around the consolidation engine so the CLI, MCP,
 * and schedule callers all go through a single entry point. The provider
 * is optional; the rollup is purely heuristic otherwise.
 */
export async function consolidateVault(rootDir: string, options: { dryRun?: boolean } = {}): Promise<ConsolidationResult> {
  const { config } = await loadVaultConfig(rootDir);
  return runConsolidation(rootDir, config.consolidation ?? {}, undefined, { dryRun: options.dryRun ?? false });
}

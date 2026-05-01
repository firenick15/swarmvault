import fs from "node:fs/promises";
import path from "node:path";
import nlp from "compromise";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { analyzeCodeSource } from "./code-analysis.js";
import { extractStandardReferences } from "./domain/env-air.js";
import { DEFAULT_ENV_AIR_PROFILE } from "./domain/env-air-profile.js";
import { normalizeDomainMetadataLegalStatus } from "./domain/env-air-status.js";
import type { LoadedDomainProfile } from "./domain/profile-loader.js";
import { readExtractionArtifact } from "./ingest.js";
import {
  extractRationaleFromMarkdown,
  extractRationaleFromPlainText,
  type MarkdownNode,
  markdownNodeText,
  parseMarkdownNodes
} from "./markdown-ast.js";
import type { VaultSchema } from "./schema.js";
import { contentTokens } from "./tokenize.js";
import type {
  DomainMetadata,
  Polarity,
  ProviderAdapter,
  ResolvedPaths,
  SourceAnalysis,
  SourceExtractionArtifact,
  SourceKind,
  SourceManifest,
  SourceRationale
} from "./types.js";
import {
  fileExists,
  firstSentences,
  normalizeWhitespace,
  readJsonFile,
  sha256,
  slugifyKnowledgeLabel,
  truncate,
  uniqueBy,
  writeJsonFile
} from "./utils.js";

const ANALYSIS_FORMAT_VERSION = 10;

const domainMetadataSchema = z
  .object({
    authorityLayer: z.enum(["core", "method", "evidence", "evolution", "local", "international", "project", "unknown"]).default("unknown"),
    legalForce: z
      .enum(["mandatory", "recommended", "explanatory", "statistical", "research", "draft", "superseded", "unknown"])
      .default("unknown"),
    documentRole: z
      .enum([
        "law",
        "regulation",
        "policy",
        "standard",
        "monitoring_method",
        "qa_qc",
        "emission_standard",
        "technical_guide",
        "statistics",
        "official_explanation",
        "whitepaper",
        "research_literature",
        "draft",
        "compilation_explanation",
        "amendment",
        "local_reference",
        "international_reference",
        "unknown"
      ])
      .default("unknown"),
    legalStatus: z
      .enum([
        "current_effective",
        "issued_not_yet_effective",
        "draft_consultation",
        "superseded",
        "amended",
        "explanation_only",
        "time_scoped_evidence",
        "unknown"
      ])
      .default("unknown"),
    jurisdiction: z.enum(["national", "province", "city", "international", "unknown"]).default("unknown"),
    region: z.string().min(1).optional(),
    standardCode: z.string().min(1).optional(),
    publishDate: z.string().min(1).optional(),
    effectiveDate: z.string().min(1).optional(),
    reportingPeriod: z.string().min(1).optional(),
    evidencePeriod: z.string().min(1).optional(),
    replaces: z.array(z.string().min(1)).default([]),
    replacedBy: z.array(z.string().min(1)).default([]),
    pollutants: z.array(z.string().min(1)).default([]),
    useFor: z.array(z.string().min(1)).default([]),
    doNotUseFor: z.array(z.string().min(1)).default([]),
    confidence: z.number().min(0).max(1).optional(),
    notes: z.array(z.string().min(1)).default([]),
    metadataSource: z.enum(["sidecar", "rule", "llm", "mixed"]).default("llm"),
    verificationState: z.enum(["unreviewed", "rule_verified", "human_verified"]).default("unreviewed"),
    llmUncertainFields: z.array(z.string().min(1)).default([]),
    visibility: z.enum(["public", "tenant", "project"]).optional(),
    tenantId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    sourceScope: z.enum(["public_authority", "tenant_private", "project_private", "generated_report"]).optional()
  })
  .default({
    authorityLayer: "unknown",
    legalForce: "unknown",
    documentRole: "unknown",
    legalStatus: "unknown",
    jurisdiction: "unknown",
    replaces: [],
    replacedBy: [],
    pollutants: [],
    useFor: [],
    doNotUseFor: [],
    notes: [],
    metadataSource: "llm",
    verificationState: "unreviewed",
    llmUncertainFields: []
  });

const sourceAnalysisSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  concepts: z
    .array(z.object({ name: z.string().min(1), description: z.string().default("") }))
    .max(12)
    .default([]),
  entities: z
    .array(z.object({ name: z.string().min(1), description: z.string().default("") }))
    .max(12)
    .default([]),
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        confidence: z.number().min(0).max(1).default(0.6),
        status: z.enum(["extracted", "inferred", "conflicted", "stale"]).default("extracted"),
        polarity: z.enum(["positive", "negative", "neutral"]).default("neutral"),
        citation: z.string().min(1)
      })
    )
    .max(8)
    .default([]),
  questions: z.array(z.string()).max(6).default([]),
  tags: z.array(z.string()).max(5).default([]),
  domain: domainMetadataSchema.optional()
});

const HEURISTIC_SECTION_SOURCE_KINDS = new Map<SourceManifest["sourceKind"], string>([
  ["transcript", "Transcript"],
  ["chat_export", "Messages"],
  ["email", "Message"],
  ["calendar", "Description"]
]);

/**
 * Source kinds whose extracted text is markdown-shaped, so the markdown AST
 * walker can surface blockquote / list-item rationale markers. PDF, DOCX,
 * HTML, EPUB, ODT, RTF, org-mode, AsciiDoc, and Jupyter sources are all
 * extracted to markdown by the ingest pipeline and therefore share the
 * same walker.
 */
const MARKDOWN_RATIONALE_KINDS = new Set<SourceKind>([
  "markdown",
  "html",
  "pdf",
  "docx",
  "epub",
  "odt",
  "rtf",
  "org",
  "asciidoc",
  "jupyter"
]);

/**
 * Source kinds whose extracted text is plain paragraphs (or
 * paragraph-shaped) so the blank-line paragraph split is the right
 * structural parser. The prefix check still only runs on an already
 * paragraph-isolated block, never on the whole file.
 */
const PLAIN_TEXT_RATIONALE_KINDS = new Set<SourceKind>(["text", "transcript", "chat_export", "email", "calendar"]);

const ENV_TERM_ALLOWLIST = new Set(["pm2.5", "pm10", "o3", "so2", "no2", "co", "aqi", "iaqi", "vocs", "nmhc"]);

function normalizeEnvAirText(content: string): string {
  const normalized = content
    .replace(/\bP\s*M\s*2\s*\.?\s*5\b/gi, "PM2.5")
    .replace(/\bP\s*M\s*1\s*0\b/gi, "PM10")
    .replace(/\bO\s*3\b/gi, "O3")
    .replace(/\bN\s*O\s*2\b/gi, "NO2")
    .replace(/\bS\s*O\s*2\b/gi, "SO2")
    .replace(/\bG\s*B\s*([0-9]{3,5})\b/gi, "GB $1")
    .replace(/\bH\s*J\s*([0-9]{3,5})\b/gi, "HJ $1");
  return normalizeWhitespace(normalized);
}

function isLikelyNoiseTerm(term: string): boolean {
  const normalized = term.trim();
  if (!normalized) {
    return true;
  }
  const lower = normalized.toLowerCase();
  if (ENV_TERM_ALLOWLIST.has(lower)) {
    return false;
  }
  if (/^[0-9]+([.:/-][0-9]+)*$/.test(normalized)) {
    return true;
  }
  if (/^[=+*/(){}[\]\\<>-]+$/.test(normalized)) {
    return true;
  }
  if (/^[a-z]{1,2}$/i.test(normalized) && !ENV_TERM_ALLOWLIST.has(lower)) {
    return true;
  }
  if (normalized.length <= 2 && !ENV_TERM_ALLOWLIST.has(lower)) {
    return true;
  }
  if (/(?:^|[^a-z])(kpa|nmol|mmol|mg|ug|μg|g\/m3|mg\/m3)(?:$|[^a-z])/i.test(normalized) && !ENV_TERM_ALLOWLIST.has(lower)) {
    return true;
  }
  return false;
}

function filterDomainTermCandidates(terms: string[], limit: number): string[] {
  return uniqueBy(
    terms
      .map((term) => normalizeWhitespace(term))
      .filter((term) => term.length > 0)
      .filter((term) => !isLikelyNoiseTerm(term)),
    (value) => value.toLowerCase()
  ).slice(0, limit);
}

function inferDomainMetadata(manifest: SourceManifest, content: string): DomainMetadata {
  const title = `${manifest.title} ${manifest.originalPath ?? ""} ${manifest.repoRelativePath ?? ""}`;
  const text = `${title}\n${content}`.toLowerCase();
  const standardCode = extractStandardReferences(`${title}\n${content}`)[0]?.normalized;
  const pollutants = filterDomainTermCandidates(
    ["PM2.5", "PM10", "O3", "SO2", "NO2", "CO", "AQI", "IAQI", "VOCs", "NMHC"].filter(
      (name) => text.includes(name.toLowerCase()) || text.includes(name.replace(".", "").toLowerCase())
    ),
    10
  );

  let authorityLayer: DomainMetadata["authorityLayer"] = "unknown";
  let legalForce: DomainMetadata["legalForce"] = "unknown";
  let documentRole: DomainMetadata["documentRole"] = "unknown";
  let legalStatus: DomainMetadata["legalStatus"] = "unknown";
  const reportingPeriod = inferReportingPeriod(`${title}\n${content}`);

  if (/征求意见|草案/.test(text)) {
    authorityLayer = "evolution";
    legalForce = "draft";
    documentRole = "draft";
    legalStatus = "draft_consultation";
  } else if (/编制说明|解读|释义/.test(text)) {
    authorityLayer = "evidence";
    legalForce = "explanatory";
    documentRole = "official_explanation";
    legalStatus = "explanation_only";
  } else if (/年报|月报|公报|白皮书|蓝皮书/.test(text)) {
    authorityLayer = "evidence";
    legalForce = "statistical";
    documentRole = /白皮书|蓝皮书/.test(text) ? "whitepaper" : "statistics";
    legalStatus = "time_scoped_evidence";
  } else if (/标准|规范|技术要求|监测方法|hj\s*(?:\/\s*t)?\s*[- ]?[0-9]{2,6}|gb\s*(?:\/\s*t)?\s*[- ]?[0-9]{2,6}|db[0-9]{2}/i.test(text)) {
    authorityLayer = /地方|省|市/.test(text) ? "local" : "core";
    legalForce = /gb\/t|hj\/t|指南|导则|技术指南|推荐/i.test(text) ? "recommended" : "mandatory";
    documentRole = /技术指南|导则|指南/.test(text)
      ? "technical_guide"
      : /监测方法|技术规范|技术要求/.test(text)
        ? "monitoring_method"
        : /排放标准/.test(text)
          ? "emission_standard"
          : "standard";
    legalStatus = "current_effective";
  } else if (/研究|论文|综述/.test(text)) {
    authorityLayer = "evidence";
    legalForce = "research";
    documentRole = "research_literature";
  }

  const jurisdiction: DomainMetadata["jurisdiction"] = /地方|省|市/.test(text) ? (/市/.test(text) ? "city" : "province") : "national";

  return {
    authorityLayer,
    legalForce,
    documentRole,
    legalStatus,
    jurisdiction,
    standardCode,
    reportingPeriod,
    evidencePeriod: reportingPeriod,
    pollutants,
    useFor: [],
    doNotUseFor: [],
    replaces: [],
    replacedBy: [],
    notes: [],
    metadataSource: "rule",
    verificationState: "rule_verified",
    llmUncertainFields: []
  };
}

function inferReportingPeriod(text: string): string | undefined {
  const normalized = text.replace(/\s+/g, "");
  const month = normalized.match(/(20[0-9]{2})年([0-9]{1,2})月/);
  if (month) {
    return `${month[1]}-${String(month[2]).padStart(2, "0")}`;
  }
  const year = normalized.match(/(20[0-9]{2})年(?:度)?(?:生态环境状况)?(?:公报|年报|报告|白皮书|蓝皮书)/);
  return year?.[1];
}

async function readSidecarDomainMetadata(rootDir: string, manifest: SourceManifest): Promise<DomainMetadata | undefined> {
  const sourcePath = manifest.originalPath ?? manifest.repoRelativePath ?? manifest.storedPath;
  if (!sourcePath) {
    return undefined;
  }
  const absoluteSourcePath = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(rootDir, sourcePath);
  const parsed = path.parse(absoluteSourcePath);
  const candidates = [
    path.join(parsed.dir, `${parsed.name}.swarmvault.meta.json`),
    path.join(parsed.dir, `${parsed.name}.swarmvault.meta.yaml`),
    path.join(parsed.dir, `${parsed.name}.swarmvault.meta.yml`),
    path.join(parsed.dir, ".swarmvault.defaults.json"),
    path.join(parsed.dir, ".swarmvault.defaults.yaml"),
    path.join(parsed.dir, ".swarmvault.defaults.yml")
  ];
  const merged: Record<string, unknown> = {};
  for (const candidate of candidates.reverse()) {
    if (!(await fileExists(candidate))) {
      continue;
    }
    const content = await fs.readFile(candidate, "utf8");
    const raw = (candidate.endsWith(".json") ? JSON.parse(content) : parseYaml(content)) as Record<string, unknown>;
    Object.assign(merged, normalizeSidecarKeys(raw));
  }
  if (!Object.keys(merged).length) {
    return undefined;
  }
  const parsedDomain = domainMetadataSchema.parse({
    ...merged,
    metadataSource: "sidecar",
    verificationState: merged.verificationState ?? "human_verified"
  });
  return parsedDomain as DomainMetadata;
}

function normalizeSidecarKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const keyMap: Record<string, string> = {
    authority_layer: "authorityLayer",
    legal_force: "legalForce",
    document_role: "documentRole",
    legal_status: "legalStatus",
    standard_code: "standardCode",
    publish_date: "publishDate",
    effective_date: "effectiveDate",
    reporting_period: "reportingPeriod",
    evidence_period: "evidencePeriod",
    replaced_by: "replacedBy",
    metadata_source: "metadataSource",
    verification_state: "verificationState",
    llm_uncertain_fields: "llmUncertainFields",
    tenant_id: "tenantId",
    project_id: "projectId",
    source_scope: "sourceScope"
  };
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [keyMap[key] ?? key, value]));
}

function filenameStemForSource(manifest: SourceManifest): string {
  const candidate = manifest.repoRelativePath ?? manifest.originalPath ?? manifest.storedPath;
  const base = path.basename(candidate);
  const stem = base.replace(/\.[^.]+$/, "");
  return stem || manifest.title;
}

function extractNonCodeRationales(manifest: SourceManifest, rawText: string): SourceRationale[] {
  if (!rawText.trim()) {
    return [];
  }
  if (MARKDOWN_RATIONALE_KINDS.has(manifest.sourceKind)) {
    const fallback = filenameStemForSource(manifest);
    const rationales = extractRationaleFromMarkdown(rawText, manifest.sourceId);
    return rationales.map((entry) => ({
      ...entry,
      symbolName: entry.symbolName ?? fallback
    }));
  }
  if (PLAIN_TEXT_RATIONALE_KINDS.has(manifest.sourceKind)) {
    return extractRationaleFromPlainText(rawText, manifest.sourceId, filenameStemForSource(manifest));
  }
  return [];
}

function extractTopTerms(text: string, count: number): string[] {
  // contentTokens already drops closed-class words via compromise POS tagging,
  // so there is no hand-maintained STOPWORDS filter here.
  const frequency = new Map<string, number>();
  for (const token of contentTokens(text)) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  return [...frequency.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, count)
    .map(([token]) => token);
}

function extractEntities(text: string, count: number): string[] {
  // Prefer compromise's POS tagger so common determiners/pronouns ("The",
  // "This", "Each") are never treated as named entities. We pull a union of
  // proper nouns, people, places, organizations, and topics then preserve
  // original insertion order so higher-signal terms appear first.
  const candidates: string[] = [];
  try {
    const doc = nlp(text);
    const segments = [
      doc.match("#ProperNoun+").out("array") as string[],
      doc.people().out("array") as string[],
      doc.places().out("array") as string[],
      doc.organizations().out("array") as string[],
      doc.topics().out("array") as string[]
    ];
    for (const segment of segments) {
      for (const term of segment) {
        const normalized = normalizeWhitespace(term);
        if (normalized) {
          candidates.push(normalized);
        }
      }
    }
  } catch {
    // compromise failed to parse — return nothing. The heuristic fallback is
    // intentionally empty: a bare regex match of capitalized tokens produced
    // too much noise (sentence starters, mid-sentence proper-noun phrases
    // spanning unrelated subjects). Users who need high-quality entities
    // configure an LLM provider; the heuristic notice points them there.
  }

  return uniqueBy(candidates, (value) => value.toLowerCase()).slice(0, count);
}

function detectPolarity(text: string): Polarity {
  if (/\b(no|not|never|cannot|can't|won't|without)\b/i.test(text)) {
    return "negative";
  }
  if (/\b(is|are|will|does|supports|enables|improves|includes)\b/i.test(text)) {
    return "positive";
  }
  return "neutral";
}

function markdownNodesText(nodes: MarkdownNode[]): string {
  return normalizeWhitespace(nodes.map((node) => markdownNodeText(node)).join("\n"));
}

function stripLeadingTitleNodes(nodes: MarkdownNode[], title: string): MarkdownNode[] {
  const normalizedTitle = normalizeWhitespace(title);
  if (!normalizedTitle || !nodes.length) {
    return nodes;
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    const nodeText = markdownNodeText(node);
    if (node.type === "heading" && node.depth === 1 && nodeText === normalizedTitle) {
      return nodes.slice(index + 1);
    }
    if (node.type === "paragraph" && nodeText === normalizedTitle) {
      return nodes.slice(index + 1);
    }
    return nodes;
  }
  return nodes;
}

function markdownSectionNodes(nodes: MarkdownNode[], heading: string): MarkdownNode[] {
  const normalizedHeading = normalizeWhitespace(heading);
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node?.type !== "heading" || node.depth !== 2) {
      continue;
    }
    if (markdownNodeText(node) !== normalizedHeading) {
      continue;
    }
    const sectionNodes: MarkdownNode[] = [];
    for (let cursor = index + 1; cursor < nodes.length; cursor += 1) {
      const candidate = nodes[cursor];
      if (candidate?.type === "heading" && typeof candidate.depth === "number" && candidate.depth <= 2) {
        break;
      }
      if (candidate) {
        sectionNodes.push(candidate);
      }
    }
    return sectionNodes;
  }
  return [];
}

function textForHeuristicAnalysis(manifest: SourceManifest, text: string): string {
  const nodes = parseMarkdownNodes(text);
  if (!nodes.length) {
    return normalizeWhitespace(text);
  }
  const sectionHeading = HEURISTIC_SECTION_SOURCE_KINDS.get(manifest.sourceKind);
  const scopedNodes = sectionHeading ? markdownSectionNodes(nodes, sectionHeading) : nodes;
  const relevantNodes = scopedNodes.length ? scopedNodes : nodes;
  const contentNodes = stripLeadingTitleNodes(relevantNodes, manifest.title);
  const normalized = markdownNodesText(contentNodes.length ? contentNodes : relevantNodes);
  return normalized || normalizeWhitespace(text);
}

function normalizeAnalysisTitle(manifest: SourceManifest, candidate: string): string {
  if (manifest.sourceKind !== "code") {
    return manifest.title;
  }
  const normalized = normalizeWhitespace(candidate.replace(/^#+\s+/, ""));
  if (!normalized) {
    return manifest.title;
  }
  if (normalized.length > 140 || normalized.includes(" ## ")) {
    return manifest.title;
  }
  return normalized;
}

function normalizeSourceAnalysis(manifest: SourceManifest, analysis: SourceAnalysis): SourceAnalysis {
  const title = normalizeAnalysisTitle(manifest, analysis.title);
  const domain = analysis.domain
    ? normalizeDomainMetadataLegalStatus(analysis.domain, {
        title,
        path: manifest.originalPath ?? manifest.repoRelativePath ?? manifest.storedPath
      })
    : undefined;
  if (title === analysis.title && JSON.stringify(domain ?? null) === JSON.stringify(analysis.domain ?? null)) {
    return analysis;
  }
  return { ...analysis, title, ...(domain ? { domain } : {}) };
}

function heuristicAnalysis(manifest: SourceManifest, text: string, schemaHash: string): SourceAnalysis {
  const analysisText = normalizeEnvAirText(textForHeuristicAnalysis(manifest, text));
  const normalized = normalizeWhitespace(analysisText);
  const concepts = filterDomainTermCandidates(extractTopTerms(normalized, 10), 6).map((term) => ({
    id: `concept:${slugifyKnowledgeLabel(term)}`,
    name: term,
    description: `Frequently referenced concept in ${manifest.title}.`
  }));
  const entities = filterDomainTermCandidates(extractEntities(analysisText, 10), 6).map((term) => ({
    id: `entity:${slugifyKnowledgeLabel(term)}`,
    name: term,
    description: `Named entity mentioned in ${manifest.title}.`
  }));
  const claimSentences = normalized
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 4);

  return {
    analysisVersion: ANALYSIS_FORMAT_VERSION,
    sourceId: manifest.sourceId,
    sourceHash: manifest.contentHash,
    semanticHash: manifest.semanticHash,
    extractionHash: manifest.extractionHash,
    schemaHash,
    title: manifest.title,
    summary: firstSentences(normalized, 3) || truncate(normalized, 280) || `Imported ${manifest.sourceKind} source.`,
    concepts,
    entities,
    claims: claimSentences.map((sentence, index) => ({
      id: `claim:${manifest.sourceId}:${index + 1}`,
      text: sentence,
      confidence: 0.55,
      status: "extracted",
      polarity: detectPolarity(sentence),
      citation: manifest.sourceId
    })),
    questions: [
      `这份资料对${manifest.title}的适用边界是什么？`,
      `这份资料是否可作为现行执行依据？`,
      `它与相关标准或历史版本的关系是什么？`
    ].slice(0, 3),
    tags: [],
    domain: inferDomainMetadata(manifest, normalized),
    analysisMode: "heuristic",
    providerId: "heuristic",
    providerModel: "heuristic-v1",
    warnings: [],
    rationales: [],
    producedAt: new Date().toISOString()
  };
}

async function providerAnalysis(
  manifest: SourceManifest,
  text: string,
  provider: ProviderAdapter,
  schema: VaultSchema,
  domainProfile: LoadedDomainProfile = DEFAULT_ENV_AIR_PROFILE,
  options: { maxInputChars?: number } = {}
): Promise<SourceAnalysis> {
  const cleanedText = normalizeEnvAirText(text);
  const repairWarnings: string[] = [];
  const parsed = await provider.generateStructured(
    {
      system: [
        ...domainProfile.sourceAnalysisSystemPrompt,
        "",
        "Follow the vault schema when choosing titles, categories, relationships, and summaries.",
        "",
        "Return up to 5 broad domain tags that categorize this source. Tags should be lowercase kebab-case (e.g., cryptography, distributed-systems, machine-learning). These are broader categories, not specific concepts or entity names.",
        "",
        `Vault schema path: ${schema.path}`,
        "",
        "Vault schema instructions:",
        truncate(schema.content, 6000)
      ].join("\n"),
      prompt: `Analyze the following source and return structured JSON.\n\nSource title: ${manifest.title}\nSource kind: ${manifest.sourceKind}\nSource id: ${manifest.sourceId}\n\nText:\n${truncate(cleanedText, options.maxInputChars ?? 18000)}`
    },
    sourceAnalysisSchema,
    { schemaName: "source_analysis", repairWarnings }
  );
  const normalizedConcepts = filterDomainTermCandidates(
    parsed.concepts.map((term) => term.name),
    12
  );
  const normalizedEntities = filterDomainTermCandidates(
    parsed.entities.map((term) => term.name),
    12
  );
  const parsedDomain = parsed.domain
    ? ({
        ...parsed.domain,
        replaces: parsed.domain.replaces ?? [],
        replacedBy: parsed.domain.replacedBy ?? [],
        pollutants: parsed.domain.pollutants ?? [],
        useFor: parsed.domain.useFor ?? [],
        doNotUseFor: parsed.domain.doNotUseFor ?? [],
        notes: parsed.domain.notes ?? [],
        llmUncertainFields: parsed.domain.llmUncertainFields ?? []
      } as DomainMetadata)
    : undefined;
  const inferred = inferDomainMetadata(manifest, cleanedText);
  const domain: DomainMetadata = parsedDomain
    ? {
        ...inferred,
        ...parsedDomain,
        metadataSource: parsedDomain.metadataSource ?? "mixed",
        verificationState: parsedDomain.verificationState ?? "unreviewed"
      }
    : inferred;

  return {
    analysisVersion: ANALYSIS_FORMAT_VERSION,
    sourceId: manifest.sourceId,
    sourceHash: manifest.contentHash,
    semanticHash: manifest.semanticHash,
    extractionHash: manifest.extractionHash,
    schemaHash: schema.hash,
    title: parsed.title,
    summary: parsed.summary,
    concepts: normalizedConcepts.map((name) => ({
      id: `concept:${slugifyKnowledgeLabel(name)}`,
      name,
      description: parsed.concepts.find((item) => item.name === name)?.description ?? ""
    })),
    entities: normalizedEntities.map((name) => ({
      id: `entity:${slugifyKnowledgeLabel(name)}`,
      name,
      description: parsed.entities.find((item) => item.name === name)?.description ?? ""
    })),
    claims: parsed.claims.map((claim, index) => ({
      id: `claim:${manifest.sourceId}:${index + 1}`,
      text: claim.text,
      confidence: claim.confidence,
      status: claim.status,
      polarity: claim.polarity,
      citation: claim.citation
    })),
    questions: parsed.questions,
    tags: parsed.tags,
    domain,
    analysisMode: "provider",
    providerId: provider.id,
    providerModel: provider.model,
    warnings: repairWarnings.map((warning) => `structured_repair:${warning}`),
    rationales: [],
    producedAt: new Date().toISOString()
  };
}

async function providerAnalysisWithRetry(
  manifest: SourceManifest,
  text: string,
  provider: ProviderAdapter,
  schema: VaultSchema,
  domainProfile: LoadedDomainProfile = DEFAULT_ENV_AIR_PROFILE
): Promise<SourceAnalysis> {
  const failures: NonNullable<SourceAnalysis["providerFailures"]> = [];
  try {
    return await providerAnalysis(manifest, text, provider, schema, domainProfile, { maxInputChars: 18000 });
  } catch (error) {
    failures.push({
      phase: "initial",
      error: truncate(error instanceof Error ? error.message : String(error), 1200),
      producedAt: new Date().toISOString()
    });
  }
  try {
    const retry = await providerAnalysis(manifest, text, provider, schema, domainProfile, { maxInputChars: 9000 });
    return {
      ...retry,
      providerFailures: failures,
      warnings: uniqueBy([...(retry.warnings ?? []), "provider_retry_succeeded:compact_retry"], (item) => item)
    };
  } catch (error) {
    failures.push({
      phase: "compact_retry",
      error: truncate(error instanceof Error ? error.message : String(error), 1200),
      producedAt: new Date().toISOString()
    });
    const finalError = new Error(error instanceof Error ? error.message : String(error)) as Error & {
      providerFailures?: NonNullable<SourceAnalysis["providerFailures"]>;
    };
    finalError.providerFailures = failures;
    throw finalError;
  }
}

function analysisFromVisionExtraction(
  manifest: SourceManifest,
  extraction: SourceExtractionArtifact,
  schemaHash: string
): SourceAnalysis | null {
  if (!extraction.vision) {
    return null;
  }

  return {
    analysisVersion: ANALYSIS_FORMAT_VERSION,
    sourceId: manifest.sourceId,
    sourceHash: manifest.contentHash,
    semanticHash: manifest.semanticHash,
    extractionHash: manifest.extractionHash,
    schemaHash,
    title: extraction.vision.title?.trim() || manifest.title,
    summary: extraction.vision.summary,
    concepts: extraction.vision.concepts.map((term) => ({
      id: `concept:${slugifyKnowledgeLabel(term.name)}`,
      name: term.name,
      description: term.description
    })),
    entities: extraction.vision.entities.map((term) => ({
      id: `entity:${slugifyKnowledgeLabel(term.name)}`,
      name: term.name,
      description: term.description
    })),
    claims: extraction.vision.claims.map((claim, index) => ({
      id: `claim:${manifest.sourceId}:${index + 1}`,
      text: claim.text,
      confidence: claim.confidence,
      status: "extracted",
      polarity: claim.polarity,
      citation: manifest.sourceId
    })),
    questions: extraction.vision.questions,
    tags: [],
    domain: inferDomainMetadata(manifest, extraction.vision.text),
    analysisMode: "vision",
    providerId: extraction.providerId,
    providerModel: extraction.providerModel,
    warnings: extraction.warnings ?? [],
    rationales: [],
    producedAt: new Date().toISOString()
  };
}

function extractionWarningSummary(manifest: SourceManifest, extraction?: SourceExtractionArtifact): string {
  const warning = extraction?.warnings?.find(Boolean);
  if (warning) {
    return `Imported ${manifest.sourceKind} source. ${warning}`;
  }
  return `Imported ${manifest.sourceKind} source. Text extraction is not yet available for this source.`;
}

export async function analyzeSource(
  manifest: SourceManifest,
  extractedText: string | undefined,
  provider: ProviderAdapter,
  paths: ResolvedPaths,
  schema: VaultSchema,
  options: { bypassCache?: boolean; domainProfileHash?: string; domainProfile?: LoadedDomainProfile } = {}
): Promise<SourceAnalysis> {
  const cachePath = path.join(paths.analysesDir, `${manifest.sourceId}.json`);
  const cached = options.bypassCache ? null : await readJsonFile<SourceAnalysis>(cachePath);
  if (
    cached &&
    cached.analysisVersion === ANALYSIS_FORMAT_VERSION &&
    (cached.semanticHash ?? cached.sourceHash) === manifest.semanticHash &&
    cached.extractionHash === manifest.extractionHash &&
    cached.schemaHash === schema.hash &&
    (options.domainProfileHash ? cached.domainProfileHash === options.domainProfileHash : true)
  ) {
    const normalizedCached = normalizeSourceAnalysis(manifest, cached);
    if (normalizedCached !== cached) {
      await writeJsonFile(cachePath, normalizedCached);
    }
    return normalizedCached;
  }

  const extraction = await readExtractionArtifact(paths.rootDir, manifest);
  const content = normalizeEnvAirText(normalizeWhitespace(extractedText ?? ""));
  let analysis: SourceAnalysis;
  let providerFailure: string | undefined;
  let providerFailures: SourceAnalysis["providerFailures"] = [];

  if (manifest.sourceKind === "code" && content) {
    analysis = {
      ...(await analyzeCodeSource(manifest, extractedText ?? "", schema.hash)),
      domain: inferDomainMetadata(manifest, content),
      analysisMode: "code",
      providerId: provider.id,
      providerModel: provider.model,
      warnings: []
    };
  } else if (manifest.sourceKind === "image") {
    const visionAnalysis = extraction ? analysisFromVisionExtraction(manifest, extraction, schema.hash) : null;
    if (visionAnalysis) {
      analysis = visionAnalysis;
    } else if (!content) {
      analysis = {
        analysisVersion: ANALYSIS_FORMAT_VERSION,
        sourceId: manifest.sourceId,
        sourceHash: manifest.contentHash,
        semanticHash: manifest.semanticHash,
        extractionHash: manifest.extractionHash,
        schemaHash: schema.hash,
        title: manifest.title,
        summary: extractionWarningSummary(manifest, extraction),
        concepts: [],
        entities: [],
        claims: [],
        questions: [],
        tags: [],
        domain: inferDomainMetadata(manifest, manifest.title),
        analysisMode: "empty",
        providerId: provider.id,
        providerModel: provider.model,
        warnings: extraction?.warnings ?? [],
        rationales: [],
        producedAt: new Date().toISOString()
      };
    } else if (provider.type === "heuristic") {
      analysis = heuristicAnalysis(manifest, content, schema.hash);
    } else {
      try {
        analysis = await providerAnalysisWithRetry(manifest, content, provider, schema, options.domainProfile);
      } catch (error) {
        providerFailure = error instanceof Error ? error.message : String(error);
        providerFailures = (error as { providerFailures?: SourceAnalysis["providerFailures"] }).providerFailures ?? [];
        analysis = heuristicAnalysis(manifest, content, schema.hash);
      }
    }
  } else if (!content) {
    analysis = {
      analysisVersion: ANALYSIS_FORMAT_VERSION,
      sourceId: manifest.sourceId,
      sourceHash: manifest.contentHash,
      semanticHash: manifest.semanticHash,
      extractionHash: manifest.extractionHash,
      schemaHash: schema.hash,
      title: manifest.title,
      summary: extractionWarningSummary(manifest, extraction),
      concepts: [],
      entities: [],
      claims: [],
      questions: [],
      tags: [],
      domain: inferDomainMetadata(manifest, manifest.title),
      analysisMode: "empty",
      providerId: provider.id,
      providerModel: provider.model,
      warnings: extraction?.warnings ?? [],
      rationales: [],
      producedAt: new Date().toISOString()
    };
  } else if (provider.type === "heuristic") {
    analysis = heuristicAnalysis(manifest, content, schema.hash);
  } else {
    try {
      analysis = await providerAnalysisWithRetry(manifest, content, provider, schema, options.domainProfile);
    } catch (error) {
      providerFailure = error instanceof Error ? error.message : String(error);
      providerFailures = (error as { providerFailures?: SourceAnalysis["providerFailures"] }).providerFailures ?? [];
      analysis = heuristicAnalysis(manifest, content, schema.hash);
    }
  }

  // Attach non-code rationales (markdown blockquotes / list items, plain
  // text paragraphs) once the per-kind analysis has been chosen. Code
  // rationales are already emitted by `analyzeCodeSource`; this only
  // covers the prose-shaped source kinds that previously had an empty
  // `rationales` array.
  if (manifest.sourceKind !== "code" && !analysis.rationales.length) {
    const extra = extractNonCodeRationales(manifest, extractedText ?? "");
    if (extra.length) {
      analysis = { ...analysis, rationales: extra };
    }
  }

  if (!analysis.domain) {
    analysis = { ...analysis, domain: inferDomainMetadata(manifest, content || manifest.title) };
  }
  const sidecarDomain = await readSidecarDomainMetadata(paths.rootDir, manifest).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...inferDomainMetadata(manifest, content || manifest.title),
      metadataSource: "sidecar",
      verificationState: "unreviewed",
      notes: [`Invalid sidecar metadata: ${truncate(message, 180)}`]
    } satisfies DomainMetadata;
  });
  if (sidecarDomain) {
    analysis = {
      ...analysis,
      domain: {
        ...(analysis.domain ?? inferDomainMetadata(manifest, content || manifest.title)),
        ...sidecarDomain,
        metadataSource: "sidecar"
      }
    };
  }
  if (providerFailure) {
    analysis = {
      ...analysis,
      analysisMode: "heuristic",
      providerId: provider.id,
      providerModel: provider.model,
      providerFailures: uniqueBy(
        [
          ...(providerFailures ?? []),
          {
            phase: "fallback" as const,
            error: truncate(providerFailure, 1200),
            producedAt: new Date().toISOString()
          }
        ],
        (failure) => `${failure.phase}:${failure.error}`
      ),
      warnings: uniqueBy([...(analysis.warnings ?? []), `Provider analysis failed: ${truncate(providerFailure, 240)}`], (value) => value)
    };
  }

  const normalized = normalizeSourceAnalysis(manifest, analysis);
  normalized.domainProfileHash = options.domainProfileHash;
  await writeJsonFile(cachePath, normalized);
  return normalized;
}

export function analysisSignature(analysis: SourceAnalysis): string {
  return sha256(JSON.stringify(analysis));
}

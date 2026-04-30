import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { loadVaultConfig } from "./config.js";
import { extractStandardReferences, standardIdentityKey } from "./domain/env-air.js";
import { normalizeFindingSeverity } from "./findings.js";
import { listManifests } from "./ingest.js";
import { runConfiguredRoles, summarizeRoleQuestions } from "./orchestration.js";
import { getProviderForTask } from "./providers/registry.js";
import { loadVaultSchema } from "./schema.js";
import type { GraphArtifact, LintFinding } from "./types.js";
import { normalizeWhitespace, readJsonFile, truncate, uniqueBy } from "./utils.js";
import { getWebSearchAdapterForTask } from "./web-search/registry.js";

const deepLintResponseSchema = z.object({
  findings: z
    .array(
      z.object({
        severity: z.string().optional().default("info"),
        code: z.enum([
          "coverage_gap",
          "contradiction_candidate",
          "contradiction",
          "missing_citation",
          "candidate_page",
          "follow_up_question"
        ]),
        message: z.string().min(1),
        relatedSourceIds: z.array(z.string()).default([]),
        relatedPageIds: z.array(z.string()).default([]),
        suggestedQuery: z.string().optional()
      })
    )
    .max(20)
});

type DeepLintContextPage = {
  id: string;
  title: string;
  path: string;
  kind: "source" | "module" | "concept" | "entity";
  sourceIds: string[];
  excerpt: string;
};

type StandardInventory = {
  byIdentity: Map<string, Array<{ pageId: string; title: string; path: string; legalStatus?: string; authorityLayer?: string }>>;
};

function isUnknown(value: unknown): boolean {
  return typeof value !== "string" || !value.trim() || value.trim() === "unknown";
}

function sourceTitleLooksLikeAmendment(title: string, sourcePath?: string, standardCode?: unknown): boolean {
  return /(修改单|amendment)/i.test(
    [title, sourcePath ?? "", typeof standardCode === "string" ? standardCode : ""].filter(Boolean).join("\n")
  );
}

async function buildStandardInventory(rootDir: string, graph: GraphArtifact): Promise<StandardInventory> {
  const { paths } = await loadVaultConfig(rootDir);
  const byIdentity = new Map<
    string,
    Array<{ pageId: string; title: string; path: string; legalStatus?: string; authorityLayer?: string }>
  >();
  for (const page of graph.pages.filter((item) => item.kind === "source" || item.kind === "module")) {
    const absolutePath = path.join(paths.wikiDir, page.path);
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
    if (!raw) {
      continue;
    }
    const parsed = matter(raw);
    const refs = extractStandardReferences(
      [
        page.title,
        typeof parsed.data.standard_code === "string" ? parsed.data.standard_code : "",
        typeof parsed.data.title === "string" ? parsed.data.title : "",
        parsed.content.slice(0, 2000)
      ].join("\n")
    );
    for (const ref of refs) {
      const identity = standardIdentityKey(ref);
      const items = byIdentity.get(identity) ?? [];
      items.push({
        pageId: page.id,
        title: page.title,
        path: page.path,
        legalStatus: typeof parsed.data.legal_status === "string" ? parsed.data.legal_status : undefined,
        authorityLayer: typeof parsed.data.authority_layer === "string" ? parsed.data.authority_layer : undefined
      });
      byIdentity.set(identity, items);
    }
  }
  return { byIdentity };
}

function findingContradictsInventory(finding: LintFinding, inventory: StandardInventory): boolean {
  if (finding.code !== "coverage_gap") {
    return false;
  }
  const refs = extractStandardReferences(finding.message);
  return refs.some((ref) => inventory.byIdentity.has(standardIdentityKey(ref)));
}

function finalizeDeepLintFindings(findings: LintFinding[], inventory: StandardInventory): LintFinding[] {
  return uniqueBy(
    findings.filter((finding) => !findingContradictsInventory(finding, inventory)),
    (item) => `${item.code}:${item.message}`
  );
}

function collapsedKnowledgeSlug(pathValue: string): { collapsed: boolean; severity: LintFinding["severity"]; slug: string } {
  const slug = path.basename(pathValue, ".md").toLowerCase();
  if (slug === "item") {
    return { collapsed: true, severity: "error", slug };
  }
  if (/^(gb|hj|db)-?[a-z0-9-]*\d/i.test(slug)) {
    return { collapsed: false, severity: "info", slug };
  }
  if (/^\d+(?:-\d+)*$/.test(slug) || /^[a-z0-9]{1,3}$/i.test(slug)) {
    return { collapsed: true, severity: "warning", slug };
  }
  return { collapsed: false, severity: "info", slug };
}

async function deterministicEnvAirFindings(rootDir: string, graph: GraphArtifact): Promise<LintFinding[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const findings: LintFinding[] = [];
  const pages = graph.pages.filter(
    (page) =>
      page.kind === "source" || page.kind === "module" || page.kind === "concept" || page.kind === "entity" || page.kind === "output"
  );
  for (const page of pages) {
    const absolutePath = path.join(paths.wikiDir, page.path);
    const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
    if (!raw) {
      continue;
    }
    const parsed = matter(raw);
    const title = typeof parsed.data.title === "string" ? parsed.data.title : page.title;
    if (page.kind === "output") {
      const invalidSourceIds = page.sourceIds.filter(
        (sourceId) => sourceId.includes("#") || sourceId.includes(":") || /^https?:\/\//i.test(sourceId)
      );
      if (invalidSourceIds.length) {
        findings.push({
          severity: "error",
          code: "output_lineage_gap",
          message: `Output ${page.title} has citation-like values in source_ids instead of raw source IDs.`,
          pagePath: absolutePath,
          relatedPageIds: [page.id]
        });
      }
      continue;
    }
    const slugState = collapsedKnowledgeSlug(page.path);
    if ((page.kind === "concept" || page.kind === "entity") && slugState.collapsed) {
      findings.push({
        severity: slugState.severity,
        code: "knowledge_slug_collision",
        message: `${page.kind} page ${page.title} still uses a collapsed or ambiguous slug (${slugState.slug}).`,
        pagePath: absolutePath,
        relatedPageIds: [page.id]
      });
    }
    if ((page.kind === "concept" || page.kind === "entity") && raw.length > (page.status === "candidate" ? 80_000 : 60_000)) {
      findings.push({
        severity: "warning",
        code: "aggregate_page_too_large",
        message: `${page.kind} page ${title} is ${raw.length} bytes and may exceed the retrieval context budget.`,
        pagePath: absolutePath,
        relatedPageIds: [page.id]
      });
    }
    const sourceClaimCount = (parsed.content.match(/^- .*?\[source:/gm) ?? []).length;
    if ((page.kind === "concept" || page.kind === "entity") && sourceClaimCount > 80) {
      findings.push({
        severity: "warning",
        code: "source_claim_dump",
        message: `${page.kind} page ${title} contains ${sourceClaimCount} source-claim bullets; summarize or group claims by authority layer.`,
        pagePath: absolutePath,
        relatedPageIds: [page.id]
      });
    }
    if (page.kind !== "source" && page.kind !== "module") {
      continue;
    }
    const combined = `${title}\n${parsed.content}`;
    const refs = extractStandardReferences(combined);
    const documentRole = typeof parsed.data.document_role === "string" ? parsed.data.document_role : "";
    const authorityLayer = typeof parsed.data.authority_layer === "string" ? parsed.data.authority_layer : "";
    const relatedSourceIds = page.sourceIds;
    const looksLikePrimaryStandard =
      /(标准|规范|技术规定|监测方法|修改单|征求意见稿|编制说明)/.test(combined.slice(0, 1200)) &&
      !["statistics", "research_literature", "whitepaper", "official_explanation"].includes(documentRole) &&
      authorityLayer !== "evidence";
    const looksLikeStandard = refs.length > 0 && looksLikePrimaryStandard;
    if (
      typeof parsed.data.legal_status === "string" &&
      parsed.data.legal_status === "current_effective" &&
      /(年报|月报|公报|白皮书|蓝皮书)/.test(combined.slice(0, 1200))
    ) {
      findings.push({
        severity: "warning",
        code: "time_scoped_evidence_marked_current",
        message: `Statistical/report-like source ${title} is marked current_effective; it should be time_scoped_evidence or explanation_only.`,
        pagePath: absolutePath,
        relatedSourceIds,
        relatedPageIds: [page.id]
      });
    }
    if (!looksLikeStandard) {
      continue;
    }
    if (refs.length > 0 && isUnknown(parsed.data.standard_code)) {
      findings.push({
        severity: "warning",
        code: "standard_code_missing",
        message: `Standard-like source ${title} contains standard references but has no parsed standard_code.`,
        pagePath: absolutePath,
        relatedSourceIds,
        relatedPageIds: [page.id],
        suggestedQuery: `标准编号 ${refs[0]?.normalized ?? title} 在知识库中如何解析？`
      });
    }
    if (sourceTitleLooksLikeAmendment(title, page.path, parsed.data.standard_code) && parsed.data.document_role !== "amendment") {
      findings.push({
        severity: "warning",
        code: "amendment_without_role",
        message: `Source ${title} looks like an amendment but document_role is not amendment.`,
        pagePath: absolutePath,
        relatedSourceIds,
        relatedPageIds: [page.id]
      });
    }
    if ((parsed.data.authority_layer === "core" || parsed.data.authority_layer === "method") && isUnknown(parsed.data.legal_status)) {
      findings.push({
        severity: "warning",
        code: "core_status_unknown",
        message: `Core/method source ${title} has unknown legal_status.`,
        pagePath: absolutePath,
        relatedSourceIds,
        relatedPageIds: [page.id]
      });
    }
    if ((parsed.data.authority_layer === "core" || parsed.data.authority_layer === "method") && isUnknown(parsed.data.document_role)) {
      findings.push({
        severity: "warning",
        code: "core_role_unknown",
        message: `Core/method source ${title} has unknown document_role.`,
        pagePath: absolutePath,
        relatedSourceIds,
        relatedPageIds: [page.id]
      });
    }
    if (
      typeof parsed.data.legal_status === "string" &&
      parsed.data.legal_status === "current_effective" &&
      /(^|\/)(evolution|历史|废止|superseded|draft|征求意见)(\/|$)/i.test(page.path)
    ) {
      findings.push({
        severity: "warning",
        code: "status_path_mismatch",
        message: `Source ${title} is marked current_effective but lives under an evolution/history-like path.`,
        pagePath: absolutePath,
        relatedSourceIds,
        relatedPageIds: [page.id]
      });
    }
  }
  return uniqueBy(findings, (item) => `${item.code}:${item.pagePath ?? ""}:${item.message}`);
}

function graphContextSummary(graph: GraphArtifact) {
  const communities = (graph.communities ?? []).map((community) => ({
    ...community,
    size: community.nodeIds.length
  }));
  const godNodes = graph.nodes
    .filter((node) => node.isGodNode)
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0))
    .slice(0, 5)
    .map((node) => ({
      id: node.id,
      label: node.label,
      degree: node.degree ?? 0,
      bridgeScore: node.bridgeScore ?? 0,
      communityId: node.communityId
    }));

  return {
    communities,
    godNodes
  };
}

async function loadContextPages(rootDir: string, graph: GraphArtifact): Promise<DeepLintContextPage[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const contextPages = graph.pages.filter(
    (page): page is typeof page & { kind: "source" | "module" | "concept" | "entity" } =>
      page.kind === "source" || page.kind === "module" || page.kind === "concept" || page.kind === "entity"
  );

  return Promise.all(
    contextPages.slice(0, 18).map(async (page) => {
      const absolutePath = path.join(paths.wikiDir, page.path);
      const raw = await fs.readFile(absolutePath, "utf8").catch(() => "");
      const parsed = matter(raw);
      return {
        id: page.id,
        title: page.title,
        path: page.path,
        kind: page.kind,
        sourceIds: page.sourceIds,
        excerpt: truncate(normalizeWhitespace(parsed.content), 1400)
      };
    })
  );
}

function heuristicDeepFindings(
  contextPages: DeepLintContextPage[],
  structuralFindings: LintFinding[],
  graph: GraphArtifact
): LintFinding[] {
  const findings: LintFinding[] = [];
  const graphSummary = graphContextSummary(graph);

  for (const page of contextPages) {
    if (page.excerpt.includes("No claims extracted.")) {
      findings.push({
        severity: "warning",
        code: "coverage_gap",
        message: `Page ${page.title} has no extracted claims yet.`,
        pagePath: page.path,
        relatedSourceIds: page.sourceIds,
        relatedPageIds: [page.id],
        suggestedQuery: `What evidence or claims should ${page.title} contain?`
      });
    }
  }

  for (const page of contextPages.filter((item) => item.kind === "module").slice(0, 4)) {
    if (page.excerpt.includes("No top-level symbols detected.") || page.excerpt.includes("No imports detected.")) {
      findings.push({
        severity: "info",
        code: "coverage_gap",
        message: `Module page ${page.title} looks structurally thin and may need broader code ingestion coverage.`,
        pagePath: page.path,
        relatedSourceIds: page.sourceIds,
        relatedPageIds: [page.id],
        suggestedQuery: `What code context is missing around ${page.title}?`
      });
    }
  }

  for (const finding of structuralFindings.filter((item) => item.code === "uncited_claims").slice(0, 5)) {
    findings.push({
      severity: "warning",
      code: "missing_citation",
      message: finding.message,
      pagePath: finding.pagePath,
      suggestedQuery: finding.pagePath ? `Which sources support the claims in ${path.basename(finding.pagePath, ".md")}?` : undefined
    });
  }

  for (const page of contextPages.filter((item) => item.kind === "source").slice(0, 3)) {
    findings.push({
      severity: "info",
      code: "follow_up_question",
      message: `Investigate what broader implications ${page.title} has for the rest of the vault.`,
      pagePath: page.path,
      relatedSourceIds: page.sourceIds,
      relatedPageIds: [page.id],
      suggestedQuery: `What broader implications does ${page.title} have?`
    });
  }

  for (const community of graphSummary.communities.filter((item) => item.size <= 2).slice(0, 3)) {
    findings.push({
      severity: "info",
      code: "coverage_gap",
      message: `Community ${community.label} is weakly covered with only ${community.size} node(s).`,
      suggestedQuery: `What sources would strengthen coverage for ${community.label}?`
    });
  }

  for (const node of graphSummary.godNodes.filter((item) => item.bridgeScore > 1).slice(0, 3)) {
    findings.push({
      severity: "info",
      code: "follow_up_question",
      message: `${node.label} connects multiple parts of the vault and deserves a closer audit.`,
      suggestedQuery: `Why does ${node.label} connect multiple topics in this vault?`
    });
  }

  return uniqueBy(findings, (item) => `${item.code}:${item.message}`);
}

export async function runDeepLint(
  rootDir: string,
  structuralFindings: LintFinding[],
  options: { web?: boolean } = {}
): Promise<LintFinding[]> {
  const { paths } = await loadVaultConfig(rootDir);
  const graph = await readJsonFile<GraphArtifact>(paths.graphPath);
  if (!graph) {
    return [];
  }

  const schema = await loadVaultSchema(rootDir);
  const provider = await getProviderForTask(rootDir, "lintProvider");
  const manifests = await listManifests(rootDir);
  const contextPages = await loadContextPages(rootDir, graph);
  const deterministicFindings = await deterministicEnvAirFindings(rootDir, graph);
  const standardInventory = await buildStandardInventory(rootDir, graph);

  let findings: LintFinding[];
  if (provider.type === "heuristic") {
    findings = [...deterministicFindings, ...heuristicDeepFindings(contextPages, structuralFindings, graph)];
  } else {
    const graphSummary = graphContextSummary(graph);
    const response = await provider.generateStructured(
      {
        system:
          "You are an auditor for a local-first LLM knowledge vault. Return advisory findings only. Do not propose direct file edits.",
        prompt: [
          "Review this SwarmVault state and return high-signal advisory findings.",
          "Look for claims that contradict each other across different sources. When you find a genuine contradiction, use code 'contradiction' and include both source IDs in relatedSourceIds.",
          "",
          "Schema:",
          schema.content,
          "",
          "Vault summary:",
          `- sources: ${manifests.length}`,
          `- pages: ${graph.pages.length}`,
          `- structural_findings: ${structuralFindings.length}`,
          `- communities: ${graphSummary.communities.length}`,
          `- god_nodes: ${graphSummary.godNodes.length}`,
          "",
          "Structural findings:",
          structuralFindings.map((item) => `- [${item.severity}] ${item.code}: ${item.message}`).join("\n") || "- none",
          "",
          "Graph metrics:",
          graphSummary.communities.length
            ? graphSummary.communities.map((community) => `- ${community.label}: ${community.size} node(s)`).join("\n")
            : "- no derived communities",
          graphSummary.godNodes.length
            ? [
                "",
                "God nodes:",
                ...graphSummary.godNodes.map((node) => `- ${node.label} (degree=${node.degree}, bridge=${node.bridgeScore})`)
              ].join("\n")
            : "",
          "",
          "Page context:",
          contextPages
            .map((page) =>
              [
                `## ${page.title}`,
                `page_id: ${page.id}`,
                `path: ${page.path}`,
                `kind: ${page.kind}`,
                `source_ids: ${page.sourceIds.join(",") || "none"}`,
                page.excerpt
              ].join("\n")
            )
            .join("\n\n---\n\n")
        ].join("\n")
      },
      deepLintResponseSchema
    );

    findings = [
      ...deterministicFindings,
      ...response.findings.map((item) => ({
        severity: normalizeFindingSeverity(item.severity),
        code: item.code,
        message: item.message,
        relatedSourceIds: item.relatedSourceIds,
        relatedPageIds: item.relatedPageIds,
        suggestedQuery: item.suggestedQuery
      }))
    ];
  }

  if (!options.web) {
    const roleResults = await runConfiguredRoles(rootDir, ["audit", "safety"], {
      title: "Deep lint review",
      instructions: "Review the vault state and return advisory audit or safety findings only.",
      context: [
        `Structural findings: ${structuralFindings.length}`,
        `Context pages: ${contextPages.length}`,
        "",
        contextPages
          .map((page) => [`# ${page.title}`, `kind=${page.kind}`, `path=${page.path}`, page.excerpt].join("\n"))
          .join("\n\n---\n\n")
      ].join("\n")
    });
    const roleQuestions = summarizeRoleQuestions(roleResults);
    return finalizeDeepLintFindings(
      [
        ...findings,
        ...roleResults.flatMap((result) =>
          result.findings.map((finding) => ({
            severity: finding.severity,
            code: `${result.role}_review`,
            message: finding.message,
            relatedSourceIds: finding.relatedSourceIds,
            relatedPageIds: finding.relatedPageIds,
            suggestedQuery: finding.suggestedQuery
          }))
        ),
        ...roleQuestions.map((question) => ({
          severity: "info" as const,
          code: "follow_up_question",
          message: `Orchestration suggested a follow-up question: ${question}`,
          suggestedQuery: question
        }))
      ],
      standardInventory
    );
  }

  const webSearch = await getWebSearchAdapterForTask(rootDir, "deepLintProvider");
  const queryCache = new Map<string, Awaited<ReturnType<typeof webSearch.search>>>();

  for (const finding of findings) {
    const query = finding.suggestedQuery ?? finding.message;
    if (!queryCache.has(query)) {
      queryCache.set(query, await webSearch.search(query, 3));
    }
    finding.evidence = queryCache.get(query);
  }

  const roleResults = await runConfiguredRoles(rootDir, ["audit", "safety", "research"], {
    title: "Deep lint review with web search",
    instructions: "Review the vault state and return advisory findings, follow-up questions, and safer search angles.",
    context: [
      `Structural findings: ${structuralFindings.length}`,
      `Context pages: ${contextPages.length}`,
      "",
      contextPages.map((page) => [`# ${page.title}`, `kind=${page.kind}`, `path=${page.path}`, page.excerpt].join("\n")).join("\n\n---\n\n")
    ].join("\n")
  });
  const roleQuestions = summarizeRoleQuestions(roleResults);
  return finalizeDeepLintFindings(
    [
      ...findings,
      ...roleResults.flatMap((result) =>
        result.findings.map((finding) => ({
          severity: finding.severity,
          code: `${result.role}_review`,
          message: finding.message,
          relatedSourceIds: finding.relatedSourceIds,
          relatedPageIds: finding.relatedPageIds,
          suggestedQuery: finding.suggestedQuery
        }))
      ),
      ...roleQuestions.map((question) => ({
        severity: "info" as const,
        code: "follow_up_question",
        message: `Orchestration suggested a follow-up question: ${question}`,
        suggestedQuery: question
      }))
    ],
    standardInventory
  );
}

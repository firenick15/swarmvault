import { runCoreGraphExplain, runCoreGraphPath } from "./graph-query-core.js";
import type {
  BlastRadiusResult,
  EvidenceClass,
  GraphArtifact,
  GraphDiffResult,
  GraphEdge,
  GraphExplainNeighbor,
  GraphExplainResult,
  GraphHyperedge,
  GraphNode,
  GraphPage,
  GraphPathResult,
  GraphQueryMatch,
  GraphQueryOptions,
  GraphQueryResult,
  SearchResult
} from "./types.js";
import { normalizeWhitespace, uniqueBy } from "./utils.js";

function normalizeTarget(value: string): string {
  // NFKD strips diacritics (e.g. "Café" → "Cafe"), then we drop combining marks,
  // so graph query/path/explain can match labels regardless of accent marks.
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/\p{Mn}+/gu, "")
    .toLowerCase();
}

/** Precomputed diacritic-insensitive label for graph-time lookups. */
export function computeNormLabel(label: string): string {
  return normalizeTarget(label);
}

function nodeById(graph: GraphArtifact): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function pageById(graph: GraphArtifact): Map<string, GraphPage> {
  return new Map(graph.pages.map((page) => [page.id, page]));
}

function hyperedgesForNode(graph: GraphArtifact, nodeId: string): GraphHyperedge[] {
  return (graph.hyperedges ?? [])
    .filter((hyperedge) => hyperedge.nodeIds.includes(nodeId))
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label));
}

function scoreMatch(query: string, candidate: string): number {
  const normalizedQuery = normalizeTarget(query);
  const normalizedCandidate = normalizeTarget(candidate);
  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }
  if (normalizedCandidate === normalizedQuery) {
    return 100;
  }
  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 80;
  }
  if (normalizedCandidate.includes(normalizedQuery)) {
    return 60;
  }
  const queryTokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const candidateTokens = new Set(normalizedCandidate.split(/\s+/).filter(Boolean));
  const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length;
  return overlap ? overlap * 10 : 0;
}

function compactText(value: string): string {
  return normalizeTarget(value).replace(/\s+/g, "");
}

function queryTerms(query: string): string[] {
  const normalized = normalizeTarget(query);
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9./-]+|[\p{Script=Han}]{2,}/gu)) {
    const token = match[0];
    if (token.length >= 2) {
      terms.add(token);
    }
    if (/[\p{Script=Han}]/u.test(token) && token.length > 4) {
      for (let size = 2; size <= Math.min(6, token.length); size++) {
        for (let index = 0; index + size <= token.length; index++) {
          terms.add(token.slice(index, index + size));
        }
      }
    }
  }
  return [...terms].filter((term) => term.length >= 2);
}

function scoreTermOverlap(query: string, candidate: string): { score: number; matched: string[] } {
  const candidateCompact = compactText(candidate);
  if (!candidateCompact) {
    return { score: 0, matched: [] };
  }
  const matched = queryTerms(query).filter((term) => candidateCompact.includes(term.replace(/\s+/g, "")));
  const score = matched.reduce((sum, term) => sum + Math.min(18, Math.max(4, term.length * 2)), 0);
  return { score, matched: matched.slice(0, 8) };
}

function inferredGraphIntent(question: string, options?: GraphQueryOptions): string | undefined {
  if (options?.intent) {
    return options.intent;
  }
  const compact = compactText(question);
  if (/(月报|年报|公报|报告|统计|城市数量|339个城市|趋势|同比|环比)/u.test(compact)) {
    return "statistics";
  }
  if (/(限值|浓度|执行|依据|现行|标准|评价|达标)/u.test(compact)) {
    return "current_basis";
  }
  if (/(历史|废止|替代|代替|征求意见|编制说明|演化|变化|修改单)/u.test(compact)) {
    return "evolution";
  }
  if (/(地方|省|市|自治区|口径|落地)/u.test(compact)) {
    return "local";
  }
  return undefined;
}

function domainSeedBoost(
  question: string,
  result: SearchResult | undefined,
  options?: GraphQueryOptions
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const intent = inferredGraphIntent(question, options);
  const documentRole = result?.documentRole ?? "";
  const evidenceRole = result?.evidenceRole ?? "";
  const legalStatus = result?.legalStatus ?? "";
  const title = result?.title ?? "";
  const authorityLayer = result?.authorityLayer ?? "";
  const roleBoost = documentRole ? (options?.documentRoleBoosts?.[documentRole] ?? 0) : 0;
  const evidenceBoost = evidenceRole ? (options?.evidenceRoleBoosts?.[evidenceRole] ?? 0) : 0;
  if (roleBoost) {
    score += roleBoost;
    reasons.push(`profile_document_role_boost:${documentRole}:${roleBoost}`);
  }
  if (evidenceBoost) {
    score += evidenceBoost;
    reasons.push(`profile_evidence_role_boost:${evidenceRole}:${evidenceBoost}`);
  }
  if (intent === "statistics") {
    if (documentRole === "statistics" || evidenceRole === "statistics") {
      score += 45;
      reasons.push("statistics_intent_metadata");
    }
    if (/(月报|年报|公报|报告|统计|bulletin|statistics)/iu.test(title)) {
      score += 25;
      reasons.push("statistics_intent_title");
    }
  } else if (intent === "current_basis") {
    if (legalStatus === "current_effective") {
      score += 22;
      reasons.push("current_basis_current_status");
    }
    if (["law", "regulation", "policy", "standard", "emission_standard", "monitoring_method"].includes(documentRole)) {
      score += 28;
      reasons.push(`current_basis_document_role:${documentRole}`);
    }
    if (authorityLayer === "core" || authorityLayer === "method" || authorityLayer === "local") {
      score += 16;
      reasons.push(`current_basis_authority_layer:${authorityLayer}`);
    }
  } else if (intent === "evolution") {
    if (["draft", "amendment", "official_explanation", "compilation_explanation"].includes(documentRole)) {
      score += 28;
      reasons.push(`evolution_document_role:${documentRole}`);
    }
    if (["draft_consultation", "superseded", "explanation_only"].includes(legalStatus)) {
      score += 22;
      reasons.push(`evolution_legal_status:${legalStatus}`);
    }
  } else if (intent === "local") {
    if (authorityLayer === "local" || documentRole === "local_reference" || result?.region) {
      score += 30;
      reasons.push("local_intent_metadata");
    }
  }
  if (options?.region && result?.region && compactText(options.region) === compactText(result.region)) {
    score += 18;
    reasons.push(`region_match:${result.region}`);
  }
  if (
    options?.pollutant &&
    result?.pollutants?.some((pollutant) => compactText(pollutant).includes(compactText(options.pollutant ?? "")))
  ) {
    score += 18;
    reasons.push(`pollutant_match:${options.pollutant}`);
  }
  return { score, reasons };
}

function primaryNodeForPage(graph: GraphArtifact, page: GraphPage): GraphNode | undefined {
  const byId = nodeById(graph);
  return page.nodeIds.map((nodeId) => byId.get(nodeId)).find((node): node is GraphNode => Boolean(node));
}

function pageSearchMatches(graph: GraphArtifact, question: string, searchResults: SearchResult[]): GraphQueryMatch[] {
  const pages = pageById(graph);
  return searchResults
    .map((result) => {
      const page = pages.get(result.pageId);
      const score = Math.max(scoreMatch(question, result.title), scoreMatch(question, result.path));
      if (!page || score <= 0) {
        return null;
      }
      return {
        type: "page" as const,
        id: page.id,
        label: page.title,
        score
      };
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match));
}

function nodeMatches(graph: GraphArtifact, query: string): GraphQueryMatch[] {
  return graph.nodes
    .map((node) => ({
      type: "node" as const,
      id: node.id,
      label: node.label,
      score: Math.max(scoreMatch(query, node.label), scoreMatch(query, node.id))
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

function hyperedgeMatches(graph: GraphArtifact, query: string): GraphQueryMatch[] {
  return (graph.hyperedges ?? [])
    .map((hyperedge) => ({
      type: "hyperedge" as const,
      id: hyperedge.id,
      label: hyperedge.label,
      score: Math.max(scoreMatch(query, hyperedge.label), scoreMatch(query, hyperedge.why), scoreMatch(query, hyperedge.relation))
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
}

type EdgeNeighbor = {
  edge: GraphEdge;
  nodeId: string;
  direction: "incoming" | "outgoing";
};

function graphAdjacency(graph: GraphArtifact): Map<string, EdgeNeighbor[]> {
  const adjacency = new Map<string, EdgeNeighbor[]>();
  const push = (nodeId: string, item: EdgeNeighbor) => {
    if (!adjacency.has(nodeId)) {
      adjacency.set(nodeId, []);
    }
    adjacency.get(nodeId)?.push(item);
  };

  for (const edge of graph.edges) {
    push(edge.source, { edge, nodeId: edge.target, direction: "outgoing" });
    push(edge.target, { edge, nodeId: edge.source, direction: "incoming" });
  }

  for (const [nodeId, items] of adjacency.entries()) {
    items.sort((left, right) => right.edge.confidence - left.edge.confidence || left.edge.relation.localeCompare(right.edge.relation));
    adjacency.set(nodeId, items);
  }
  return adjacency;
}

const NODE_TYPE_PRIORITY: Record<string, number> = {
  concept: 6,
  entity: 5,
  source: 4,
  module: 3,
  symbol: 2,
  rationale: 1
};

function nodeTypePriority(type: string): number {
  return NODE_TYPE_PRIORITY[type] ?? 0;
}

function compareLabelCandidates(left: GraphNode, right: GraphNode): number {
  const priorityDelta = nodeTypePriority(right.type) - nodeTypePriority(left.type);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const degreeDelta = (right.degree ?? 0) - (left.degree ?? 0);
  if (degreeDelta !== 0) {
    return degreeDelta;
  }
  return left.id.localeCompare(right.id);
}

function resolveNode(graph: GraphArtifact, target: string): GraphNode | undefined {
  const normalized = normalizeTarget(target);
  const byId = nodeById(graph);
  if (byId.has(target)) {
    return byId.get(target);
  }

  // Prefer the most central node when multiple share a label. Previously the
  // resolver returned the first match, which silently picked leaf nodes over
  // hub concepts and broke graph path/explain on ambiguous labels.
  const labelMatches = graph.nodes.filter((node) => normalizeTarget(node.label) === normalized || normalizeTarget(node.id) === normalized);
  if (labelMatches.length) {
    return labelMatches.sort(compareLabelCandidates)[0];
  }

  const pages = graph.pages
    .map((page) => ({
      page,
      score: Math.max(scoreMatch(target, page.title), scoreMatch(target, page.path))
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.page.title.localeCompare(right.page.title));
  if (pages[0]) {
    return primaryNodeForPage(graph, pages[0].page);
  }

  return graph.nodes
    .map((node) => ({ node, score: Math.max(scoreMatch(target, node.label), scoreMatch(target, node.id)) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || compareLabelCandidates(left.node, right.node))[0]?.node;
}

export function evidenceClassForStatus(status: GraphEdge["status"]): EvidenceClass {
  if (status === "conflicted") {
    return "ambiguous";
  }
  if (status === "inferred" || status === "stale") {
    return "inferred";
  }
  return "extracted";
}

export function queryGraph(
  graph: GraphArtifact,
  question: string,
  searchResults: SearchResult[],
  options?: GraphQueryOptions
): GraphQueryResult {
  const traversal = options?.traversal ?? "bfs";
  const budget = Math.max(3, Math.min(options?.budget ?? 12, 50));
  const matches = uniqueBy(
    [
      ...(options?.semanticMatches ?? []),
      ...pageSearchMatches(graph, question, searchResults),
      ...nodeMatches(graph, question),
      ...hyperedgeMatches(graph, question)
    ],
    (match) => `${match.type}:${match.id}`
  )
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    .slice(0, 12);
  const pages = pageById(graph);
  const nodes = nodeById(graph);
  const searchByPage = new Map(searchResults.map((result, index) => [result.pageId, { result, index }]));
  const seedScores = new Map<string, { nodeId: string; pageId?: string; score: number; reasons: string[] }>();
  const addSeed = (nodeId: string | undefined, baseScore: number, reasons: string[], pageId?: string) => {
    if (!nodeId) {
      return;
    }
    const node = nodes.get(nodeId);
    const page = pageId ? pages.get(pageId) : node?.pageId ? pages.get(node.pageId) : undefined;
    const search = page ? searchByPage.get(page.id)?.result : undefined;
    const overlap = scoreTermOverlap(
      question,
      [node?.label ?? "", node?.id ?? "", page?.title ?? "", search?.title ?? "", search?.snippet ?? ""].join(" ")
    );
    const metadataBoost = domainSeedBoost(question, search, options);
    const score = baseScore + nodeTypePriority(node?.type ?? "") * 2 + overlap.score + metadataBoost.score;
    const nextReasons = uniqueBy(
      [...reasons, ...(overlap.matched.length ? [`query_terms:${overlap.matched.join(",")}`] : []), ...metadataBoost.reasons],
      (item) => item
    );
    const existing = seedScores.get(nodeId);
    if (!existing || score > existing.score) {
      seedScores.set(nodeId, { nodeId, pageId: page?.id, score, reasons: nextReasons });
    }
  };

  searchResults.forEach((result, index) => {
    const page = pages.get(result.pageId);
    const rankBoost = Number.isFinite(result.rank) ? Math.max(0, Math.min(30, -result.rank || 0)) : 0;
    for (const nodeId of page?.nodeIds ?? []) {
      addSeed(nodeId, 120 - index * 3 + rankBoost, [`search_result:${index + 1}`], page?.id);
    }
  });
  for (const match of matches) {
    if (match.type === "page") {
      const page = pages.get(match.id);
      for (const nodeId of page?.nodeIds ?? []) {
        addSeed(nodeId, 80 + match.score, [`graph_match:page:${match.label}`], page?.id);
      }
    } else if (match.type === "node") {
      addSeed(match.id, 70 + match.score, [`graph_match:node:${match.label}`]);
    } else {
      for (const nodeId of graph.hyperedges.find((hyperedge) => hyperedge.id === match.id)?.nodeIds ?? []) {
        addSeed(nodeId, 60 + match.score, [`graph_match:hyperedge:${match.label}`]);
      }
    }
  }
  const seedDiagnostics = [...seedScores.values()]
    .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))
    .slice(0, Math.max(budget * 2, 12));
  const seeds = seedDiagnostics.map((item) => item.nodeId);
  const warnings: string[] = [];
  if (!matches.length) {
    warnings.push("graph_query_no_direct_matches");
  }
  if (!seeds.length) {
    warnings.push("graph_query_no_seed_nodes");
  }

  const adjacency = graphAdjacency(graph);
  const visitedNodeIds: string[] = [];
  const visitedEdgeIds = new Set<string>();
  const seen = new Set<string>();
  const frontier = [...seeds];

  while (frontier.length && visitedNodeIds.length < budget) {
    const current = traversal === "dfs" ? frontier.pop() : frontier.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    visitedNodeIds.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      visitedEdgeIds.add(neighbor.edge.id);
      if (!seen.has(neighbor.nodeId)) {
        frontier.push(neighbor.nodeId);
      }
      if (visitedNodeIds.length + frontier.length >= budget * 2) {
        break;
      }
    }
  }

  const pageIds = uniqueBy(
    [
      ...searchResults.map((result) => result.pageId),
      ...matches.filter((match) => match.type === "page").map((match) => match.id),
      ...visitedNodeIds.flatMap((nodeId) => {
        const node = nodes.get(nodeId);
        return node?.pageId ? [node.pageId] : [];
      })
    ],
    (item) => item
  );
  const communities = uniqueBy(
    visitedNodeIds.map((nodeId) => nodes.get(nodeId)?.communityId).filter((communityId): communityId is string => Boolean(communityId)),
    (item) => item
  );
  const hyperedgeIds = uniqueBy(
    (graph.hyperedges ?? [])
      .filter((hyperedge) => hyperedge.nodeIds.some((nodeId) => visitedNodeIds.includes(nodeId)))
      .map((hyperedge) => hyperedge.id),
    (item) => item
  );

  return {
    question,
    traversal,
    seedNodeIds: seeds,
    seedPageIds: uniqueBy(
      [...searchResults.map((result) => result.pageId), ...matches.filter((match) => match.type === "page").map((match) => match.id)],
      (item) => item
    ),
    visitedNodeIds,
    visitedEdgeIds: [...visitedEdgeIds],
    hyperedgeIds,
    pageIds,
    communities,
    matches,
    seedDiagnostics: options?.explainSeeds ? seedDiagnostics : undefined,
    warnings: warnings.length ? warnings : undefined,
    summary: [
      `Seeds: ${seeds.join(", ") || "none"}`,
      `Visited nodes: ${visitedNodeIds.length}`,
      `Visited edges: ${visitedEdgeIds.size}`,
      `Touched group patterns: ${hyperedgeIds.length}`,
      `Communities: ${communities.join(", ") || "none"}`,
      `Pages: ${pageIds.join(", ") || "none"}`,
      ...(warnings.length ? [`Warnings: ${warnings.join(", ")}`] : [])
    ].join("\n")
  };
}

export function shortestGraphPath(graph: GraphArtifact, from: string, to: string): GraphPathResult {
  // The path walker is pure adjacency BFS, so we delegate to the shared core
  // module. The standalone exported HTML embeds an equivalent JS copy of
  // `runCoreGraphPath` so offline users see the same traversal.
  return runCoreGraphPath(graph, from, to);
}

export function explainGraphTarget(graph: GraphArtifact, target: string): GraphExplainResult {
  // The explain walker is pure adjacency traversal plus community/hyperedge
  // lookups, so we delegate to the shared core module. The standalone export
  // embeds an equivalent JS copy of `runCoreGraphExplain`.
  const result = runCoreGraphExplain(graph, target);
  if (!result) {
    throw new Error(`Could not resolve graph target: ${target}`);
  }
  // The core helper returns a minimal shape typed against `CoreGraph`. Up at
  // the server/MCP surface we hand back the richer `GraphExplainResult` which
  // re-uses the full `GraphNode`/`GraphPage` values already present in the
  // vault graph — the core result is structurally compatible because the
  // core types are subsets of the public graph types.
  const nodes = nodeById(graph);
  const node = nodes.get(result.node.id) ?? (result.node as GraphNode);
  const page = node.pageId ? pageById(graph).get(node.pageId) : undefined;
  const neighbors: GraphExplainNeighbor[] = result.neighbors.map((neighbor) => ({
    ...neighbor,
    type: (nodes.get(neighbor.nodeId)?.type ?? neighbor.type) as GraphNode["type"],
    evidenceClass: neighbor.evidenceClass as EvidenceClass
  }));
  return {
    target,
    node,
    page,
    community: result.community,
    neighbors,
    hyperedges: hyperedgesForNode(graph, node.id),
    summary: result.summary
  };
}

export function topGodNodes(graph: GraphArtifact, limit = 10): GraphNode[] {
  return graph.nodes
    .filter((node) => node.isGodNode)
    .sort((left, right) => (right.degree ?? 0) - (left.degree ?? 0))
    .slice(0, limit);
}

export function listHyperedges(graph: GraphArtifact, target?: string, limit = 25): GraphHyperedge[] {
  if (!target) {
    return [...(graph.hyperedges ?? [])]
      .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label))
      .slice(0, limit);
  }

  const node = resolveNode(graph, target);
  if (node) {
    return hyperedgesForNode(graph, node.id).slice(0, limit);
  }

  const page = graph.pages.find((candidate) => normalizeTarget(candidate.path) === normalizeTarget(target) || candidate.id === target);
  if (!page) {
    return [];
  }
  return (graph.hyperedges ?? [])
    .filter((hyperedge) => hyperedge.sourcePageIds.includes(page.id) || page.nodeIds.some((nodeId) => hyperedge.nodeIds.includes(nodeId)))
    .sort((left, right) => right.confidence - left.confidence || left.label.localeCompare(right.label))
    .slice(0, limit);
}

export function graphDiff(oldGraph: GraphArtifact, newGraph: GraphArtifact): GraphDiffResult {
  const oldNodeIds = new Set(oldGraph.nodes.map((node) => node.id));
  const newNodeIds = new Set(newGraph.nodes.map((node) => node.id));

  const addedNodes = newGraph.nodes
    .filter((node) => !oldNodeIds.has(node.id))
    .map((node) => ({ id: node.id, label: node.label, type: node.type }));
  const removedNodes = oldGraph.nodes
    .filter((node) => !newNodeIds.has(node.id))
    .map((node) => ({ id: node.id, label: node.label, type: node.type }));

  const oldEdgeIds = new Set(oldGraph.edges.map((edge) => edge.id));
  const newEdgeIds = new Set(newGraph.edges.map((edge) => edge.id));

  const addedEdges = newGraph.edges
    .filter((edge) => !oldEdgeIds.has(edge.id))
    .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, relation: edge.relation, evidenceClass: edge.evidenceClass }));
  const removedEdges = oldGraph.edges
    .filter((edge) => !newEdgeIds.has(edge.id))
    .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, relation: edge.relation, evidenceClass: edge.evidenceClass }));

  const oldPageIds = new Set(oldGraph.pages.map((page) => page.id));
  const newPageIds = new Set(newGraph.pages.map((page) => page.id));

  const addedPages = newGraph.pages
    .filter((page) => !oldPageIds.has(page.id))
    .map((page) => ({ id: page.id, path: page.path, title: page.title, kind: page.kind }));
  const removedPages = oldGraph.pages
    .filter((page) => !newPageIds.has(page.id))
    .map((page) => ({ id: page.id, path: page.path, title: page.title, kind: page.kind }));

  const parts: string[] = [];
  if (addedNodes.length || removedNodes.length) {
    const segments = [];
    if (addedNodes.length) segments.push(`${addedNodes.length} added`);
    if (removedNodes.length) segments.push(`${removedNodes.length} removed`);
    parts.push(`${segments.join(", ")} nodes`);
  }
  if (addedEdges.length || removedEdges.length) {
    const segments = [];
    if (addedEdges.length) segments.push(`${addedEdges.length} added`);
    if (removedEdges.length) segments.push(`${removedEdges.length} removed`);
    parts.push(`${segments.join(", ")} edges`);
  }
  if (addedPages.length || removedPages.length) {
    const segments = [];
    if (addedPages.length) segments.push(`${addedPages.length} added`);
    if (removedPages.length) segments.push(`${removedPages.length} removed`);
    parts.push(`${segments.join(", ")} pages`);
  }
  const summary = parts.length ? parts.join("; ") : "No changes";

  return { addedNodes, removedNodes, addedEdges, removedEdges, addedPages, removedPages, summary };
}

/**
 * Compute the blast radius of changing a file/module by tracing reverse import
 * edges via BFS. Returns all modules that transitively depend on the target.
 */
export function blastRadius(graph: GraphArtifact, target: string, options?: { maxDepth?: number }): BlastRadiusResult {
  const maxDepth = Math.max(1, Math.min(options?.maxDepth ?? 3, 10));

  // Resolve target to a module node
  const resolved = resolveNode(graph, target);
  const moduleNode =
    resolved?.type === "module" ? resolved : resolved?.moduleId ? graph.nodes.find((n) => n.id === resolved.moduleId) : undefined;

  if (!moduleNode) {
    // Try matching module nodes by label substring (file path matching)
    const normalizedTarget = normalizeTarget(target);
    const candidate = graph.nodes
      .filter((n) => n.type === "module")
      .find((n) => normalizeTarget(n.label).includes(normalizedTarget) || normalizeTarget(n.id).includes(normalizedTarget));
    if (!candidate) {
      return {
        target,
        totalAffected: 0,
        maxDepth,
        affectedModules: [],
        summary: `No module found matching "${target}".`
      };
    }
    return blastRadius(graph, candidate.id, options);
  }

  // Build reverse adjacency: for "imports" edges, track who imports whom.
  // If module A imports module B, then changing B affects A.
  const reverseImports = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.relation === "imports") {
      const dependents = reverseImports.get(edge.target) ?? [];
      dependents.push(edge.source);
      reverseImports.set(edge.target, dependents);
    }
  }

  // BFS from the target module following reverse import edges
  const affected: Array<{ moduleId: string; label: string; depth: number }> = [];
  const seen = new Set<string>([moduleNode.id]);
  const frontier: Array<{ id: string; depth: number }> = [{ id: moduleNode.id, depth: 0 }];
  const nodes = nodeById(graph);

  while (frontier.length > 0) {
    const current = frontier.shift()!;
    if (current.depth >= maxDepth) {
      continue;
    }
    for (const dependentId of reverseImports.get(current.id) ?? []) {
      if (seen.has(dependentId)) {
        continue;
      }
      seen.add(dependentId);
      const dependentNode = nodes.get(dependentId);
      const nextDepth = current.depth + 1;
      affected.push({
        moduleId: dependentId,
        label: dependentNode?.label ?? dependentId,
        depth: nextDepth
      });
      frontier.push({ id: dependentId, depth: nextDepth });
    }
  }

  affected.sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));

  const summary = affected.length
    ? `Changing "${moduleNode.label}" affects ${affected.length} module${affected.length === 1 ? "" : "s"} (max depth ${maxDepth}).`
    : `No modules depend on "${moduleNode.label}".`;

  return {
    target,
    resolvedModuleId: moduleNode.id,
    affectedModules: affected,
    totalAffected: affected.length,
    maxDepth,
    summary
  };
}

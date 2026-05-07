import { describe, expect, it } from "vitest";
import { queryGraph, shortestGraphPath } from "../src/graph-tools.js";
import type { GraphArtifact, GraphPage, SearchResult } from "../src/types.js";

function nodeId(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

/**
 * Builds a tiny graph where the label "auth" is ambiguous between a
 * well-connected concept hub and a leaf code source. The leaf source has
 * nothing but a single outgoing edge to its module. The concept sits between
 * two sources ("briefing" and "intro") so it is the only path that connects
 * either source to the other through the concept hub.
 *
 * Historically `graph path "auth" "briefing"` picked the leaf source first
 * and returned "No path found". The disambiguator should prefer the concept
 * hub because it has higher degree and higher node-type priority.
 */
function buildAmbiguousGraph(): GraphArtifact {
  const nodes = [
    {
      id: nodeId("concept", "auth"),
      type: "concept" as const,
      label: "auth",
      sourceIds: [],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 2,
      bridgeScore: 0.6
    },
    {
      id: nodeId("source", "auth-code"),
      type: "source" as const,
      label: "auth",
      pageId: nodeId("source", "auth-code"),
      sourceIds: ["auth-code"],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 1,
      bridgeScore: 0.1
    },
    {
      id: nodeId("module", "auth-code"),
      type: "module" as const,
      label: "auth module",
      pageId: nodeId("module", "auth-code"),
      sourceIds: ["auth-code"],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 1,
      bridgeScore: 0.1
    },
    {
      id: nodeId("source", "briefing"),
      type: "source" as const,
      label: "briefing",
      pageId: nodeId("source", "briefing"),
      sourceIds: ["briefing"],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 1,
      bridgeScore: 0.2
    },
    {
      id: nodeId("source", "intro"),
      type: "source" as const,
      label: "intro",
      pageId: nodeId("source", "intro"),
      sourceIds: ["intro"],
      projectIds: [],
      sourceClass: "first_party" as const,
      degree: 1,
      bridgeScore: 0.2
    }
  ];

  const edges = [
    {
      id: "auth-code->module",
      source: nodeId("source", "auth-code"),
      target: nodeId("module", "auth-code"),
      relation: "contains_code",
      status: "extracted" as const,
      evidenceClass: "extracted" as const,
      confidence: 1,
      provenance: ["test"]
    },
    {
      id: "briefing->concept:auth",
      source: nodeId("source", "briefing"),
      target: nodeId("concept", "auth"),
      relation: "mentions",
      status: "extracted" as const,
      evidenceClass: "extracted" as const,
      confidence: 1,
      provenance: ["test"]
    },
    {
      id: "intro->concept:auth",
      source: nodeId("source", "intro"),
      target: nodeId("concept", "auth"),
      relation: "mentions",
      status: "extracted" as const,
      evidenceClass: "extracted" as const,
      confidence: 1,
      provenance: ["test"]
    }
  ];

  return {
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    hyperedges: [],
    communities: [],
    sources: [],
    pages: []
  };
}

describe("shortestGraphPath", () => {
  it("prefers high-degree concept hubs over leaf sources when resolving ambiguous labels", () => {
    const graph = buildAmbiguousGraph();
    const result = shortestGraphPath(graph, "auth", "briefing");

    expect(result.resolvedFromNodeId).toBe("concept:auth");
    expect(result.resolvedToNodeId).toBe("source:briefing");
    expect(result.found).toBe(true);
    expect(result.nodeIds).toEqual(["concept:auth", "source:briefing"]);
  });

  it("still resolves explicit node ids without disambiguation", () => {
    const graph = buildAmbiguousGraph();
    const result = shortestGraphPath(graph, "source:auth-code", "module:auth-code");

    expect(result.resolvedFromNodeId).toBe("source:auth-code");
    expect(result.resolvedToNodeId).toBe("module:auth-code");
    expect(result.found).toBe(true);
  });

  it("reports no path between genuinely disconnected nodes", () => {
    const graph = buildAmbiguousGraph();
    const result = shortestGraphPath(graph, "source:auth-code", "source:briefing");

    expect(result.found).toBe(false);
    expect(result.nodeIds).toEqual([]);
  });
});

function page(id: string, title: string, nodeIds: string[]): GraphPage {
  return {
    id,
    path: `${id}.md`,
    title,
    kind: "source",
    sourceIds: [id],
    projectIds: [],
    nodeIds,
    freshness: "fresh",
    status: "active",
    confidence: 0.9,
    backlinks: [],
    schemaHash: "schema",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: [],
    relatedNodeIds: nodeIds,
    relatedSourceIds: [id],
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    compiledFrom: [],
    managedBy: "system"
  };
}

function buildDomainRankingGraph(): GraphArtifact {
  return {
    generatedAt: "2026-05-02T00:00:00.000Z",
    nodes: [
      {
        id: "source:obd",
        type: "source",
        label: "OBD 远程排放管理",
        pageId: "source:obd",
        sourceIds: ["source:obd"],
        projectIds: [],
        degree: 1
      },
      {
        id: "source:monthly",
        type: "source",
        label: "全国城市空气质量月度报告",
        pageId: "source:monthly",
        sourceIds: ["source:monthly"],
        projectIds: [],
        degree: 1
      }
    ],
    edges: [],
    hyperedges: [],
    communities: [],
    sources: [],
    pages: [
      page("source:obd", "重型车 OBD 远程排放管理", ["source:obd"]),
      page("source:monthly", "全国城市空气质量月度报告", ["source:monthly"])
    ]
  };
}

describe("queryGraph domain-aware seed ranking", () => {
  it("boosts statistical report sources for statistics-style Chinese queries", () => {
    const graph = buildDomainRankingGraph();
    const searchResults: SearchResult[] = [
      {
        pageId: "source:obd",
        path: "source:obd.md",
        title: "重型车 OBD 远程排放管理",
        snippet: "车辆排放监管。",
        rank: -1,
        projectIds: [],
        documentRole: "technical_guide",
        evidenceRole: "method"
      },
      {
        pageId: "source:monthly",
        path: "source:monthly.md",
        title: "全国城市空气质量月度报告",
        snippet: "覆盖 339 个城市的空气质量统计。",
        rank: -2,
        projectIds: [],
        documentRole: "statistics",
        evidenceRole: "statistics"
      }
    ];

    const result = queryGraph(graph, "全国城市空气质量月度报告 339个城市", searchResults, {
      budget: 4,
      explainSeeds: true
    });

    expect(result.seedDiagnostics?.[0]?.nodeId).toBe("source:monthly");
    expect(result.seedDiagnostics?.[0]?.reasons).toContain("statistics_intent_metadata");
  });

  it("treats source-alias retrieval hits as direct graph matches for long business titles", () => {
    const graph = buildDomainRankingGraph();
    const searchResults: SearchResult[] = [
      {
        pageId: "source:monthly",
        path: "source:monthly.md",
        title: "中华民共和国环境保护部令",
        snippet: "《污染源自动监控设施现场监督检查办法》自2012年4月1日起施行。",
        rank: -1,
        projectIds: [],
        authorityLayer: "core",
        documentRole: "regulation",
        evidenceRole: "current_authority",
        retrievalStage: "source_alias"
      }
    ];

    const result = queryGraph(graph, "污染源自动监控设施现场监督检查办法什么时候施行？", searchResults, {
      budget: 4,
      explainSeeds: true
    });

    expect(result.warnings ?? []).not.toContain("graph_query_no_direct_matches");
    expect(result.matches.some((match) => match.type === "page" && match.id === "source:monthly")).toBe(true);
  });

  it("does not treat city-count wording as an HJ standard code seed", () => {
    const graph: GraphArtifact = {
      generatedAt: "2026-05-02T00:00:00.000Z",
      nodes: [
        {
          id: "entity:hj-168",
          type: "entity",
          label: "HJ 168",
          sourceIds: [],
          projectIds: [],
          degree: 1
        },
        {
          id: "entity:168-cities",
          type: "entity",
          label: "168 个重点城市",
          sourceIds: ["source:monthly"],
          projectIds: [],
          degree: 2
        },
        {
          id: "source:monthly",
          type: "source",
          label: "全国城市空气质量月报",
          pageId: "source:monthly",
          sourceIds: ["source:monthly"],
          projectIds: [],
          degree: 2
        }
      ],
      edges: [],
      hyperedges: [],
      communities: [],
      sources: [],
      pages: [
        page("source:hj-168", "HJ 168 环境监测分析方法标准", ["entity:hj-168"]),
        page("source:monthly", "全国城市空气质量月报 168 个重点城市排名", ["entity:168-cities", "source:monthly"])
      ]
    };

    const result = queryGraph(graph, "168 个城市排名范围、名单和区域构成", [], {
      budget: 4,
      explainSeeds: true
    });

    expect(result.seedDiagnostics?.some((seed) => seed.nodeId === "entity:hj-168")).toBe(false);
    expect(result.seedDiagnostics?.some((seed) => seed.nodeId === "entity:168-cities")).toBe(true);
  });
});

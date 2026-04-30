import { describe, expect, it } from "vitest";
import { synthesizeEnvAirTopics } from "../src/topic-synthesis.js";
import type { ProviderAdapter, SourceAnalysis } from "../src/types.js";

function analysis(sourceId: string, title: string, summary: string, standardCode: string): SourceAnalysis {
  const now = new Date().toISOString();
  return {
    analysisVersion: 9,
    sourceId,
    sourceHash: sourceId,
    semanticHash: sourceId,
    schemaHash: "schema",
    title,
    summary,
    concepts: [{ id: "concept:limits", name: "环境空气质量标准限值", description: "limits" }],
    entities: [],
    claims: [
      {
        id: `claim:${sourceId}:1`,
        text: `${title} 说明环境空气质量标准限值。`,
        confidence: 0.9,
        status: "extracted",
        polarity: "neutral",
        citation: sourceId
      }
    ],
    questions: [],
    tags: [],
    domain: {
      authorityLayer: "core",
      legalForce: "mandatory",
      documentRole: "standard",
      legalStatus: "current_effective",
      jurisdiction: "national",
      standardCode,
      replaces: [],
      replacedBy: [],
      pollutants: [],
      useFor: [],
      doNotUseFor: [],
      notes: [],
      metadataSource: "rule",
      verificationState: "rule_verified",
      llmUncertainFields: []
    },
    analysisMode: "heuristic",
    providerId: "heuristic",
    providerModel: "heuristic",
    warnings: [],
    rationales: [],
    producedAt: now
  };
}

describe("environment air topic synthesis", () => {
  it("builds cross-document topic pages with source coverage metadata", async () => {
    const provider = { type: "heuristic", id: "heuristic", model: "heuristic", capabilities: new Set() } as unknown as ProviderAdapter;
    const pages = await synthesizeEnvAirTopics({
      provider,
      schemaContent: "environment air schema",
      analyses: [
        analysis("gb3095", "GB 3095-2012 环境空气质量标准", "环境空气质量标准限值。", "GB 3095-2012"),
        analysis("gb3095-2026", "GB 3095-2026 环境空气质量标准", "环境空气质量标准限值修订。", "GB 3095-2026")
      ]
    });

    expect(pages[0]?.topicId).toBe("ambient-air-quality-limits");
    expect(pages[0]?.sourceIds).toEqual(["gb3095", "gb3095-2026"]);
    expect(pages[0]?.body).toContain("现行执行依据");
  });
});

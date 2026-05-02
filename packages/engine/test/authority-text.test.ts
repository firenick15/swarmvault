import { describe, expect, it } from "vitest";
import { classifyAuthorityUse, reconcileSourceAnalysisAuthority } from "../src/domain/authority-text.js";
import type { SourceAnalysis } from "../src/types.js";

function baseAnalysis(overrides: Partial<SourceAnalysis> = {}): SourceAnalysis {
  return {
    analysisVersion: 11,
    sourceId: "source:test",
    sourceHash: "hash",
    semanticHash: "semantic",
    schemaHash: "schema",
    title: "历史标准",
    summary: "该文件是现行标准，可作为执法依据。",
    concepts: [{ id: "concept:test", name: "测试概念", description: "当前执行的标准。" }],
    entities: [{ id: "entity:test", name: "测试实体", description: "必须按照该文件执行。" }],
    claims: [
      {
        id: "claim:test:1",
        text: "该标准可作为现行执行依据。",
        confidence: 0.8,
        status: "extracted",
        polarity: "positive",
        citation: "source:test"
      }
    ],
    questions: ["这份资料是否可作为现行执行依据？"],
    tags: [],
    rationales: [],
    producedAt: "2026-05-02T00:00:00.000Z",
    ...overrides
  };
}

describe("authority text reconciliation", () => {
  it("does not allow superseded material to remain an unqualified current execution basis", () => {
    const analysis = baseAnalysis({
      domain: {
        authorityLayer: "evolution",
        legalForce: "superseded",
        documentRole: "standard",
        legalStatus: "superseded",
        jurisdiction: "national",
        replacedBy: ["HJ 000-2026"]
      }
    });

    const reconciled = reconcileSourceAnalysisAuthority(analysis);

    expect(reconciled.summary).toContain("历史版本或已被代替材料");
    expect(reconciled.summary).not.toContain("现行标准");
    expect(reconciled.claims[0]?.status).toBe("stale");
    expect(reconciled.warnings).toContain("authority_text_reconciled:summary");
  });

  it("classifies statistical reports as time-scoped evidence instead of execution basis", () => {
    const classification = classifyAuthorityUse({
      authorityLayer: "evidence",
      legalForce: "statistical",
      documentRole: "statistics",
      legalStatus: "time_scoped_evidence",
      jurisdiction: "national"
    });

    expect(classification.useClass).toBe("statistics_evidence");
    expect(classification.statement).toContain("统计或报告材料");
  });
});

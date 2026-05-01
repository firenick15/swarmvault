import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseStructuredWithRepair } from "../src/providers/structured-repair.js";

describe("structured output repair", () => {
  it("truncates oversized source-analysis arrays and safely resets authority enum fields", () => {
    const warnings: string[] = [];
    const schema = z.object({
      claims: z
        .array(
          z.object({
            text: z.string().min(1),
            citation: z.string().min(1)
          })
        )
        .max(2),
      domain: z.object({
        authorityLayer: z.enum(["core", "method", "unknown"]).default("unknown")
      })
    });

    const parsed = parseStructuredWithRepair(
      schema,
      {
        claims: [
          { text: "a", citation: { sourceId: "S1" } },
          { text: "b", citation: "S2" },
          { text: "c", citation: "S3" }
        ],
        domain: { authorityLayer: "mandatory-core-standard" }
      },
      { schemaName: "source_analysis", repairWarnings: warnings }
    );

    expect(parsed.claims).toHaveLength(2);
    expect(parsed.claims[0]?.citation).toBe("S1");
    expect(parsed.domain.authorityLayer).toBe("unknown");
    expect(warnings.some((warning) => warning.includes("truncated_array"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("unsafe_authority_field_reset"))).toBe(true);
  });

  it("maps grounded-answer evidence aliases to allowed evidence ids", () => {
    const schema = z.object({
      answer: z.string(),
      usedEvidenceIds: z.array(z.string()).default([]),
      recommendedNextTool: z.enum(["knowledge_base", "environment_data_mcp", "both"]).optional()
    });

    const parsed = parseStructuredWithRepair(
      schema,
      {
        answer: "依据材料回答。",
        usedEvidenceIds: ["source-a#chunk-1", "missing"],
        recommendedNextTool: "monitoring_data"
      },
      {
        schemaName: "grounded_answer",
        allowedEvidenceIds: ["E1"],
        evidenceIdAliases: {
          "source-a#chunk-1": "E1"
        }
      }
    );

    expect(parsed.usedEvidenceIds).toEqual(["E1"]);
    expect(parsed.recommendedNextTool).toBe("environment_data_mcp");
  });
});

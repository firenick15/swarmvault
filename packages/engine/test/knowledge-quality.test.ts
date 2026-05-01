import { describe, expect, it } from "vitest";
import { evaluateKnowledgeCandidateQuality } from "../src/knowledge-quality.js";
import { normalizeKnowledgeLabelKey, slugify } from "../src/utils.js";

describe("knowledge candidate quality", () => {
  it("keeps Chinese knowledge labels distinct from legacy ASCII slug collapse", () => {
    expect(slugify("臭氧协同控制")).toBe("item");
    expect(normalizeKnowledgeLabelKey("臭氧协同控制")).not.toBe(normalizeKnowledgeLabelKey("环境空气质量评价"));
    expect(normalizeKnowledgeLabelKey("大气污染虚拟治理成本法")).not.toBe(normalizeKnowledgeLabelKey("环境空气质量评价"));
  });

  it("allows controlled environmental short labels but downgrades unknown short labels", () => {
    expect(evaluateKnowledgeCandidateQuality({ title: "O3", kind: "concept" }).severity).toBe("ok");
    expect(evaluateKnowledgeCandidateQuality({ title: "CO", kind: "concept" }).severity).toBe("ok");
    expect(evaluateKnowledgeCandidateQuality({ title: "XYZ", kind: "concept" }).severity).toBe("candidate_only");
  });

  it("downgrades document-title candidates without rejecting searchable index entries", () => {
    const quality = evaluateKnowledgeCandidateQuality({ title: "2025_环境空气质量公报目录", kind: "entity", sourceIds: ["s1"] });
    expect(quality.severity).toBe("index_only");
    expect(quality.tags).toContain("document_title");
  });
});

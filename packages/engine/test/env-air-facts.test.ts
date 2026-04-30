import { describe, expect, it } from "vitest";
import { extractStandardReferences } from "../src/domain/env-air.js";
import { extractEnvAirStructuredFacts } from "../src/domain/env-air-facts.js";

describe("environment air structured facts", () => {
  it("uses stable fact ids while preserving typed legacy aliases", () => {
    const body = [
      "# HJ 633-2012",
      "",
      "## 表 1 空气质量分指数限值",
      "",
      "| 污染物 | 浓度范围 | IAQI |",
      "|---|---:|---:|",
      "| PM2.5 | 0-35 μg/m3 | 0-50 |",
      "| O3 | 100-160 μg/m3 | 50-100 |"
    ].join("\n");
    const facts = extractEnvAirStructuredFacts({
      body,
      standardRefs: extractStandardReferences("HJ 633-2012"),
      standardCode: "HJ 633-2012"
    });

    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]?.id).toMatch(/^fact:\d+$/);
    expect(facts[0]?.stableId).toBe(facts[0]?.id);
    expect(facts[0]?.legacyIds.some((id) => /^fact:\d+:[a-z_]+$/.test(id))).toBe(true);
  });
});

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
    const tableFact = facts.find((fact) => fact.provenance === "table");
    expect(tableFact?.id).toMatch(/^fact:[a-f0-9]{16}$/);
    expect(tableFact?.stableId).toBe(tableFact?.id);
    expect(tableFact?.legacyIds.some((id) => /^fact:\d+$/.test(id))).toBe(true);
    expect(tableFact?.legacyIds.some((id) => /^fact:\d+:[a-z_]+$/.test(id))).toBe(true);
    expect(tableFact?.provenance).toBe("table");
  });
});

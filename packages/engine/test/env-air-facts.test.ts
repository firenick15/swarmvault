import { describe, expect, it } from "vitest";
import { extractStandardReferences } from "../src/domain/env-air.js";
import { extractEnvAirStructuredFacts } from "../src/domain/env-air-facts.js";
import type { DocumentStructureBlock } from "../src/fact-extraction/document-structure.js";
import { structuredFactsFromBlocks } from "../src/fact-extraction/facts.js";

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

  it("dedupes repeated structured facts with the same stable id", () => {
    const block: DocumentStructureBlock = {
      id: "source-1:table_row:1",
      kind: "table_row",
      sourceId: "source-1",
      sectionPath: ["表 1 空气质量分指数限值"],
      tableNo: "表 1",
      rowIndex: 1,
      cells: ["PM2.5", "0-35 μg/m3", "0-50"],
      headers: ["污染物", "浓度范围", "IAQI"],
      rawText: "| PM2.5 | 0-35 μg/m3 | 0-50 |",
      normalizedText: "PM2.5 0-35 μg/m3 0-50"
    };

    const facts = structuredFactsFromBlocks({
      sourceId: "source-1",
      standardCode: "HJ 633-2012",
      blocks: [block, { ...block }]
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]?.id).toMatch(/^fact:[a-f0-9]{16}$/);
  });
});

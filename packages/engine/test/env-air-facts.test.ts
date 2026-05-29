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

  it("derives GB3095 table-cell limit facts from structured table rows", () => {
    const body = [
      "# GB 3095-2026",
      "",
      "## 4.2 环境空气功能区质量要求",
      "",
      "表1 环境空气污染物基本项目浓度限值",
      "<table>",
      "<tr><td rowspan=2>序号</td><td rowspan=2>污染物项目</td><td rowspan=2>平均时间</td><td colspan=2>过渡阶段浓度限值</td><td colspan=2>浓度限值</td><td rowspan=2>单位</td></tr>",
      "<tr><td>一级</td><td>二级</td><td>一级</td><td>二级</td></tr>",
      "<tr><td rowspan=2>4</td><td rowspan=2>臭氧 (O3)</td><td>日最大8小时平均</td><td>100</td><td>160</td><td>100</td><td>160</td><td rowspan=4>μg/m³</td></tr>",
      "<tr><td>1小时平均</td><td>160</td><td>200</td><td>160</td><td>200</td></tr>",
      "<tr><td rowspan=2>5</td><td rowspan=2>颗粒物（粒径小于等于10μm，PM10)</td><td>年平均</td><td>40</td><td>60</td><td>20</td><td>50</td></tr>",
      "<tr><td>日平均</td><td>50</td><td>120</td><td>50</td><td>100</td></tr>",
      "</table>"
    ].join("\n");

    const facts = extractEnvAirStructuredFacts({
      body,
      standardRefs: extractStandardReferences("GB 3095-2026"),
      standardCode: "GB 3095-2026"
    });

    expect(
      facts.some(
        (fact) =>
          fact.pollutant === "O3" &&
          fact.metric === "final_limit_level_2" &&
          fact.averagingPeriod === "日最大8小时平均" &&
          fact.value === "160" &&
          fact.unit === "μg/m³"
      )
    ).toBe(true);
    expect(
      facts.some(
        (fact) =>
          fact.pollutant === "PM10" &&
          fact.metric === "final_limit_level_2" &&
          fact.averagingPeriod === "年平均" &&
          fact.value === "50" &&
          fact.unit === "μg/m³"
      )
    ).toBe(true);
    expect(
      facts.some(
        (fact) =>
          fact.pollutant === "PM10" &&
          fact.metric === "transition_limit_level_2" &&
          fact.averagingPeriod === "日平均" &&
          fact.value === "120"
      )
    ).toBe(true);
  });

  it("derives HJ663 pollutant-specific annual percentile facts", () => {
    const body = [
      "# HJ 663-2026",
      "",
      "表1 基本评价项目及平均时间",
      "<table>",
      "<tr><td>评价时段</td><td>评价项目及平均时间</td></tr>",
      "<tr><td>年评价</td><td>SO2 年平均、SO2 日平均第98百分位数；NO2 年平均、NO2 日平均第98百分位数；PM10 年平均、PM10 日平均第95百分位数；PM2.5 年平均、PM2.5 日平均第95百分位数；CO 日平均第95百分位数；O3 日最大8小时平均第90百分位数</td></tr>",
      "</table>"
    ].join("\n");

    const facts = extractEnvAirStructuredFacts({
      body,
      standardRefs: extractStandardReferences("HJ 663-2026"),
      standardCode: "HJ 663-2026"
    });

    expect(
      facts.some(
        (fact) =>
          fact.pollutant === "O3" &&
          fact.metric === "annual_evaluation_percentile_90_mda8" &&
          fact.value === "90" &&
          fact.unit === "percentile"
      )
    ).toBe(true);
    expect(
      facts.some(
        (fact) =>
          fact.pollutant === "CO" &&
          fact.metric === "annual_evaluation_percentile_95_daily" &&
          fact.averagingPeriod === "日平均" &&
          fact.value === "95"
      )
    ).toBe(true);
  });

  it("derives HJ633 AQI and IAQI rounding rule facts", () => {
    const facts = extractEnvAirStructuredFacts({
      body: "4.2.6 环境空气质量指数及空气质量分指数的计算结果应全部向上进位取整数，不保留小数。",
      standardRefs: extractStandardReferences("HJ 633-2026"),
      standardCode: "HJ 633-2026"
    });

    expect(facts.some((fact) => fact.metric === "aqi_iaqi_rounding_rule" && fact.rawText.includes("向上进位取整数"))).toBe(true);
  });
});

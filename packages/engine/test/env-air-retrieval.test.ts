import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { applyStandardRelationOverrides } from "../src/domain/standard-relations.js";
import { compileVault, extractStandardReferences, ingestInput, initVault, queryVault, searchTokens } from "../src/index.js";
import { rebuildSearchIndex, searchPages } from "../src/search.js";
import type { GraphPage } from "../src/types.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<{ rootDir: string; wikiDir: string; dbPath: string }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarmvault-env-air-"));
  tempDirs.push(rootDir);
  const wikiDir = path.join(rootDir, "wiki");
  await fs.mkdir(path.join(wikiDir, "sources"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "state", "retrieval"), { recursive: true });
  return { rootDir, wikiDir, dbPath: path.join(rootDir, "state", "retrieval", "fts-000.sqlite") };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function graphPage(id: string, title: string, relativePath: string): GraphPage {
  const now = new Date().toISOString();
  return {
    id,
    path: relativePath,
    title,
    kind: "source",
    sourceIds: [id.replace(/^source:/, "")],
    projectIds: [],
    nodeIds: [],
    freshness: "fresh",
    status: "active",
    confidence: 1,
    backlinks: [],
    schemaHash: "test",
    sourceHashes: {},
    sourceSemanticHashes: {},
    relatedPageIds: [],
    relatedNodeIds: [],
    relatedSourceIds: [],
    createdAt: now,
    updatedAt: now,
    compiledFrom: [],
    managedBy: "system"
  };
}

async function writePage(wikiDir: string, relativePath: string, frontmatter: Record<string, unknown>, body: string): Promise<void> {
  const absolutePath = path.join(wikiDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, matter.stringify(body, frontmatter), "utf8");
}

async function updateConfig(
  rootDir: string,
  mutate: (config: { providers: Record<string, unknown>; tasks: Record<string, string> }) => void
): Promise<void> {
  const configPath = path.join(rootDir, "swarmvault.config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
    providers: Record<string, unknown>;
    tasks: Record<string, string>;
  };
  mutate(config);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

describe("environment air retrieval", () => {
  it("keeps Chinese business terms and environmental standard references searchable", () => {
    const tokens = searchTokens("GB 3095-2012 环境空气 PM2.5 和臭氧限值");
    expect(tokens).toContain("gb");
    expect(tokens).toContain("3095");
    expect(tokens).toContain("gb30952012");
    expect(tokens).toContain("环境空气");
    expect(tokens).toContain("pm2.5");

    const refs = extractStandardReferences("参照 HJ/T 193-2005、HJ 633—2012 和 DB11/T 1234-2024");
    expect(refs.map((ref) => ref.normalized)).toEqual(["HJ/T 193-2005", "HJ 633-2012", "DB11/T 1234-2024"]);
  });

  it("keeps explicit historical standard references ahead of current replacements", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const oldPage = graphPage("source:hj633", "HJ 633-2012 环境空气质量指数技术规定", "sources/hj633.md");
    const newPage = graphPage("source:hj664", "HJ 664-2013 环境空气质量监测点位布设技术规范", "sources/hj664.md");
    await writePage(
      wikiDir,
      oldPage.path,
      {
        authority_layer: "core",
        legal_status: "superseded",
        document_role: "technical_regulation",
        standard_code: "HJ 633-2012"
      },
      "# HJ 633-2012\n\n环境空气质量指数 AQI 日报和实时报技术规定，后续存在替代和演化关系。"
    );
    await writePage(
      wikiDir,
      newPage.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "technical_regulation",
        standard_code: "HJ 664-2013"
      },
      "# HJ 664-2013\n\n现行环境空气质量监测点位布设技术规范。"
    );
    await rebuildSearchIndex(dbPath, [oldPage, newPage], wikiDir);

    const results = searchPages(dbPath, "HJ 633—2012 是否现行有效？", {
      limit: 5,
      authorityLayer: ["core", "evolution", "method"],
      includeSuperseded: true
    });

    expect(results[0]?.pageId).toBe("source:hj633");
    expect(results[0]?.retrievalStage).toBe("standard_exact");
  });

  it("expands pollutant-limit questions to the ambient air quality standard and returns chunk evidence", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const standardPage = graphPage("source:gb3095", "GB 3095-2012 环境空气质量标准", "sources/gb3095.md");
    const methodPage = graphPage("source:hj194", "HJ 194 环境空气质量手工监测技术规范", "sources/hj194.md");
    await writePage(
      wikiDir,
      standardPage.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "GB 3095-2012",
        pollutants: ["PM2.5", "PM10", "O3"]
      },
      [
        "# GB 3095-2012",
        "",
        "环境空气功能区分为一类区和二类区。",
        "",
        "## 表 1 环境空气污染物基本项目浓度限值",
        "",
        "| 污染物 | 平均时间 | 一级浓度限值 | 二级浓度限值 |",
        "|---|---|---:|---:|",
        "| PM2.5 | 年平均 | 15 | 35 |",
        "| PM2.5 | 24小时平均 | 35 | 75 |"
      ].join("\n")
    );
    await writePage(
      wikiDir,
      methodPage.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "monitoring_method",
        standard_code: "HJ 194-2017",
        pollutants: ["PM2.5"]
      },
      "# HJ 194\n\n手工监测采样和质量保证要求。"
    );
    await rebuildSearchIndex(dbPath, [standardPage, methodPage], wikiDir);

    const results = searchPages(dbPath, "PM2.5 年平均一级和二级限值是多少？", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    expect(results[0]?.pageId).toBe("source:gb3095");
    expect(results[0]?.chunkId).toBeTruthy();
    expect(results[0]?.chunkKind).toBe("table");
  });

  it("focuses GB 3095 table evidence on O3 rows instead of PM2.5-only snippets", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const standardPage = graphPage("source:gb3095-o3", "GB 3095-2026 环境空气质量标准", "sources/gb3095-o3.md");
    await writePage(
      wikiDir,
      standardPage.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "GB 3095-2026",
        pollutants: ["PM2.5", "PM10", "O3", "SO2", "NO2", "CO"]
      },
      [
        "# GB 3095-2026",
        "",
        "## 表 1 环境空气污染物基本项目浓度限值",
        "",
        "| 污染物 | 平均时间 | 一级浓度限值 | 二级浓度限值 |",
        "|---|---|---:|---:|",
        "| PM2.5 | 年平均 | 15 | 35 |",
        "| PM2.5 | 24小时平均 | 35 | 75 |",
        "| O3（臭氧） | 日最大8小时平均 | 100 | 160 |",
        "| O3（臭氧） | 1小时平均 | 160 | 200 |",
        "| SO2（二氧化硫） | 1小时平均 | 150 | 500 |"
      ].join("\n")
    );
    await rebuildSearchIndex(dbPath, [standardPage], wikiDir);

    const results = searchPages(dbPath, "臭氧 O3 日最大8小时平均和1小时平均一级二级限值是多少？", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    expect(results[0]?.pageId).toBe("source:gb3095-o3");
    expect(results[0]?.chunkKind).toBe("table");
    expect(results[0]?.snippet).toContain("O3");
    expect(results[0]?.snippet).toContain("日最大8小时平均");
    expect(results[0]?.snippet).toContain("1小时平均");
    expect(results[0]?.snippet).toContain("100");
    expect(results[0]?.snippet).toContain("160");
    expect(results[0]?.snippet).toContain("200");
  });

  it("uses the generalized assessment-validity intent to retrieve validity-rule facts", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const standardPage = graphPage("source:hj663-validity", "HJ 663-2026 环境空气质量评价技术规范", "sources/hj663-validity.md");
    await writePage(
      wikiDir,
      standardPage.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "HJ 663-2026",
        evidence_role: "current_authority"
      },
      [
        "# HJ 663-2026",
        "",
        "## 评价项目和评价方法",
        "",
        "| 评价项目 | 评价方法 | 数据有效性要求 |",
        "|---|---|---|",
        "| PM2.5 年评价 | 年平均浓度评价 | 有效监测数据应满足年评价的有效数据要求 |",
        "| O3 年评价 | 日最大8小时平均第90百分位数评价 | 有效监测数据应满足百分位数统计要求 |"
      ].join("\n")
    );
    await rebuildSearchIndex(dbPath, [standardPage], wikiDir);

    const results = searchPages(dbPath, "2023 年环境空气质量评价报告的数据有效性要求是什么？", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    expect(results[0]?.pageId).toBe("source:hj663-validity");
    expect(results.some((result) => result.retrievalStage === "structured_fact")).toBe(true);
    expect(results[0]?.snippet).toMatch(/数据有效性|有效监测数据|有效数据/);
  });

  it("retrieves Chinese monitoring-method questions without malformed FTS failures", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const page = graphPage("source:auto", "HJ 193 环境空气气态污染物自动监测系统", "sources/auto.md");
    await writePage(
      wikiDir,
      page.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "monitoring_method",
        standard_code: "HJ 193-2013",
        pollutants: ["SO2", "NO2", "O3", "CO"]
      },
      [
        "# HJ 193",
        "",
        "环境空气气态污染物连续自动监测系统运行维护时，应关注零点噪声、量程噪声、示值误差、转换炉效率和平行性等质量控制指标。"
      ].join("\n")
    );
    await rebuildSearchIndex(dbPath, [page], wikiDir);

    expect(() => searchPages(dbPath, 'HJ/T 193-2005 "零点噪声"', { limit: 5 })).not.toThrow();
    const results = searchPages(dbPath, "气态污染物自动监测系统零点噪声要求是什么", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });
    expect(results[0]?.pageId).toBe("source:auto");
    expect(results[0]?.authorityLayer).toBe("method");
  });

  it("applies replacement metadata before indexing current-basis retrieval", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const oldPage = graphPage("source:gb1996", "GB 3095-1996 环境空气质量标准", "sources/gb1996.md");
    const newPage = graphPage("source:gb2012", "GB 3095-2012 环境空气质量标准", "sources/gb2012.md");
    await writePage(
      wikiDir,
      oldPage.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "GB 3095-1996",
        pollutants: ["PM10", "SO2", "NO2"]
      },
      "# GB 3095-1996\n\n旧版环境空气质量标准。"
    );
    await writePage(
      wikiDir,
      newPage.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "GB 3095-2012",
        effective_date: "2016-01-01",
        replaces: ["GB 3095-1996"],
        pollutants: ["PM2.5", "PM10", "O3", "SO2", "NO2", "CO"]
      },
      "# GB 3095-2012\n\n现行环境空气质量标准，增加了 PM2.5 和 O3 等评价要求。"
    );

    await applyStandardRelationOverrides(wikiDir, [oldPage, newPage], new Date("2026-04-29T00:00:00.000Z"));
    const oldFrontmatter = matter(await fs.readFile(path.join(wikiDir, oldPage.path), "utf8")).data;
    expect(oldFrontmatter.legal_status).toBe("superseded");
    expect(oldFrontmatter.replaced_by).toEqual(["GB 3095-2012"]);

    await rebuildSearchIndex(dbPath, [oldPage, newPage], wikiDir);
    const results = searchPages(dbPath, "GB 3095 PM2.5 现行限值", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });
    expect(results.map((result) => result.pageId)).toContain("source:gb2012");
    expect(results.map((result) => result.pageId)).not.toContain("source:gb1996");
  });

  it("answers authority-boundary questions with schema evidence available to the query provider", async () => {
    const { rootDir } = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "authority-query-provider.mjs"),
      [
        "export async function createAdapter(id, config) {",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(['chat', 'structured']),",
        "    async generateText() {",
        "      return { text: '研究论文不能直接作为执法依据要求企业执行；应以现行有效法律法规、标准或规范为强制依据。[E1]' };",
        "    },",
        "    async generateStructured() {",
        "      return {",
        "        answer: '研究论文不能直接作为执法依据要求企业执行；只能作为背景、机理或论证参考，强制执行仍需引用现行有效法律法规、标准或规范。[E1]',",
        "        usedEvidenceIds: ['E1'],",
        "        unsupportedClaims: [],",
        "        missingEvidence: [],",
        "        recommendedNextTool: 'knowledge_base'",
        "      };",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );
    await updateConfig(rootDir, (config) => {
      config.providers.authorityQuery = {
        type: "custom",
        model: "authority-query-test",
        module: "./authority-query-provider.mjs",
        capabilities: ["chat", "structured"]
      };
      config.tasks.queryProvider = "authorityQuery";
    });
    await fs.writeFile(
      path.join(rootDir, "research.md"),
      "# 研究论文证据边界\n\n研究论文和综述可以作为环境空气污染成因分析的参考材料，但不能替代现行有效标准、法规或规范作为执法依据要求企业执行。",
      "utf8"
    );
    await ingestInput(rootDir, "research.md");
    await compileVault(rootDir);

    const result = await queryVault(rootDir, {
      question: "研究论文能否直接作为执法依据要求企业执行？",
      save: false,
      intent: "authority_boundary",
      strictGrounding: true,
      debugContext: true
    });

    expect(result.evidenceState).toBe("grounded");
    expect(result.answer).toContain("不能直接作为执法依据");
    expect(result.retrievalDebug?.evidenceItems.some((item) => item.citation.startsWith("schema:"))).toBe(true);
    expect(result.agentDecision?.reportUsability).toBe("direct");
  });

  it("normalizes provider citations from source or chunk aliases back to evidence ids", async () => {
    const { rootDir } = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "alias-query-provider.mjs"),
      [
        "export async function createAdapter(id, config) {",
        "  return {",
        "    id,",
        "    type: 'custom',",
        "    model: config.model,",
        "    capabilities: new Set(['chat', 'structured']),",
        "    async generateText() { return { text: 'fallback [E1]' }; },",
        "    async generateStructured(request) {",
        "      const citation = request.prompt.match(/\\[E1\\] kind=[^\\n]* citation=([^\\n]+)/)?.[1] || 'E1';",
        "      return {",
        "        answer: `环境空气质量标准提供达标评价依据。[" + "$" + "{citation}]`,",
        "        usedEvidenceIds: [citation],",
        "        unsupportedClaims: [],",
        "        missingEvidence: [],",
        "        recommendedNextTool: 'knowledge_base'",
        "      };",
        "    }",
        "  };",
        "}"
      ].join("\n"),
      "utf8"
    );
    await updateConfig(rootDir, (config) => {
      config.providers.aliasQuery = {
        type: "custom",
        model: "alias-query-test",
        module: "./alias-query-provider.mjs",
        capabilities: ["chat", "structured"]
      };
      config.tasks.queryProvider = "aliasQuery";
    });
    await fs.writeFile(path.join(rootDir, "standard.md"), "# GB 3095\n\n环境空气质量标准提供达标评价依据。", "utf8");
    await ingestInput(rootDir, "standard.md");
    await compileVault(rootDir);

    const result = await queryVault(rootDir, {
      question: "环境空气质量标准能否作为达标评价依据？",
      save: false,
      strictGrounding: true,
      debugContext: true
    });

    expect(result.answer).toContain("[E1]");
    expect(result.evidenceState).toBe("grounded");
    expect(result.invalidCitations).toEqual([]);
    expect(result.retrievalDebug?.usedEvidenceIds).toEqual(["E1"]);
    expect(result.groundingWarnings?.some((warning) => warning.startsWith("normalized_citation:"))).toBe(true);
  });

  it("keeps SO2 data-quality questions in data-MCP handoff instead of strict literal failure", async () => {
    const { rootDir } = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(
      path.join(rootDir, "so2-qaqc.md"),
      [
        "# SO2 连续监测异常数据处理",
        "",
        "知识库负责说明 SO2 自动监测质量控制、异常值审核、负值记录复核和报告表述边界。",
        "某站点连续负值、小时值、日均值、过程分析和统计计算应调用环境数据 MCP 查询原始监测数据后再判断。"
      ].join("\n"),
      "utf8"
    );
    await ingestInput(rootDir, "so2-qaqc.md");
    await compileVault(rootDir);

    const result = await queryVault(rootDir, {
      question: "某站点 SO2 连续负值怎么处理，知识库和数据MCP分别做什么？",
      save: false,
      strictGrounding: true,
      debugContext: true
    });

    expect(result.evidenceState).not.toBe("insufficient");
    expect(["environment_data_mcp", "both"]).toContain(result.recommendedNextTool);
    expect(result.agentDecision?.mustCallTools).toContain("environment_data_mcp");
    expect(result.agentDecision?.reportUsability).toBe("needs_data_mcp");
  });

  it("returns insufficient evidence instead of generating an ungrounded answer", async () => {
    const { rootDir } = await createTempWorkspace();
    await initVault(rootDir);
    await fs.writeFile(path.join(rootDir, "note.md"), "# Note\n\n环境空气质量标准用于达标评价。", "utf8");
    await ingestInput(rootDir, "note.md");
    await compileVault(rootDir);

    const result = await queryVault(rootDir, {
      question: "XYZ12345 不存在指标的现行执行依据是什么",
      save: false,
      intent: "current_basis",
      strictGrounding: true,
      debugContext: true
    });

    expect(result.evidenceState).toBe("insufficient");
    expect(result.citations).toEqual([]);
    expect(result.groundingWarnings?.some((warning) => warning.startsWith("strict_exact_terms_not_found:"))).toBe(true);
    expect(result.retrievalDebug?.usedEvidenceIds).toEqual([]);
  });
});

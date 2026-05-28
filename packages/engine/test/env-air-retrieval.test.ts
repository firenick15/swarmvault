import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { applyStandardRelationOverrides } from "../src/domain/standard-relations.js";
import {
  compileVault,
  extractStandardReferences,
  ingestInput,
  initVault,
  normalizeEnvAirLegalStatus,
  queryVault,
  searchTokens
} from "../src/index.js";
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
    expect(["source_alias", "standard_exact"]).toContain(results[0]?.retrievalStage);
  });

  it("recalls explicit standard-code sources even when stale metadata marks them superseded", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const exactPage = graphPage("source:hj818-formal", "HJ 818-2018 气态污染物运行质控技术规范", "sources/hj818-formal.md");
    const guidePage = graphPage("source:hj818-guide", "光化学监测数据审核技术指南", "sources/hj818-guide.md");
    await writePage(
      wikiDir,
      exactPage.path,
      {
        authority_layer: "method",
        legal_status: "superseded",
        document_role: "monitoring_method",
        standard_code: "HJ 818-2018",
        pollutants: ["SO2", "NO2", "O3", "CO"]
      },
      "# HJ 818-2018\n\n环境空气气态污染物 SO2、NO2、O3、CO 连续自动监测系统运行和质控技术规范。"
    );
    await writePage(
      wikiDir,
      guidePage.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "technical_guide",
        standard_code: "HJ 818"
      },
      "# 技术指南\n\n本指南引用 HJ 818 作为光化学组分数据审核参考。"
    );
    await rebuildSearchIndex(dbPath, [exactPage, guidePage], wikiDir);

    const results = searchPages(dbPath, "HJ 818 SO2 NO2 O3 CO 运行质控", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    expect(results[0]?.pageId).toBe("source:hj818-formal");
    expect(["source_alias", "standard_exact"]).toContain(results[0]?.retrievalStage);
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

  it("uses source filename and document-number aliases as an early retrieval stage", async () => {
    const { rootDir, wikiDir, dbPath } = await createTempWorkspace();
    const page = graphPage("source:item-19", "中华民共和国环境保护部令", "sources/item-19.md");
    await fs.mkdir(path.join(rootDir, "state", "manifests"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "state", "manifests", "item-19.json"),
      JSON.stringify({
        sourceId: "item-19",
        originalPath: "D:/kb/raw/污染源自动监控设施现场监督检查办法_环保部19号令.md",
        storedPath: "raw/item-19.md",
        sourceKind: "markdown"
      }),
      "utf8"
    );
    await writePage(
      wikiDir,
      page.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "regulation",
        standard_code: "环境保护部令 第19号"
      },
      [
        "# 中华民共和国环境保护部令",
        "",
        "## Source Excerpt",
        "",
        "《污染源自动监控设施现场监督检查办法》自2012年4月1日起施行，规定污染源自动监控设施现场监督检查的程序、内容和法律责任。"
      ].join("\n")
    );
    await rebuildSearchIndex(dbPath, [page], wikiDir);

    const results = searchPages(dbPath, "污染源自动监控设施现场监督检查办法什么时候施行？", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    expect(results[0]?.pageId).toBe("source:item-19");
    expect(results[0]?.retrievalStage).toBe("source_alias");
  });

  it("keeps frontmatter legal status authoritative over stale generated status notices", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const standardPage = graphPage(
      "source:hj818",
      "2018_环境空气气态污染物_SO2、NO2、O3、CO_连续自动监测系统运行和质控技术规范_HJ818-2018",
      "sources/hj818.md"
    );
    const guidePage = graphPage("source:guide", "总站光化学组分自动数据审核技术指南", "sources/guide.md");
    await writePage(
      wikiDir,
      standardPage.path,
      {
        authority_layer: "method",
        legal_status: "superseded",
        document_role: "monitoring_method",
        standard_code: "HJ 818-2018",
        pollutants: ["SO2", "NO2", "O3", "CO"]
      },
      [
        "# 2018_环境空气气态污染物_SO2、NO2、O3、CO_连续自动监测系统运行和质控技术规范_HJ818-2018",
        "",
        "Standard Code: `HJ 818-2018`",
        "",
        "## Status Notice",
        "",
        "- Normalized legal status: `current_effective`",
        "- legal_status_normalized:effective_date_on_or_before_as_of_date",
        "",
        "本标准规定环境空气 SO2、NO2、O3、CO 连续自动监测系统运行与质控要求，包括零点、量程、转换炉效率等运行质量控制。"
      ].join("\n")
    );
    await writePage(
      wikiDir,
      guidePage.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "technical_guide",
        standard_code: "HJ 818",
        pollutants: ["O3", "NOx", "CO"]
      },
      "# 总站光化学组分自动数据审核技术指南\n\n本指南引用 HJ 818 作为 NOy 和光化学组分数据审核的衔接依据。"
    );
    await rebuildSearchIndex(dbPath, [standardPage, guidePage], wikiDir);

    const results = searchPages(dbPath, "HJ 818 SO2 NO2 O3 CO 运行质控", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    const hj818 = results.find((result) => result.pageId === "source:hj818");
    expect(hj818?.legalStatus).toBe("superseded");
    expect(results[0]?.pageId).toBe("source:hj818");
  });

  it("retrieves table evidence for list-complete monitoring test item questions", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const currentPage = graphPage(
      "source:hj653-2021",
      "HJ 653-2021 环境空气颗粒物连续自动监测系统技术要求及检测方法",
      "sources/hj653-2021.md"
    );
    const oldPage = graphPage("source:hj653-2013", "HJ 653-2013 环境空气颗粒物连续自动监测系统技术要求及检测方法", "sources/hj653-2013.md");
    await writePage(
      wikiDir,
      currentPage.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "monitoring_method",
        standard_code: "HJ 653-2021",
        pollutants: ["PM10", "PM2.5"]
      },
      [
        "# HJ 653-2021",
        "",
        "## 表 3 PM10 和 PM2.5 自动监测系统性能指标要求",
        "",
        "| 检测项目 | 技术要求 | 检测方法 |",
        "|---|---|---|",
        "| 检出限 | <=2 ug/m3 | 7.1 |",
        "| 校准膜示值误差 | ±2% | 7.2 |",
        "| 温度测量示值误差 | ±2 ℃ | 7.3 |",
        "| 大气压测量示值误差 | ±1 kPa | 7.4 |",
        "| 湿度测量示值误差 | ±5% RH | 7.5 |",
        "| 断电影响测试 | 断电影响条件下进行流量测试，应符合流量测试指标要求 | 7.7 |",
        "| 大气压影响测试 | 不同大气压条件下进行流量测试，应符合流量测试指标要求 | 7.9 |",
        "| 参比方法比对测试 | 斜率、截距、相关系数要求 | 7.11 |",
        "| 有效数据率 | >=90% | 7.12 |"
      ].join("\n")
    );
    await writePage(
      wikiDir,
      oldPage.path,
      {
        authority_layer: "method",
        legal_status: "superseded",
        document_role: "monitoring_method",
        standard_code: "HJ 653-2013",
        pollutants: ["PM10", "PM2.5"]
      },
      "# HJ 653-2013\n\n## 表 3 PM10 和 PM2.5 连续监测系统检测项目\n\n| 检测项目 | 要求 |\n|---|---|\n| 校准膜重现性 | ±2% |"
    );
    await rebuildSearchIndex(dbPath, [currentPage, oldPage], wikiDir);

    const results = searchPages(dbPath, "PM2.5和PM10连续监测系统性能测试项目包括哪些？", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    expect(results[0]?.pageId).toBe("source:hj653-2021");
    expect(results[0]?.chunkKind).toBe("table");
    expect(results[0]?.snippet).toContain("校准膜示值误差");
    expect(results[0]?.snippet).toContain("湿度测量示值误差");
    expect(results[0]?.snippet).toContain("断电影响测试");
    expect(results[0]?.snippet).toContain("大气压影响测试");
    expect(results[0]?.snippet).toContain("有效数据率");
    expect(results.map((result) => result.pageId)).not.toContain("source:hj653-2013");
  });

  it("routes NO2 converter-efficiency QA/QC questions to HJ 818 before ambient NO2 limit tables", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const hj818Page = graphPage(
      "source:hj818",
      "2018_环境空气气态污染物_SO2、NO2、O3、CO_连续自动监测系统运行和质控技术规范_HJ818-2018",
      "sources/hj818.md"
    );
    const gb3095Page = graphPage("source:gb3095", "GB 3095-2026 环境空气质量标准", "sources/gb3095.md");
    const hj654Page = graphPage("source:hj654", "HJ 654-2013 环境空气气态污染物连续自动监测系统技术要求及检测方法", "sources/hj654.md");
    await writePage(
      wikiDir,
      hj818Page.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "qa_qc",
        standard_code: "HJ 818-2018",
        pollutants: ["SO2", "NO2", "O3", "CO"]
      },
      "# HJ 818-2018\n\n化学发光法NO2监测仪器至少每半年检查1次二氧化氮转换炉的转换效率，转换效率应≥96%，否则应维修或更换。"
    );
    await writePage(
      wikiDir,
      gb3095Page.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "GB 3095-2026",
        pollutants: ["NO2"]
      },
      "# GB 3095-2026\n\nNO2 年平均、日平均、1小时平均浓度限值。"
    );
    await writePage(
      wikiDir,
      hj654Page.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "monitoring_method",
        standard_code: "HJ 654-2013",
        pollutants: ["SO2", "NO2", "O3", "CO"]
      },
      "# HJ 654-2013\n\nNO2分析仪器中NO2-NO转化器的转换效率应≥96%，规定检测方法。"
    );
    await rebuildSearchIndex(dbPath, [hj818Page, gb3095Page, hj654Page], wikiDir);

    const results = searchPages(dbPath, "NO2 转换炉效率多久检查一次，合格要求是多少？", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    expect(results[0]?.pageId).toBe("source:hj818");
    expect(results.map((result) => result.pageId)).toContain("source:hj654");
    expect(results[0]?.snippet).toContain("每半年");
  });

  it("routes common ambient monitoring and CEMS scenario aliases to the right standard families", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const pages = [
      {
        page: graphPage("source:hj817", "HJ 817-2018 环境空气颗粒物连续自动监测系统运行和质控技术规范", "sources/hj817.md"),
        data: { authority_layer: "method", legal_status: "current_effective", document_role: "qa_qc", standard_code: "HJ 817-2018" },
        body: "# HJ 817-2018\n\nPM10和PM2.5颗粒物自动监测系统运行质控，规定零值负值处理、流量审核、环境参数检查、平行性检查和更换仪器后的数据一致性检查。"
      },
      {
        page: graphPage("source:hj818", "HJ 818-2018 环境空气气态污染物连续自动监测系统运行和质控技术规范", "sources/hj818.md"),
        data: { authority_layer: "method", legal_status: "current_effective", document_role: "qa_qc", standard_code: "HJ 818-2018" },
        body: "# HJ 818-2018\n\nSO2、NO2、O3、CO气态污染物自动监测系统运行质控，规定零值负值处理、零点漂移、量程漂移、校准周期、臭氧零跨检查、时段要求和NO2转换炉效率检查。"
      },
      {
        page: graphPage("source:hj653", "HJ 653-2021 环境空气颗粒物连续自动监测系统技术要求及检测方法", "sources/hj653.md"),
        data: {
          authority_layer: "method",
          legal_status: "current_effective",
          document_role: "monitoring_method",
          standard_code: "HJ 653-2021"
        },
        body: "# HJ 653-2021\n\n颗粒物自动监测系统技术要求及检测方法，规定参比方法比对、斜率、截距和相关系数。"
      },
      {
        page: graphPage("source:hj655", "HJ 655-2013 环境空气颗粒物连续自动监测系统安装和验收技术规范", "sources/hj655.md"),
        data: {
          authority_layer: "method",
          legal_status: "current_effective",
          document_role: "monitoring_method",
          standard_code: "HJ 655-2013"
        },
        body: "# HJ 655-2013\n\n新建颗粒物自动监测系统安装验收，规定站房、采样系统、仪器设备、联网、试运行和比对调试等验收检查清单。"
      },
      {
        page: graphPage("source:hj618", "HJ 618-2011 环境空气 PM10 和 PM2.5 的测定 重量法", "sources/hj618.md"),
        data: {
          authority_layer: "method",
          legal_status: "current_effective",
          document_role: "monitoring_method",
          standard_code: "HJ 618-2011"
        },
        body: "# HJ 618-2011\n\n环境空气PM10和PM2.5重量法参比方法，规定手工采样、滤膜恒温恒湿平衡、样品处理和称量质控步骤。"
      },
      {
        page: graphPage("source:hj654", "HJ 654-2013 环境空气气态污染物连续自动监测系统技术要求及检测方法", "sources/hj654.md"),
        data: {
          authority_layer: "method",
          legal_status: "current_effective",
          document_role: "monitoring_method",
          standard_code: "HJ 654-2013"
        },
        body: "# HJ 654-2013\n\nSO2、NO2、O3、CO气态自动监测仪器技术要求、性能指标和检测方法。"
      },
      {
        page: graphPage("source:hj75", "HJ 75-2017 固定污染源烟气排放连续监测技术规范", "sources/hj75.md"),
        data: {
          authority_layer: "method",
          legal_status: "current_effective",
          document_role: "monitoring_method",
          standard_code: "HJ 75-2017"
        },
        body: "# HJ 75-2017\n\n固定污染源烟气CEMS运行维护、运行质控和连续监测技术规范。"
      },
      {
        page: graphPage("source:hj212", "HJ 212-2025 污染物在线监控系统数据传输标准", "sources/hj212.md"),
        data: { authority_layer: "method", legal_status: "current_effective", document_role: "standard", standard_code: "HJ 212-2025" },
        body: "# HJ 212-2025\n\n污染物在线监控和CEMS数据传输、数采仪传输协议要求。"
      },
      {
        page: graphPage("source:gb3095", "GB 3095-2026 环境空气质量标准", "sources/gb3095.md"),
        data: {
          authority_layer: "core",
          legal_status: "current_effective",
          document_role: "standard",
          standard_code: "GB 3095-2026"
        },
        body: "# GB 3095-2026\n\n环境空气质量标准规定污染物基本项目、平均时间和浓度限值，PM2.5、O3、NO2等应按标准限值表评价。"
      },
      {
        page: graphPage("source:hj633", "HJ 633-2026 环境空气质量指数 AQI 技术规定", "sources/hj633.md"),
        data: {
          authority_layer: "method",
          legal_status: "current_effective",
          document_role: "standard",
          standard_code: "HJ 633-2026"
        },
        body: "# HJ 633-2026\n\n环境空气质量指数AQI技术规定，规定IAQI、AQI、空气质量级别、评价项目和首要污染物确定方法。"
      },
      {
        page: graphPage("source:order19", "中华人民共和国环境保护部令", "sources/order19.md"),
        data: {
          authority_layer: "core",
          legal_status: "current_effective",
          document_role: "regulation",
          standard_code: "环境保护部令第19号"
        },
        body: "# 19号令\n\n污染源自动监控设施现场监督检查办法规定污染源自动监控现场检查依据、执法现场查在线监控设备、在线数据异常、CEMS离线时段现场检查、弄虚作假认定、现场检查清单、事实证据、程序证据和处理程序，不能只凭截图直接下处罚结论，不能用设备技术标准替代现场检查依据。"
      },
      {
        page: graphPage("source:order28", "污染源自动监控管理办法 国家环保总局令第28号", "sources/order28.md"),
        data: {
          authority_layer: "core",
          legal_status: "current_effective",
          document_role: "regulation",
          standard_code: "国家环保总局令第28号"
        },
        body: "# 28号令\n\n污染源自动监控管理办法规定排污单位、运维单位和生态环境主管部门等主体的管理职责清单，涉及停运、拆除、故障报告、设备更换备案联网、运维责任和排污单位管理责任。"
      },
      {
        page: graphPage("source:heavy", "关于优化重污染天气应对工作的指导意见", "sources/heavy.md"),
        data: {
          authority_layer: "core",
          legal_status: "current_effective",
          document_role: "policy",
          standard_code: "环大气〔2024〕6号"
        },
        body: "# 重污染天气\n\n重污染天气和重污染过程应急材料包括应急预警、预警材料、应急响应、应急减排清单和绩效分级检查要点。"
      }
    ];
    for (const item of pages) {
      await writePage(wikiDir, item.page.path, item.data, item.body);
    }
    await rebuildSearchIndex(
      dbPath,
      pages.map((item) => item.page),
      wikiDir
    );

    const cases = [
      ["颗粒物自动站 PM2.5 负值怎么处理", "source:hj817"],
      ["站点颗粒物数据质控要检查哪些环境参数", "source:hj817"],
      ["臭氧自动监测运行质控有哪些检查项目和时段要求", "source:hj818"],
      ["PM2.5 参比方法比对斜率截距相关系数", "source:hj653"],
      ["现场新建颗粒物自动监测系统验收，检查清单该怎么列", "source:hj655"],
      ["颗粒物自动监测新站验收，系统性能和现场验收分别怎么找依据", "source:hj655"],
      ["颗粒物重量法样品处理和称量质控包括哪些要点", "source:hj618"],
      ["SO2 小时值偶尔负，能不能直接删", "source:hj818"],
      ["气态仪器零点漂移、量程漂移、校准周期这些怎么按运行质控说", "source:hj818"],
      ["换了颗粒物仪器，数据一致性要不要做", "source:hj817"],
      ["气态自动监测仪器技术要求和检测方法", "source:hj654"],
      ["空气质量标准限值表里 PM2.5、O3、NO2 对应哪些平均时间", "source:gb3095"],
      ["AQI评价项目包括哪些，首要污染物怎么确定", "source:hj633"],
      ["CEMS 数据传输按哪个规范", "source:hj212"],
      ["固定污染源 CEMS 运行维护和质控", "source:hj75"],
      ["执法现场查在线监控设备，检查清单应包括哪些方面", "source:order19"],
      ["污染源自动监控设施现场检查的依据，不要只给我设备技术标准", "source:order19"],
      ["在线数据超标能不能直接作为处罚依据", "source:order19"],
      ["只有一张截图和在线数据，程序证据不全，结论怎么写稳妥", "source:order19"],
      ["先查企业 CEMS 离线时段，再判断需要哪些现场检查依据", "source:order19"],
      ["在线监控数据异常，能不能直接认定弄虚作假", "source:order19"],
      ["污染源自动监控管理职责清单包括哪些主体", "source:order28"],
      ["运维单位没维护到位，企业是不是就不用承担管理责任", "source:order28"],
      ["企业要拆在线设备，说先拆后备案行不行", "source:order28"],
      ["自动监控设备更换后备案和联网要求怎么找依据", "source:order28"],
      ["重污染天气绩效分级检查要点有哪些", "source:heavy"],
      ["查重污染过程小时浓度，同时说明预警材料不能替代标准限值", "source:heavy"]
    ] as const;

    for (const [question, expectedPageId] of cases) {
      const results = searchPages(dbPath, question, {
        limit: 5,
        authorityLayer: ["core", "method"],
        includeDrafts: false,
        includeSuperseded: false
      });
      expect(results[0]?.pageId, question).toBe(expectedPageId);
    }

    const legalRoleResults = searchPages(dbPath, "现场检查办法和自动监控管理办法职责怎么分？", {
      limit: 10,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    }).map((result) => result.pageId);
    expect(legalRoleResults).toContain("source:order19");
    expect(legalRoleResults).toContain("source:order28");
  });

  it("does not let draft replacement relations supersede current standards", async () => {
    const { wikiDir } = await createTempWorkspace();
    const standardPage = graphPage(
      "source:hj818",
      "2018_环境空气气态污染物_SO2、NO2、O3、CO_连续自动监测系统运行和质控技术规范_HJ818-2018",
      "sources/hj818.md"
    );
    const draftPage = graphPage("source:ozone-draft", "环境空气臭氧传递标准逐级校准技术规范_征求意见稿", "sources/ozone-draft.md");
    await writePage(
      wikiDir,
      standardPage.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "monitoring_method",
        standard_code: "HJ 818-2018"
      },
      "# HJ 818-2018\n\n现行环境空气气态污染物连续自动监测系统运行和质控技术规范。"
    );
    await writePage(
      wikiDir,
      draftPage.path,
      {
        authority_layer: "evolution",
        legal_status: "draft_consultation",
        document_role: "draft",
        standard_code: "HJ □□□-20□□",
        replaces: ["HJ 818-2018"]
      },
      "# 征求意见稿\n\n本草案发布后拟替代 HJ 818-2018 附录A内容。"
    );

    const report = await applyStandardRelationOverrides(wikiDir, [standardPage, draftPage], new Date("2026-05-27"));
    const parsed = matter(await fs.readFile(path.join(wikiDir, standardPage.path), "utf8"));

    expect(report.skippedReplacementPages).toBe(1);
    expect(parsed.data.legal_status).toBe("current_effective");
    expect(parsed.data.replaced_by).toBeUndefined();
  });

  it("marks official partial replacements as amended instead of fully superseded", async () => {
    const { wikiDir } = await createTempWorkspace();
    const standardPage = graphPage(
      "source:hj818",
      "2018_环境空气气态污染物_SO2、NO2、O3、CO_连续自动监测系统运行和质控技术规范_HJ818-2018",
      "sources/hj818.md"
    );
    const amendmentPage = graphPage("source:hj1319", "HJ 1319-2025 臭氧传递标准逐级校准技术规范", "sources/hj1319.md");
    await writePage(
      wikiDir,
      standardPage.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "monitoring_method",
        standard_code: "HJ 818-2018"
      },
      "# HJ 818-2018\n\n现行环境空气气态污染物连续自动监测系统运行和质控技术规范。"
    );
    await writePage(
      wikiDir,
      amendmentPage.path,
      {
        authority_layer: "method",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "HJ 1319-2025",
        effective_date: "2025-01-01",
        replaces: ["HJ 818-2018"]
      },
      "# HJ 1319-2025\n\n本标准替代 HJ 818-2018 附录A关于臭氧传递标准校准的内容。"
    );

    const report = await applyStandardRelationOverrides(wikiDir, [standardPage, amendmentPage], new Date("2026-05-27"));
    const parsed = matter(await fs.readFile(path.join(wikiDir, standardPage.path), "utf8"));

    expect(report.amendedPages).toBe(1);
    expect(parsed.data.legal_status).toBe("amended");
    expect(parsed.data.amended_by).toEqual(["HJ 1319-2025"]);
    expect(parsed.data.replaced_by).toBeUndefined();
  });

  it("does not apply official standard replacement relations to reports or background materials sharing a standard code", async () => {
    const { wikiDir } = await createTempWorkspace();
    const oldStandard = graphPage("source:gb3095-2012", "GB 3095-2012 环境空气质量标准", "sources/gb3095-2012.md");
    const monthlyReport = graphPage("source:monthly-2020-01", "2020年1月全国城市空气质量月报", "sources/monthly-2020-01.md");
    const newStandard = graphPage("source:gb3095-2026", "GB 3095-2026 环境空气质量标准", "sources/gb3095-2026.md");
    await writePage(
      wikiDir,
      oldStandard.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "GB 3095-2012"
      },
      "# GB 3095-2012\n\n环境空气质量标准。"
    );
    await writePage(
      wikiDir,
      monthlyReport.path,
      {
        authority_layer: "evidence",
        legal_status: "time_scoped_evidence",
        document_role: "statistics",
        standard_code: "GB 3095-2012"
      },
      "# 2020年1月全国城市空气质量月报\n\n本月报按当期环境空气评价口径统计城市空气质量。"
    );
    await writePage(
      wikiDir,
      newStandard.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "GB 3095-2026",
        effective_date: "2026-03-01",
        replaces: ["GB 3095-2012"]
      },
      "# GB 3095-2026\n\n本标准代替 GB 3095-2012。"
    );

    const report = await applyStandardRelationOverrides(wikiDir, [oldStandard, monthlyReport, newStandard], new Date("2026-05-27"));
    const oldFrontmatter = matter(await fs.readFile(path.join(wikiDir, oldStandard.path), "utf8")).data;
    const reportFrontmatter = matter(await fs.readFile(path.join(wikiDir, monthlyReport.path), "utf8")).data;

    expect(report.supersededPages).toBe(1);
    expect(report.skippedReplacementPages).toBeGreaterThanOrEqual(1);
    expect(oldFrontmatter.legal_status).toBe("superseded");
    expect(oldFrontmatter.replaced_by).toEqual(["GB 3095-2026"]);
    expect(reportFrontmatter.legal_status).toBe("time_scoped_evidence");
    expect(reportFrontmatter.replaced_by).toBeUndefined();
  });

  it("normalizes replacement metadata without turning reports, guides, or explanations into current execution standards", () => {
    const monthlyReport = normalizeEnvAirLegalStatus({
      title: "2020年1月全国城市空气质量月报",
      authorityLayer: "evidence",
      legalForce: "statistical",
      documentRole: "statistics",
      legalStatus: "superseded",
      replacedBy: ["GB 3095-2026"],
      asOfDate: "2026-05-27"
    });
    const guide = normalizeEnvAirLegalStatus({
      title: "臭氧污染防治技术指南",
      authorityLayer: "evidence",
      legalForce: "explanatory",
      documentRole: "technical_guide",
      legalStatus: "superseded",
      replacedBy: ["GB 3095-2026"],
      asOfDate: "2026-05-27"
    });
    const explanation = normalizeEnvAirLegalStatus({
      title: "环境空气质量标准编制说明",
      authorityLayer: "evolution",
      legalForce: "explanatory",
      documentRole: "compilation_explanation",
      legalStatus: "superseded",
      replacedBy: ["HJ □□□-20□□"],
      asOfDate: "2026-05-27"
    });
    const oldStandard = normalizeEnvAirLegalStatus({
      title: "GB 3095-2012 环境空气质量标准",
      authorityLayer: "core",
      legalForce: "mandatory",
      documentRole: "standard",
      legalStatus: "current_effective",
      replacedBy: ["GB 3095-2026"],
      asOfDate: "2026-05-27"
    });

    expect(monthlyReport.legalStatus).toBe("time_scoped_evidence");
    expect(guide.legalStatus).toBe("time_scoped_evidence");
    expect(explanation.legalStatus).toBe("explanation_only");
    expect(oldStandard.legalStatus).toBe("superseded");
  });

  it("focuses HTML table evidence when pollutant labels are OCR/LaTeX spaced", async () => {
    const { wikiDir, dbPath } = await createTempWorkspace();
    const standardPage = graphPage("source:gb3095-html", "中华人民共和国国家标准", "sources/gb3095-html.md");
    await writePage(
      wikiDir,
      standardPage.path,
      {
        authority_layer: "core",
        legal_status: "current_effective",
        document_role: "standard",
        standard_code: "GB 3095-2026",
        pollutants: ["PM2.5", "PM10", "SO2", "NO2", "CO"]
      },
      [
        "# 中华人民共和国国家标准",
        "",
        "## Source Excerpt",
        "",
        "<table>",
        "<tr><td>污染物项目</td><td>平均时间</td><td>一级</td><td>二级</td><td>单位</td></tr>",
        "<tr><td rowspan=2>$\\mathrm { P M } _ { 2 . 5 }$</td><td>年平均</td><td>15</td><td>25</td><td>μg/m3</td></tr>",
        "<tr><td>24小时平均</td><td>35</td><td>50</td><td>μg/m3</td></tr>",
        "<tr><td>$\\mathrm { S O } _ { 2 }$</td><td>1小时平均</td><td>150</td><td>150</td><td>μg/m3</td></tr>",
        "</table>"
      ].join("\n")
    );
    await rebuildSearchIndex(dbPath, [standardPage], wikiDir);

    const results = searchPages(dbPath, "PM2.5 24 小时平均二级限值是多少？", {
      limit: 5,
      authorityLayer: ["core", "method"],
      includeDrafts: false,
      includeSuperseded: false
    });

    expect(results[0]?.pageId).toBe("source:gb3095-html");
    expect(results[0]?.snippet).toContain("24小时平均");
    expect(results[0]?.snippet).toContain("50");
    expect(results.some((result) => result.retrievalStage === "structured_fact")).toBe(true);
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

# 环境空气污染公共知识库构建指南

适用项目：

- SwarmVault 源码：`D:\Github\swarmvault`
- 公共知识库原始资料：`D:\kb\env-public\raw`
- 建议 Vault 工作区：`D:\kb\env-public\vault`
- 目标 Agent：`D:\agent\deer-flow`
- 当前日期基准：2026-04-28

本文给出完整执行方案。第一目标是先把公共知识库建设成可用、可审计、可被 DeerFlow 通过 MCP 调用的专业知识库；第二目标是在 SwarmVault 源码中加入环境空气污染业务专用的 LLM 构建、跨文档综合、检索增强和问答提示词。

---

## 1. 对当前资料内容的实际分析

这次分析不是只看目录，而是用 `pdftotext` 抽取 PDF 前 2-3 页、读取 Markdown 和 docx 正文后做的启发式内容识别。命令如下：

```powershell
Get-ChildItem -Path D:\kb\env-public\raw -Recurse -File |
  Group-Object Extension |
  Sort-Object Count -Descending |
  Select-Object Count,Name

Get-ChildItem -Path D:\kb\env-public\raw -Recurse -File |
  Measure-Object -Property Length -Sum |
  Select-Object Count,Sum
```

当前资料规模：

| 项 | 数量 |
|---|---:|
| 总文件数 | 997 |
| 总大小 | 约 1.36 GB |
| PDF | 932 |
| Markdown | 43 |
| docx | 22 |

内容层面初步识别结果：

| 内容特征 | 估计数量 | 说明 |
|---|---:|---|
| 监测、采样、测定、质控、校准类 | 约 747 | 这是当前资料中最主要的内容群，说明知识库不能只做政策法规库，还必须强化方法学检索 |
| 环境空气质量、AQI、PM2.5、PM10、O3、SO2、NO2、CO | 约 401 | 与 DeerFlow 空气质量报告业务高度相关 |
| 排放标准、排放限值、污染源控制 | 约 340 | 需要和环境空气质量评价分开建模，避免把环境质量标准和排放标准混用 |
| 固定污染源、废气、烟气、无组织排放 | 约 313 | 可支撑污染源监管、排放标准、监测方法问题 |
| 排污许可、环评、自行监测 | 约 266 | 属于管理制度和项目业务交叉区 |
| VOCs、臭氧、ODS/HFCs | 约 214 / 40 | 臭氧污染过程分析、VOCs 治理、消耗臭氧层物质管理是重点专题 |
| 征求意见稿、编制说明、修改单、历史版本 | 约 300+ | 这类资料价值很高，但不能作为现行执行依据 |
| 公报、月报、年报、统计年报 | 约 89 | 只能作为统计背景和趋势证据，不应当当作标准条款 |
| 白皮书、蓝皮书、研究报告、论文 | 约 100+ | 适合解释机理、路径、背景，不应直接升格为法定依据 |

发现的关键问题：

1. 资料不是单一标准库，而是法规、标准、技术指南、编制说明、征求意见稿、统计资料、研究文献、国际参考混合体。
2. 很多文件正文中出现“征求意见稿”“编制说明”“发布稿”“代替”等状态信息，目录层级不能直接决定资料效力。
3. 现行、已发布但未实施、征求意见、废止/被代替、编制说明必须拆开处理。
4. 监测方法类文档数量很大，后续检索必须支持条款级、方法级、污染物级召回。
5. 至少以下文件文本抽取几乎为空，需要 OCR 或替换为可复制文本版本：

```text
D:\kb\env-public\raw\evidence\whitepapers_reports\ozone\《中国大气臭氧污染防治蓝皮书（2023 年）》执行摘要.pdf
D:\kb\env-public\raw\evidence\official_explanations\plans_actions\2023_空气质量持续改善行动计划.pdf
D:\kb\env-public\raw\core\technical_guides\vocs\2020_重点行业企业挥发性有机物现场检查指南_试行.pdf
```

结论：这套知识库必须采用“资料效力优先”的多视图架构。不能把所有资料等权摘要，也不能按每个文件机械生成概念页。应当让 LLM 先判定资料层级和适用边界，再跨文档综合生成专题页。

---

## 2. 目标知识库架构

建议把公共知识库做成五个视图，而不是五个物理目录：

| 视图 | 资料角色 | 典型问题 |
|---|---|---|
| 现行权威依据视图 | 法律、法规、现行有效标准、强制性要求、正式技术规范 | 现在应该按什么执行 |
| 方法技术视图 | 监测方法、质控、源解析、排放核算、治理技术、可行技术指南 | 怎么测、怎么算、怎么治理 |
| 证据解释视图 | 公报、年报、月报、白皮书、蓝皮书、官方解读、研究综述 | 为什么这么判断，背景是什么 |
| 演化追踪视图 | 历史版本、征求意见稿、编制说明、修改单、废止件 | 以前是什么，为什么改 |
| 地方适配视图 | 地方标准、地方办法、地方执行口径 | 某地区怎么落地 |

对 LLM 的核心要求：

1. 先判断资料效力，再提取内容。
2. 先识别现行依据，再引用解释性材料。
3. 征求意见稿只能用于“演化趋势/修订方向”，不能作为现行结论。
4. 研究论文只能用于“机理解释/证据支持”，不能当作监管依据。
5. 统计年报、公报只能作为“事实背景/历史趋势”，不能替代标准限值。
6. 地方标准仅在对应地区适用；没有地区限定时不得覆盖国家标准。
7. 涉及 2026 文件时，要用 `effective_date` 和当前日期 2026-04-28 判断是否已经实施，不能只看文件名。

---

## 3. 总体执行路线

分三轮做。

第一轮：最小可用公共知识库。

1. 用本地 SwarmVault 源码启动 CLI。
2. 新建 `D:\kb\env-public\vault` 工作区。
3. 配置 GLM-5。
4. 写环境空气污染专用 `swarmvault.schema.md`。
5. 注册 `D:\kb\env-public\raw` 为托管来源。
6. 先全量导入，完成基本 compile、lint、query、MCP。

第二轮：修改 SwarmVault 源码，提升为专家级综合 wiki。

1. 强制非代码资料完全走 LLM，不允许静默退回 heuristic。
2. 扩展 source analysis schema，抽取环境业务元数据。
3. 提高单文档分析上下文上限，适配 GLM-5 200k 窗口。
4. 新增跨文档专题综合 pass，生成 `wiki/insights/env/*.md`。
5. 优化 query_vault 内部提示词和检索路径。

第三轮：借鉴 sage-wiki 增强检索。

1. 增加 chunk 级 FTS。
2. 增加 chunk embedding。
3. 增加 query expansion：lex、vec、HyDE。
4. 增加 LLM rerank，并采用 retrieval score + rerank score 混合。
5. 增加环境业务元数据过滤。

---

## 4. 使用本地 SwarmVault 源码

不要用：

```powershell
npm install -g @swarmvaultai/cli
```

这个命令安装的是 npm 上发布的包，不是 `D:\Github\swarmvault` 本地源码。

建议用本地源码直接运行：

```powershell
cd D:\Github\swarmvault
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install
pnpm build
```

定义一个当前 PowerShell 会话里的本地命令别名：

```powershell
function sv {
  node D:\Github\swarmvault\packages\cli\dist\index.js @args
}
```

验证：

```powershell
sv --help
```

后续每次改源码后执行：

```powershell
cd D:\Github\swarmvault
pnpm build
```

然后继续用 `sv ...` 调用本地构建产物。

---

## 5. 创建公共知识库 Vault

不要直接把 `D:\kb\env-public\raw` 当作 Vault 根目录。原因是 SwarmVault 的工作区本身也会有 `raw/`、`wiki/`、`state/`，如果工作区根目录就是 `D:\kb\env-public`，容易把人工整理的 raw 和 SwarmVault 的内部原始存储混在一起。

建议：

```powershell
New-Item -ItemType Directory -Force D:\kb\env-public\vault
cd D:\kb\env-public\vault
sv init --profile reader,timeline
```

初始化后目录应类似：

```text
D:\kb\env-public\vault
  swarmvault.config.json
  swarmvault.schema.md
  raw\
  wiki\
  state\
  inbox\
```

把人工整理的资料作为外部托管来源注册：

```powershell
cd D:\kb\env-public\vault
sv source add D:\kb\env-public\raw --no-compile --no-brief --no-guide
```

说明：

- `source add` 会把来源注册到 `state/sources.json`。
- 以后更新 `D:\kb\env-public\raw` 后，用 `sv source reload --all` 重新同步。
- 首次不建议加 `--guide`，因为这是 997 个文件的公共知识库，不适合交互式逐批引导。
- `--guide` 可以后续用于少量高价值资料的专家复核，不适合作为第一轮全量导入策略。

---

## 6. 配置 GLM-5

在当前 PowerShell 会话设置 API Key：

```powershell
$env:JD_GLM_API_KEY = "你的京东云API Key"
```

长期使用建议写入用户环境变量：

```powershell
[Environment]::SetEnvironmentVariable("JD_GLM_API_KEY", "你的京东云API Key", "User")
```

编辑：

```text
D:\kb\env-public\vault\swarmvault.config.json
```

建议配置：

```json
{
  "workspace": {
    "rawDir": "raw",
    "wikiDir": "wiki",
    "stateDir": "state",
    "agentDir": "agent",
    "inboxDir": "inbox"
  },
  "providers": {
    "glm5-jd": {
      "type": "openai-compatible",
      "model": "glm-5",
      "baseUrl": "https://modelservice.jdcloud.com/coding/openai/v1",
      "apiKeyEnv": "JD_GLM_API_KEY",
      "apiStyle": "chat",
      "capabilities": ["chat", "structured"]
    },
    "local-embedding": {
      "type": "ollama",
      "model": "bge-m3",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "capabilities": ["embeddings", "local"]
    }
  },
  "tasks": {
    "compileProvider": "glm5-jd",
    "queryProvider": "glm5-jd",
    "lintProvider": "glm5-jd",
    "visionProvider": "glm5-jd",
    "embeddingProvider": "local-embedding"
  },
  "search": {
    "hybrid": true,
    "rerank": true
  },
  "agents": [],
  "viewer": {
    "port": 4768
  }
}
```

注意：

1. `model` 必须以京东云控制台实际模型 id 为准。如果京东云要求的模型名不是 `glm-5`，这里要替换。
2. GLM-5 用作 compile/query/rerank LLM。
3. embedding 不建议依赖 GLM-5，除非京东云同一 endpoint 明确支持 `/embeddings`。中文知识库建议本地用 `bge-m3` 或其他中文/多语 embedding。
4. 如果暂时没有本地 embedding，可以先移除 `local-embedding` 和 `embeddingProvider`，但后续检索效果会弱。

本地 embedding 准备：

```powershell
ollama pull bge-m3
```

---

## 7. 编写 swarmvault.schema.md

编辑：

```text
D:\kb\env-public\vault\swarmvault.schema.md
```

建议模板如下：

```markdown
# 环境空气污染公共知识库 Schema

你正在为服务生态环境部门的 Agent 构建环境空气污染业务知识库。
本知识库用于政策依据核查、空气质量评价、污染过程分析、技术方法选择、报告写作和专业问答。

## 总原则

1. 先判断资料效力，再提取内容。
2. 现行有效的法律、法规、标准、规范优先于解释性材料。
3. 征求意见稿、编制说明、历史版本、修改单不得作为现行执行依据，只能用于演化说明。
4. 公报、年报、月报、白皮书、研究报告、论文只能作为背景、证据或机理解释，不能替代标准条款。
5. 地方标准和地方办法只在对应行政区域适用；无地区限定时不得覆盖国家标准。
6. 文件名中出现年份不等于已经生效，必须识别发布日期、实施日期、废止/代替关系。
7. 当前日期基准为 2026-04-28；生效日期晚于该日期的文件应标记为 issued_not_yet_effective。

## 必须抽取的资料元数据

每个 source 都要尽量识别：

- `authority_layer`: core | method | evidence | evolution | local | international | project
- `legal_force`: mandatory | recommended | explanatory | statistical | research | draft | superseded | unknown
- `document_role`: law | regulation | policy | standard | monitoring_method | qa_qc | emission_standard | technical_guide | statistics | official_explanation | whitepaper | research_literature | draft | compilation_explanation | amendment | local_reference | international_reference
- `legal_status`: current_effective | issued_not_yet_effective | draft_consultation | superseded | amended | explanation_only | unknown
- `jurisdiction`: national | province | city | international | unknown
- `region`: 具体省市或国家
- `standard_code`: 例如 GB 3095-2026、HJ 633-2026
- `publish_date`
- `effective_date`
- `replaces`
- `replaced_by`
- `pollutants`: O3, PM2.5, PM10, SO2, NO2, CO, VOCs, NMHC, ODS, HFCs 等
- `business_topics`: air_quality_assessment, aqi, monitoring, qa_qc, source_apportionment, emission_control, vocs_ozone, mobile_source, stationary_source, permit, eia, heavy_pollution_weather

## 概念命名规则

概念必须是跨文档可复用的业务概念，不要把单个文件标题直接当概念。

推荐概念：

- 环境空气质量评价
- AQI/IAQI
- 臭氧 MDA8
- PM2.5 年均评价
- 监测点位布设
- 颗粒物自动监测质控
- 臭氧与 VOCs/NOx 协同控制
- 固定污染源废气监测
- VOCs 治理技术
- 重污染天气应急减排
- 移动源排放监管
- 地方大气污染物排放标准

避免概念：

- 某个文件完整标题
- 某个发布通知的流水号
- 没有业务复用价值的章节标题
- 只在单份资料出现且无法泛化的短语

## 回答和生成 wiki 的效力排序

当资料冲突时，按以下顺序处理：

1. 现行有效法律法规。
2. 现行有效国家标准、生态环境标准、行业规范。
3. 现行有效地方标准，只在对应地区适用。
4. 官方技术指南、技术规范、管理办法。
5. 官方解读、编制说明、修改单说明。
6. 公报、年报、月报等统计资料。
7. 白皮书、蓝皮书、研究报告。
8. 学术论文、国际参考。
9. 征求意见稿、历史版本、废止件。

必须明确说明资料边界：

- 如果依据来自征求意见稿，必须写明“非现行依据”。
- 如果依据来自研究文献，必须写明“研究证据/机理支持”。
- 如果依据来自地方文件，必须写明适用地区。
- 如果没有找到现行依据，必须明说，不得用解释性材料补位。

## 专题 wiki 页面要求

跨文档专题页应当像专家综述，不应像单文档摘要。

每个专题页建议包含：

1. 专家结论摘要。
2. 现行执行依据。
3. 适用范围和不适用范围。
4. 核心指标、方法或控制要求。
5. 与相关标准/指南的关系。
6. 历史演化和修订原因。
7. 地方差异。
8. 常见误用和风险提示。
9. 报告写作可采用的表达。
10. 引用来源清单。

所有实质性结论必须带 source id 或文件名依据。
```

---

## 8. 第一轮不改源码的执行命令

完成配置和 schema 后执行：

```powershell
cd D:\kb\env-public\vault
sv source list
```

如果托管来源已经注册，执行：

```powershell
sv source reload --all --no-guide
```

首次 compile：

```powershell
sv compile --max-tokens 200000
```

检查：

```powershell
Get-ChildItem .\state\manifests -Filter *.json | Measure-Object
Get-ChildItem .\wiki -Recurse -Filter *.md | Measure-Object
sv lint --deep
```

测试查询：

```powershell
sv query "现行环境空气质量标准、AQI技术规定和环境空气质量评价技术规范之间是什么关系？" --no-save

sv query "征求意见稿和编制说明能不能作为现行执法或报告评价依据？" --no-save

sv query "臭氧污染过程分析中，VOCs和NOx相关资料应如何作为机理证据使用？" --no-save
```

构建上下文包：

```powershell
sv context build "撰写某市臭氧污染过程分析报告，需要标准依据、评价口径、机理解释和治理建议" --target "臭氧 VOCs AQI HJ633 GB3095" --budget 12000 --format llms
```

第一轮预期效果：

- 能生成 source pages、concept/entity pages、graph、search index。
- 能通过 `query` 做基础问答。
- 能通过 context pack 给 Agent 提供证据包。
- 但概念页仍会偏模板化，跨文档专家综合能力不足。

要达到你要求的专家级有机整合，需要第二轮源码改造。

---

## 9. 源码改造目标

当前 SwarmVault 的主要短板：

1. `packages/engine/src/analysis.ts` 中的 LLM prompt 是通用 wiki prompt，且只截取约 18000 字符。
2. `SourceAnalysis` 只包含 title、summary、concepts、entities、claims、questions、tags，缺少环境业务元数据。
3. `buildAggregatePage` 是模板化渲染，不会让 LLM 跨文档写专家综述。
4. `query_vault` 内部目前直接使用 `searchPages` 基础 FTS，没有走 `searchVault` 的混合检索和 rerank。
5. 搜索索引是 page 级，不是 chunk 级；标准条款、监测方法、技术指南的细粒度召回会不足。

改造原则：

1. 不破坏原有 source page 和 graph。
2. 不急着新增 `PageKind = "topic"`，第一阶段用现有 `kind: insight`、`tier: semantic` 生成专题综合页，降低改动面。
3. 用 LLM 生成专题页正文，但保留 frontmatter、source ids、node ids、schema hash 等可追溯结构。
4. 让 DeerFlow 优先调用 query/context/memory，而不是直接读零散 source page。

---

## 10. 源码改造一：增加环境业务配置

修改：

```text
D:\Github\swarmvault\packages\engine\src\types.ts
```

在 `VaultConfig` 中增加：

```ts
domain?: {
  preset?: "env-air";
  strictLlm?: boolean;
  analysisMaxChars?: number;
  schemaMaxChars?: number;
  topicSynthesis?: {
    enabled?: boolean;
    maxInputChars?: number;
    minSourcesPerTopic?: number;
    outputDir?: string;
  };
  retrieval?: {
    queryExpansion?: boolean;
    chunkSearch?: boolean;
    chunkSize?: number;
    chunkOverlap?: number;
    rerankCandidates?: number;
  };
};
```

修改：

```text
D:\Github\swarmvault\packages\engine\src\config.ts
```

在 zod config schema 增加对应校验：

```ts
const domainConfigSchema = z.object({
  preset: z.enum(["env-air"]).optional(),
  strictLlm: z.boolean().optional(),
  analysisMaxChars: z.number().int().positive().optional(),
  schemaMaxChars: z.number().int().positive().optional(),
  topicSynthesis: z
    .object({
      enabled: z.boolean().optional(),
      maxInputChars: z.number().int().positive().optional(),
      minSourcesPerTopic: z.number().int().positive().optional(),
      outputDir: z.string().min(1).optional()
    })
    .optional(),
  retrieval: z
    .object({
      queryExpansion: z.boolean().optional(),
      chunkSearch: z.boolean().optional(),
      chunkSize: z.number().int().positive().optional(),
      chunkOverlap: z.number().int().nonnegative().optional(),
      rerankCandidates: z.number().int().positive().optional()
    })
    .optional()
});
```

并在主 config schema 中加入：

```ts
domain: domainConfigSchema.optional()
```

然后在 `D:\kb\env-public\vault\swarmvault.config.json` 增加：

```json
{
  "domain": {
    "preset": "env-air",
    "strictLlm": true,
    "analysisMaxChars": 160000,
    "schemaMaxChars": 24000,
    "topicSynthesis": {
      "enabled": true,
      "maxInputChars": 170000,
      "minSourcesPerTopic": 2,
      "outputDir": "insights/env"
    },
    "retrieval": {
      "queryExpansion": true,
      "chunkSearch": true,
      "chunkSize": 900,
      "chunkOverlap": 180,
      "rerankCandidates": 20
    }
  }
}
```

---

## 11. 源码改造二：新增环境业务提示词文件

新增：

```text
D:\Github\swarmvault\packages\engine\src\domain-prompts.ts
```

内容建议：

```ts
export function envSourceAnalysisSystem(schemaPath: string, schemaContent: string): string {
  return [
    "你是环境空气污染领域的知识库编译专家，服务对象是生态环境部门业务 Agent。",
    "你的任务不是创作，而是从资料中抽取可审计、可追溯、可分层的专业知识。",
    "",
    "必须先判断资料效力：现行有效、已发布未实施、征求意见稿、编制说明、历史版本、废止件、统计资料、研究文献、地方参考、国际参考。",
    "不得把征求意见稿、编制说明、白皮书、研究论文当作现行执行依据。",
    "如果资料是技术指南或推荐性方法，要明确它是方法参考还是强制要求。",
    "如果资料是地方文件，要明确适用地区。",
    "如果资料是统计公报、月报、年报，只能作为事实背景和趋势证据。",
    "",
    "抽取概念时只保留跨文档可复用的业务概念，不要把单个文件标题机械变成概念。",
    "抽取 claim 时要保留适用边界、效力状态和引用来源。",
    "",
    `Vault schema path: ${schemaPath}`,
    "",
    "Vault schema instructions:",
    schemaContent
  ].join("\n");
}

export function envTopicSynthesisSystem(schemaPath: string, schemaContent: string): string {
  return [
    "你是环境空气污染领域的资深专家，正在把多份资料综合成专家级 wiki 专题页。",
    "你必须按资料效力分层综合，而不是把所有材料等权汇总。",
    "",
    "权威优先级：",
    "1. 现行有效法律法规。",
    "2. 现行有效国家标准、生态环境标准、行业规范。",
    "3. 现行有效地方标准，仅限对应地区。",
    "4. 官方技术指南、技术规范、管理办法。",
    "5. 官方解读、编制说明、修改单说明。",
    "6. 公报、年报、月报等统计资料。",
    "7. 白皮书、蓝皮书、研究报告。",
    "8. 学术论文、国际参考。",
    "9. 征求意见稿、历史版本、废止件。",
    "",
    "专题页必须像专家综述，说明现行依据、适用边界、方法路径、演化关系、常见误用和报告写作建议。",
    "所有实质性结论必须引用 source id。没有依据时必须明说。",
    "",
    `Vault schema path: ${schemaPath}`,
    "",
    "Vault schema instructions:",
    schemaContent
  ].join("\n");
}

export function envQuerySystem(schemaPath: string, schemaContent: string, outputFormatInstruction: string): string {
  return [
    "你是面向生态环境部门的环境空气污染业务问答专家。",
    "只能基于提供的 wiki context、raw source material 和明确给出的 web evidence 回答。",
    "必须区分现行依据、技术指南、统计背景、研究证据、征求意见稿、历史版本和地方口径。",
    "当资料冲突时，优先采用现行有效的法律法规和标准。",
    "征求意见稿、编制说明、白皮书、论文不得作为现行执行依据。",
    "涉及地方文件时，必须说明地区适用范围。",
    "涉及监测数据、排名、超标天数、污染过程时，不得虚构数据，应提示需要调用环境数据 MCP。",
    "回答中尽量引用 source id、页面 id 或标准号。",
    outputFormatInstruction,
    "",
    `Vault schema path: ${schemaPath}`,
    "",
    "Vault schema instructions:",
    schemaContent
  ].join("\n");
}

export const envQueryExpansionSystem = [
  "你是环境空气污染知识库检索改写器。",
  "请为用户问题生成检索变体。",
  "lex 用中文专业关键词和标准号改写，适合全文检索。",
  "vec 用自然语言扩展语义，适合向量检索。",
  "hyde 写一句可能答案，用于 HyDE embedding。",
  "只返回 JSON。"
].join("\n");

export const envRerankSystem = [
  "你是环境空气污染知识库检索重排器。",
  "根据用户问题判断候选片段相关性。",
  "优先现行有效依据，其次技术指南，再其次解释材料和研究证据。",
  "征求意见稿、历史版本只有在问题涉及演化或修订时才应高分。",
  "只返回 JSON。"
].join("\n");
```

---

## 12. 源码改造三：扩展 SourceAnalysis 元数据

修改：

```text
D:\Github\swarmvault\packages\engine\src\types.ts
```

增加：

```ts
export interface EnvSourceMetadata {
  authorityLayer?: string;
  legalForce?: string;
  documentRole?: string;
  legalStatus?: string;
  jurisdiction?: string;
  region?: string;
  standardCode?: string;
  publishDate?: string;
  effectiveDate?: string;
  replaces?: string[];
  replacedBy?: string[];
  pollutants?: string[];
  businessTopics?: string[];
  useFor?: string[];
  doNotUseFor?: string[];
}
```

在 `SourceClaim` 中可选增加：

```ts
authorityLayer?: string;
legalStatus?: string;
businessTopic?: string;
```

在 `SourceAnalysis` 中增加：

```ts
domain?: EnvSourceMetadata;
```

修改：

```text
D:\Github\swarmvault\packages\engine\src\analysis.ts
```

扩展 `sourceAnalysisSchema`：

```ts
domain: z
  .object({
    authorityLayer: z.string().optional(),
    legalForce: z.string().optional(),
    documentRole: z.string().optional(),
    legalStatus: z.string().optional(),
    jurisdiction: z.string().optional(),
    region: z.string().optional(),
    standardCode: z.string().optional(),
    publishDate: z.string().optional(),
    effectiveDate: z.string().optional(),
    replaces: z.array(z.string()).default([]),
    replacedBy: z.array(z.string()).default([]),
    pollutants: z.array(z.string()).default([]),
    businessTopics: z.array(z.string()).default([]),
    useFor: z.array(z.string()).default([]),
    doNotUseFor: z.array(z.string()).default([])
  })
  .optional()
```

把 `ANALYSIS_FORMAT_VERSION` 从当前值加 1，例如：

```ts
const ANALYSIS_FORMAT_VERSION = 9;
```

这样会强制重新分析旧缓存。

修改 `providerAnalysis` 签名：

```ts
async function providerAnalysis(
  manifest: SourceManifest,
  text: string,
  provider: ProviderAdapter,
  schema: VaultSchema,
  rootDir: string
): Promise<SourceAnalysis>
```

在函数内部读取配置：

```ts
const { config } = await loadVaultConfig(rootDir);
const schemaMaxChars = config.domain?.schemaMaxChars ?? 6000;
const analysisMaxChars = config.domain?.analysisMaxChars ?? 18000;
const schemaText = truncate(schema.content, schemaMaxChars);
```

如果 `config.domain?.preset === "env-air"`，使用 `envSourceAnalysisSystem`：

```ts
const system =
  config.domain?.preset === "env-air"
    ? envSourceAnalysisSystem(schema.path, schemaText)
    : [
        "You are compiling a durable markdown wiki and graph. Prefer grounded synthesis over creativity.",
        "",
        "Follow the vault schema when choosing titles, categories, relationships, and summaries.",
        "",
        `Vault schema path: ${schema.path}`,
        "",
        "Vault schema instructions:",
        schemaText
      ].join("\n");
```

把 prompt 中的截断从：

```ts
truncate(text, 18000)
```

改为：

```ts
truncate(text, analysisMaxChars)
```

返回时加入：

```ts
domain: parsed.domain,
```

在 `analyzeSource` 中调用改为：

```ts
analysis = await providerAnalysis(manifest, content, provider, schema, paths.rootDir);
```

强制 LLM，不允许静默退回 heuristic：

```ts
const { config } = await loadVaultConfig(paths.rootDir);
const strictLlm = config.domain?.strictLlm === true;

if (provider.type === "heuristic" && strictLlm && manifest.sourceKind !== "code") {
  throw new Error("domain.strictLlm is enabled, but compileProvider is heuristic.");
}
```

在 catch 中：

```ts
} catch (error) {
  if (strictLlm) {
    throw error;
  }
  analysis = heuristicAnalysis(manifest, content, schema.hash);
}
```

---

## 13. 源码改造四：source page 展示业务元数据

修改：

```text
D:\Github\swarmvault\packages\engine\src\markdown.ts
```

在 `buildSourcePage` 的正文中，`Summary` 后增加 `Domain Metadata` 区块。

建议生成：

```ts
function renderDomainMetadata(analysis: SourceAnalysis): string[] {
  const domain = analysis.domain;
  if (!domain) return [];
  const row = (label: string, value: unknown) => {
    if (Array.isArray(value)) return value.length ? `| ${label} | ${value.join(", ")} |` : "";
    return value ? `| ${label} | ${String(value)} |` : "";
  };
  return [
    "## Domain Metadata",
    "",
    "| Field | Value |",
    "|---|---|",
    row("authority_layer", domain.authorityLayer),
    row("legal_force", domain.legalForce),
    row("document_role", domain.documentRole),
    row("legal_status", domain.legalStatus),
    row("jurisdiction", domain.jurisdiction),
    row("region", domain.region),
    row("standard_code", domain.standardCode),
    row("publish_date", domain.publishDate),
    row("effective_date", domain.effectiveDate),
    row("replaces", domain.replaces),
    row("replaced_by", domain.replacedBy),
    row("pollutants", domain.pollutants),
    row("business_topics", domain.businessTopics),
    row("use_for", domain.useFor),
    row("do_not_use_for", domain.doNotUseFor),
    ""
  ].filter(Boolean);
}
```

同时在 source page frontmatter 加入扁平字段，方便后续搜索过滤：

```ts
...(analysis.domain?.authorityLayer ? { authority_layer: analysis.domain.authorityLayer } : {}),
...(analysis.domain?.legalForce ? { legal_force: analysis.domain.legalForce } : {}),
...(analysis.domain?.documentRole ? { document_role: analysis.domain.documentRole } : {}),
...(analysis.domain?.legalStatus ? { legal_status: analysis.domain.legalStatus } : {}),
...(analysis.domain?.jurisdiction ? { jurisdiction: analysis.domain.jurisdiction } : {}),
...(analysis.domain?.region ? { region: analysis.domain.region } : {}),
...(analysis.domain?.standardCode ? { standard_code: analysis.domain.standardCode } : {}),
...(analysis.domain?.pollutants?.length ? { pollutants: analysis.domain.pollutants } : {}),
...(analysis.domain?.businessTopics?.length ? { business_topics: analysis.domain.businessTopics } : {})
```

---

## 14. 源码改造五：新增跨文档专题综合

新增：

```text
D:\Github\swarmvault\packages\engine\src\domain-synthesis.ts
```

目标：根据 `SourceAnalysis.domain.businessTopics`、标准号、污染物、资料效力，把多份相关资料综合成专家级专题页，写入：

```text
D:\kb\env-public\vault\wiki\insights\env\<topic>.md
```

不要新增 `PageKind`。用已有：

```yaml
kind: insight
tier: semantic
managed_by: system
```

建议专题种子：

```ts
const ENV_TOPIC_SEEDS = [
  {
    id: "ambient-air-quality-assessment",
    title: "环境空气质量评价体系",
    match: ["air_quality_assessment", "aqi", "ambient_air_quality"]
  },
  {
    id: "aqi-iaqi-and-mda8",
    title: "AQI、IAQI 与臭氧 MDA8 评价口径",
    match: ["aqi", "O3", "ozone", "ambient_air_quality"]
  },
  {
    id: "monitoring-network-and-site-siting",
    title: "环境空气监测点位布设与监测网络",
    match: ["monitoring", "site_siting", "ambient_air_quality"]
  },
  {
    id: "automatic-monitoring-qaqc",
    title: "环境空气自动监测运行维护与质量控制",
    match: ["monitoring", "qa_qc"]
  },
  {
    id: "ozone-vocs-nox-control",
    title: "臭氧污染与 VOCs/NOx 协同控制",
    match: ["vocs_ozone", "O3", "VOCs", "NOx"]
  },
  {
    id: "source-apportionment",
    title: "颗粒物和臭氧污染来源解析方法",
    match: ["source_apportionment", "PMF", "CMB"]
  },
  {
    id: "stationary-source-monitoring",
    title: "固定污染源废气监测与排放监管",
    match: ["stationary_source", "monitoring", "emission_standard"]
  },
  {
    id: "mobile-source-management",
    title: "移动源排放监管与机动车环境管理",
    match: ["mobile_source"]
  },
  {
    id: "heavy-pollution-weather-response",
    title: "重污染天气应急响应与减排措施",
    match: ["heavy_pollution_weather"]
  },
  {
    id: "local-standards-adaptation",
    title: "地方大气标准和地方执行口径适配",
    match: ["local_reference"]
  }
];
```

每个 source 进入专题前先做 evidence packet：

```ts
type EnvEvidencePacket = {
  sourceId: string;
  title: string;
  authorityLayer?: string;
  legalForce?: string;
  documentRole?: string;
  legalStatus?: string;
  jurisdiction?: string;
  region?: string;
  standardCode?: string;
  publishDate?: string;
  effectiveDate?: string;
  pollutants?: string[];
  businessTopics?: string[];
  summary: string;
  claims: Array<{
    text: string;
    citation: string;
    confidence: number;
    status: string;
  }>;
  excerpt: string;
};
```

排序规则：

```ts
function authorityRank(packet: EnvEvidencePacket): number {
  if (packet.legalStatus === "current_effective" && packet.authorityLayer === "core") return 100;
  if (packet.legalStatus === "issued_not_yet_effective" && packet.authorityLayer === "core") return 88;
  if (packet.documentRole === "technical_guide") return 76;
  if (packet.documentRole === "official_explanation") return 65;
  if (packet.documentRole === "statistics") return 55;
  if (packet.documentRole === "whitepaper") return 45;
  if (packet.documentRole === "research_literature") return 40;
  if (packet.legalStatus === "draft_consultation") return 28;
  if (packet.legalStatus === "superseded") return 20;
  return 35;
}
```

专题页 prompt：

```ts
const prompt = [
  `专题：${topic.title}`,
  "",
  "请基于下列 evidence packets 生成专家级 wiki 专题页。",
  "必须综合多份资料，不能逐份资料机械摘要。",
  "必须区分现行依据、技术指南、解释证据、统计资料、研究文献、征求意见稿、历史版本。",
  "所有实质性结论必须引用 source id。",
  "",
  "输出结构：",
  "1. # 专题标题",
  "2. ## 专家结论摘要",
  "3. ## 现行执行依据",
  "4. ## 适用范围与边界",
  "5. ## 核心方法/指标/控制要求",
  "6. ## 证据解释与业务理解",
  "7. ## 历史演化",
  "8. ## 地方适配",
  "9. ## 常见误用",
  "10. ## 报告写作建议",
  "11. ## 引用来源",
  "",
  JSON.stringify(packets, null, 2)
].join("\n");
```

输出 frontmatter：

```yaml
page_id: insight:env:<topic-id>
kind: insight
tier: semantic
title: <topic title>
tags:
  - env-air
  - domain-synthesis
  - <topic-id>
source_ids: [...]
node_ids: [...]
freshness: fresh
status: active
confidence: 0.9
managed_by: system
```

在 `compileVault` 的页面同步流程中接入。

修改：

```text
D:\Github\swarmvault\packages\engine\src\vault.ts
```

在 `syncWikiFromAnalyses` 中，source pages 和 aggregate pages 构建完成后、index pages 构建前，加入：

```ts
if (config.domain?.preset === "env-air" && config.domain?.topicSynthesis?.enabled !== false) {
  const envTopicRecords = await buildEnvTopicPages({
    rootDir,
    paths,
    manifests: input.manifests,
    analyses: input.analyses,
    schemas: input.schemas,
    provider: await getProviderForTask(rootDir, "compileProvider"),
    outputDir: config.domain?.topicSynthesis?.outputDir ?? "insights/env",
    maxInputChars: config.domain?.topicSynthesis?.maxInputChars ?? 170000,
    minSourcesPerTopic: config.domain?.topicSynthesis?.minSourcesPerTopic ?? 2
  });
  records.push(...envTopicRecords);
}
```

注意：`syncWikiFromAnalyses` 当前可能没有 `rootDir` 参数，可用 `paths.rootDir`。

---

## 15. 源码改造六：优化 query_vault 的内部问答提示词

修改：

```text
D:\Github\swarmvault\packages\engine\src\vault.ts
```

当前 `executeQuery` 中使用：

```ts
const searchResults = searchPages(paths.searchDbPath, question, 5);
```

改为：

```ts
const searchResults = await searchVault(rootDir, question, 8);
```

这样 `query_vault` 才会走 SwarmVault 已有的 hybrid search 和 rerank。

然后把问答 system prompt 从通用：

```ts
"Answer using the provided context. Prefer raw source material over wiki summaries when they differ..."
```

改成环境业务 prompt：

```ts
const system =
  config.domain?.preset === "env-air"
    ? envQuerySystem(querySchema.path, querySchema.content, outputFormatInstruction(format))
    : buildSchemaPrompt(
        querySchema,
        [
          "Answer using the provided context. Prefer raw source material over wiki summaries when they differ. Cite source IDs and web URLs when they appear in the evidence.",
          outputFormatInstruction(format)
        ].join(" ")
      );
```

并把 `provider.generateText` 改为：

```ts
const response = await provider.generateText({
  system,
  prompt: `Question: ${question}\n\n${context}`
});
```

这样外部 Agent 调用 MCP 的 `query_vault` 时，内部 LLM 也会按环保业务规则回答。

---

## 16. 源码改造七：借鉴 sage-wiki 增强检索

参考：

```text
D:\Github\sage-wiki\internal\search\pipeline.go
D:\Github\sage-wiki\internal\search\expand.go
D:\Github\sage-wiki\internal\search\rerank.go
```

sage-wiki 的关键机制：

1. strong signal：BM25 结果足够强时跳过 query expansion。
2. query expansion：生成 `lex`、`vec`、`hyde`。
3. chunk-level BM25。
4. chunk-level vector search。
5. RRF 融合。
6. 按 doc 去重。
7. LLM rerank。
8. retrieval score 和 rerank score 加权融合。

SwarmVault 当前已经有 page 级 FTS、page embedding、RRF 和 LLM rerank，但没有 chunk 级检索和 query expansion。

### 16.1 增加 chunk 索引

修改：

```text
D:\Github\swarmvault\packages\engine\src\search.ts
```

在 SQLite schema 中增加：

```sql
CREATE TABLE IF NOT EXISTS page_chunks (
  chunk_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  body TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  authority_layer TEXT NOT NULL,
  legal_status TEXT NOT NULL,
  document_role TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  pollutants TEXT NOT NULL,
  business_topics TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(
  title,
  heading,
  body,
  content='page_chunks',
  content_rowid='rowid'
);
```

新增 chunk 函数：

```ts
function chunkText(text: string, size = 900, overlap = 180): string[] {
  const tokens = tokenize(text);
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const next = tokens.slice(cursor, cursor + size).join(" ");
    if (next.trim()) chunks.push(next);
    cursor += Math.max(1, size - overlap);
  }
  return chunks;
}
```

在 `rebuildSearchIndex` 中写入 chunks。

### 16.2 增加 query expansion

新增：

```text
D:\Github\swarmvault\packages\engine\src\query-expansion.ts
```

接口：

```ts
export interface ExpandedQuery {
  original: string;
  lex: string[];
  vec: string[];
  hyde?: string;
}
```

用 `envQueryExpansionSystem` 调 GLM-5，返回：

```json
{
  "lex": ["环境空气质量标准 AQI HJ633 HJ663", "GB3095 臭氧 MDA8 二级标准"],
  "vec": ["用户想知道环境空气质量评价中标准限值、AQI计算和评价规范的衔接关系"],
  "hyde": "环境空气质量评价通常以 GB 3095 的污染物限值为基础，并通过 HJ 633 计算 AQI，通过 HJ 663 规范评价方法。"
}
```

### 16.3 增加环境业务 rerank

当前 `rerankSearchResults` 只让 LLM 排序索引。建议改成打分：

```json
[
  {"id": 0, "score": 9, "reason": "现行环境空气质量标准，直接回答评价依据"},
  {"id": 1, "score": 6, "reason": "编制说明，只能解释背景"}
]
```

评分规则写入 `envRerankSystem`：

1. 问现行依据：现行法律/标准高分，征求意见稿低分。
2. 问演化：历史版本、编制说明、修改单高分。
3. 问机理：技术指南、研究综述、蓝皮书可高分。
4. 问地方：地方标准和地方政策高分，但必须匹配地区。

### 16.4 searchVault 改造后的流程

修改：

```text
D:\Github\swarmvault\packages\engine\src\vault.ts
```

`searchVault` 目标流程：

```text
question
  -> strong signal check
  -> optional query expansion
  -> page FTS
  -> chunk FTS
  -> page semantic
  -> chunk semantic
  -> RRF merge
  -> metadata-aware boost
  -> LLM rerank
  -> top results
```

环境业务 boost 建议：

```ts
function envAuthorityBoost(result: SearchResult): number {
  if (result.legalStatus === "current_effective" && result.authorityLayer === "core") return 0.20;
  if (result.legalStatus === "issued_not_yet_effective") return 0.08;
  if (result.legalStatus === "draft_consultation") return -0.12;
  if (result.legalStatus === "superseded") return -0.18;
  if (result.documentRole === "research_literature") return -0.05;
  return 0;
}
```

---

## 17. DeerFlow MCP 接入

创建 MCP 启动脚本：

```powershell
@'
Set-Location D:\kb\env-public\vault
node D:\Github\swarmvault\packages\cli\dist\index.js mcp
'@ | Set-Content -Encoding UTF8 D:\kb\env-public\run-env-kb-mcp.ps1
```

编辑：

```text
D:\agent\deer-flow\extensions_config.json
```

增加：

```json
{
  "mcpServers": {
    "env-data": {
      "enabled": true,
      "type": "http",
      "url": "http://host.docker.internal:8808/mcp",
      "description": "Environment data MCP service (internal)"
    },
    "env-kb": {
      "enabled": true,
      "type": "stdio",
      "command": "powershell",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "D:\\kb\\env-public\\run-env-kb-mcp.ps1"
      ],
      "description": "Environmental air pollution public knowledge base powered by SwarmVault"
    }
  }
}
```

编辑：

```text
D:\agent\deer-flow\config.yaml
```

在 `tool_search.capability_domains` 下增加：

```yaml
    env-kb:
      activator_skills:
        - air-quality-knowledge
        - environment-data-analysis
        - writing-reports
        - verifying-analysis-quality
      tool_prefixes:
        - env-kb_
      release_on_route_switch: true
      release_on_downstream_skills:
        - creating-charts
        - docx-package-report
        - docx-edit-docx
        - ppt-generation
      idle_model_call_gap: 4
      idle_message_gap: 8
```

说明：

- 环境数据 MCP 负责“监测数据、统计计算、过程分析”。
- 环境知识库 MCP 负责“依据、口径、方法、解释、报告表达”。
- DeerFlow 复杂报告任务中，两者应组合使用。

---

## 18. DeerFlow skill 调整

编辑：

```text
D:\agent\deer-flow\skills\custom\air-quality-knowledge\SKILL.md
```

建议在“方法”下增加：

```markdown
## 知识库 MCP 使用规则

当问题涉及以下任一内容时，必须优先调用环境知识库 MCP：

1. 法律、法规、标准、技术规范、技术指南。
2. AQI、IAQI、MDA8、综合指数、评价口径。
3. 臭氧、VOCs、NOx、PM2.5、PM10 的机理解释。
4. 报告写作中的依据表述和专业措辞。
5. 地方标准、地方执行口径。
6. 历史版本、征求意见稿、编制说明、修改单。

工具选择：

- 简单事实核对：先用 `env-kb_query_vault`。
- 需要看来源：用 `env-kb_search_pages` 后接 `env-kb_read_page`。
- 复杂报告/研究任务：先用 `env-kb_build_context_pack`。
- 长任务需要沉淀：用 `env-kb_start_memory_task`，过程中用 `env-kb_update_memory_task`，结束用 `env-kb_finish_memory_task`。

回答约束：

1. 必须区分现行依据、技术指南、解释材料、研究证据和历史资料。
2. 不得把征求意见稿、编制说明、研究论文当作现行执行依据。
3. 涉及监测数据和过程分析时，知识库只提供口径和方法，具体数据必须调用 env-data MCP。
4. 形成报告结论时，关键依据应保留 source id 或标准号。
```

可在 `environment-data-analysis` skill 的 evidence 阶段补充：

```markdown
在开始正式报告研究时，如果任务包含标准依据、评价口径、污染机理或治理建议，应先调用 `env-kb_build_context_pack` 获取知识依据包，再调用 env-data 工具获取监测数据证据。
```

---

## 19. 构建和验证命令

每次改源码后：

```powershell
cd D:\Github\swarmvault
pnpm build
```

回到 vault：

```powershell
cd D:\kb\env-public\vault
sv compile --max-tokens 200000
```

如果修改了 analysis schema 或 prompt，建议删除旧 analysis 缓存后重跑：

```powershell
Remove-Item .\state\analyses\*.json -Force
sv compile --max-tokens 200000
```

如果只改了 query prompt 或 search：

```powershell
sv compile --max-tokens 200000
sv query "环境空气质量标准和AQI技术规定如何衔接？" --no-save
```

检索验证：

```powershell
sv query "GB3095、HJ633、HJ663、AQI 和 MDA8 的关系是什么？" --no-save
sv graph query "臭氧 VOCs NOx 协同控制"
sv context build "臭氧污染过程分析报告依据包" --target "臭氧 VOCs NOx HJ633 GB3095" --budget 16000 --format llms
```

MCP 验证：

```powershell
cd D:\kb\env-public\vault
node D:\Github\swarmvault\packages\cli\dist\index.js mcp
```

DeerFlow 侧重启服务后，在对话中测试：

```text
请查询现行环境空气质量评价中 GB3095、HJ633 和 HJ663 的关系，并说明哪些资料不能作为现行依据。
```

预期 Agent 行为：

1. 触发 `air-quality-knowledge`。
2. 通过 `tool_search` 暴露 `env-kb_` 工具。
3. 调用 `env-kb_query_vault` 或 `env-kb_build_context_pack`。
4. 回答中区分现行依据、技术规范、历史/征求意见资料。

---

## 20. 验收标准

公共知识库第一阶段合格标准：

1. `state/manifests` 数量接近 997，低于该数量时要解释跳过原因。
2. `wiki/sources` 能看到每份资料的 source page。
3. `wiki/insights/env` 生成 8-15 个专家专题页。
4. 专题页不是逐文件摘要，而是有“现行依据、适用边界、演化、误用风险、报告建议”的综合结构。
5. `query_vault` 能正确区分：
   - 现行标准 vs 征求意见稿。
   - 标准条款 vs 编制说明。
   - 技术指南 vs 强制要求。
   - 研究证据 vs 执行依据。
   - 国家标准 vs 地方标准。
6. DeerFlow 能通过 MCP 使用知识库，并能和 env-data MCP 分工。
7. 对以下测试问题回答稳定：

```text
1. 环境空气质量标准、AQI技术规定、环境空气质量评价技术规范分别解决什么问题？
2. 臭氧 MDA8 在报告中应该如何表述？
3. 编制说明和征求意见稿能否作为现行依据？
4. VOCs 治理技术指南在臭氧污染分析中应如何使用？
5. 地方大气污染物排放标准和国家标准冲突时如何处理？
6. 统计公报、蓝皮书、研究论文分别适合支撑什么类型的结论？
```

---

## 21. 风险和注意事项

1. GLM-5 200k 是上下文能力，不等于每次都应塞满 200k。专题综合建议控制在 120k-170k 字符输入，给模型留出输出和推理空间。
2. PDF 抽取质量决定知识库上限。文本为空或乱码的文件必须 OCR。
3. 不建议第一轮就大规模移动 `D:\kb\env-public\raw` 目录。先用元数据和 LLM 判定层级，等知识库稳定后再整理物理目录。
4. 不要让 Agent 直接把 `evidence` 资料当结论依据。必须让 query prompt 和 skill 都强调效力分层。
5. 概念页可以保留，但 DeerFlow 应优先使用 `wiki/insights/env` 专题页、source page 和 context pack。
6. 长期维护时，`source reload --all` 负责同步新增资料；schema 或 prompt 大改时才清理 `state/analyses` 重新分析。
7. 后续项目私有报告不要混入公共 vault。建议另建租户/项目 vault，或者先放入独立 project schema，避免公共依据被客户报告污染。

---

## 22. 推荐最终架构

最终建议形态：

```text
D:\kb\env-public\
  raw\                         # 人工整理的公共原始资料，不让 SwarmVault 直接写入
  registry\
    documents.csv              # 后续补充，记录权威层级、状态、地区、标准号、生效日期
  vault\
    swarmvault.config.json
    swarmvault.schema.md
    raw\                       # SwarmVault 同步后的内部原始存储
    state\
      manifests\
      analyses\
      graph.json
      search.sqlite
      context-packs\
      memory\
    wiki\
      sources\
      concepts\
      entities\
      insights\
        env\                   # 专家综合专题页
      context\
      memory\
```

DeerFlow 调用关系：

```text
用户任务
  -> DeerFlow skill 路由
  -> env-kb MCP 查询依据、方法、解释、历史演化
  -> env-data MCP 查询监测数据和计算结果
  -> 写作/制图/报告技能生成成果
  -> env-kb memory 可选记录本次报告依据和结论
```

这套结构能把公共知识库从“文件检索库”提升为“有资料效力判断的环境空气污染专家知识底座”。

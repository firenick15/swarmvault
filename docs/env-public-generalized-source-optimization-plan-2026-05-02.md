# 环境空气公共知识库源码优化方案

日期：2026-05-02

适用项目：`D:\Github\swarmvault`

适用知识库：`D:\kb\env-public`

## 1. 结论

本轮完整测试表明，当前知识库主体可用，基础构建链路、检索链路、权威依据问答、实时数据路由和图谱构建均已跑通。但仍存在几类需要继续做源码级优化的问题：

1. 部分页面的 frontmatter 已能识别 `superseded`、`draft` 等状态，但 LLM 生成的摘要、实体、概念和 claims 中仍可能出现“现行”“执行依据”等未加限定的表述，导致 deep lint 报出状态矛盾。
2. `graph query` 对中文长查询、统计报告类查询和业务意图的排序能力不足，容易被通用实体或技术概念稀释，导致相关报告没有进入前排。
3. `deep lint --deep` 中 `ascii_slug_collision_risk` 仍沿用旧的 ASCII slug 判断逻辑，与当前中文知识标签路径机制不一致，造成大量误报。
4. 少量空提取源、结构化回答 fallback、跨平台测试和格式化问题仍会影响长期维护、CI 稳定性和质量评估可信度。

后续修改应避免针对 `HJ 633`、某个月报、某个标准编号或某条固定问题做枚举式补丁。应把问题抽象为通用能力：

- 权威状态约束和正文一致性校正；
- 面向领域 profile 的检索和图谱种子排序；
- 与实际路径生成规则一致的质量检查；
- 可诊断、可回归测试、可在其他环保资料上复用的构建质量机制。

## 2. 本轮测试暴露的问题

### 2.1 构建和索引状态

当前 vault 可正常构建和检索：

- `retrieval status --json` 显示索引非 stale，schema 正常。
- `retrieval doctor --json` 返回 `ok=true`。
- 图谱规模正常，约 7k 页面、3.2w 边、44 个 community。
- 常规问答对权威限值、月报不能作为执法依据、实时数据需要 MCP 等问题回答方向正确。

这说明当前优化不应推翻整体架构，而应围绕质量校正、排序、lint 和工程稳定性做增强。

### 2.2 deep lint 问题

`deep lint --deep` 主要问题包括：

- 大量 `ascii_slug_collision_risk`；
- 少量 `contradiction_candidate`；
- 少量 `empty_extraction_source`；
- 若干 `orphan_page`、`standard_code_missing`、`amendment_without_role`、`noisy_promoted_page`。

其中 `ascii_slug_collision_risk` 的数量异常高，根因不是知识库真的存在大量路径冲突，而是 lint 仍使用旧的 `slugify(title)` 逻辑判断中文标题。当前知识页路径已经采用知识标签 slug 机制，中文标题可以生成较稳定的路径，不应再按旧 ASCII 退化结果统一判定为 `item`。

`contradiction_candidate` 的根因更重要：一些历史标准、废止件、草案或说明性文件在结构化元数据里已被识别为非现行或非强制依据，但正文摘要和实体说明中仍保留了 LLM 从原文或标题中抽取出的“现行”“依据”等强表述。这会影响 agent 的安全性。

### 2.3 graph query 问题

实测发现：

- `环境空气质量评价` 查询可用，但结果偏宽。
- `GB3095 PM2.5 24小时平均` 能召回相关节点，但前排混入采样器、监测方法等技术节点。
- `全国城市空气质量月度报告 339个城市` 排序明显异常，前排被 OBD、重型车、清洁生产等无关内容占据。

这说明 `graph query` 当前主要依赖通用字符串匹配、语义检索结果和图邻接扩展，缺少对领域 profile、文档角色、统计报告意图、权威状态、污染物、地区和时间范围的统一排序机制。

### 2.4 回答质量问题

实际问答中，专业结论大体正确，但仍有两个质量风险：

- 当证据不足时，回答能保守处理，但有时进入 `structured_answer_incomplete_fallback`，说明结构化回答模板和检索上下文之间仍不完全匹配。
- 对“编制说明、技术指南、月报、公报、研究报告是否可作为执行依据”这类问题，结论正确，但需要更稳定地产生“资料性质、可用范围、不可替代的正式依据、下一步应查标准或实时数据”的结构。

### 2.5 工程稳定性问题

测试层面有两个非业务但必须处理的问题：

- `obsidian-plugin` 路径测试在 Windows 下失败，原因是测试 mock 使用 POSIX 路径，而源码通过 Node `path.join()` 生成 Windows 分隔符。
- `pnpm check` 因 CRLF/LF 不一致失败，仓库缺少统一的 `.gitattributes` 或 `.editorconfig`。

这类问题会降低 CI 可信度，后续应修复。

## 3. 设计原则

### 3.1 禁止个例补丁

不得在源码中写入类似以下逻辑：

- 如果标题包含 `HJ 633` 就强制怎样；
- 如果文件名包含某个月报就提高排序；
- 如果问题包含固定句子就返回固定答案；
- 如果某个标准编号出现就特殊处理。

允许使用通用模式：

- 标准编号、年份、状态词、实施日期、代替关系；
- 文档角色：标准、规范、技术指南、编制说明、征求意见稿、公报、月报、年报、研究报告；
- 证据角色：权威依据、背景解释、统计证据、方法支撑、历史演化、地方适配；
- 查询意图：现行依据、限值查询、统计报告、历史演化、地方落地、实时数据。

### 3.2 权威状态优先

知识库中最重要的安全规则是：不能把非现行、非强制或说明性材料当作当前执行依据。

因此，所有摘要、实体、概念、claims 和回答上下文都必须服从同一个权威状态模型。LLM 输出不能覆盖结构化元数据中的废止、草案、说明性、统计性等状态。

### 3.3 检索排序要领域化，但规则要通用

图谱检索和普通检索都应复用 domain profile，而不是在 CLI、MCP、query、graph query 中各自写一套规则。

环境空气场景中，排序应理解以下差异：

- 查“限值、执行、现行依据”时，标准和规范优先；
- 查“为什么、背景、变化、趋势”时，编制说明、解读、技术指南、研究综述优先；
- 查“城市数量、月报、年报、统计结果”时，公报、月报、年报、统计报告优先；
- 查“某地怎么执行”时，地方标准、地方办法、地方口径优先；
- 查“今天、当前、实时、某城市空气质量”时，知识库不能替代环境数据 MCP。

### 3.4 质量检查应检查真实风险

lint 不能用已经废弃的路径规则制造噪声。否则测试人员无法区分真实问题和工具误报。

`deep lint` 应优先暴露：

- 状态与正文矛盾；
- 非依据性材料被写成依据；
- 空文本或 OCR 缺失；
- 关键元数据缺失；
- 高噪声候选页；
- 真实路径冲突；
- 检索排序弱匹配。

## 4. 文件级修改方案

## 4.1 P0：权威状态与正文一致性校正

### 目标

解决 frontmatter 识别为 `superseded`、`draft`、`explanation_only`、`statistics` 等状态后，正文仍出现未限定“现行”“执行依据”“强制要求”的问题。

### 修改文件

- `packages/engine/src/analysis.ts`
- `packages/engine/src/markdown.ts`
- `packages/engine/src/domain/env-air-status.ts`
- 新增：`packages/engine/src/domain/authority-text.ts`
- 新增或修改测试：`packages/engine/test/analysis-authority-status.test.ts`
- 新增或修改测试：`packages/engine/test/markdown-authority-status.test.ts`

### 方案

新增通用权威状态文本校正模块 `authority-text.ts`，不要把逻辑写死在某个标准或某个文件名上。

建议模型：

```ts
export type AuthorityUseClass =
  | "current_binding_basis"
  | "current_recommended_method"
  | "issued_not_yet_effective"
  | "superseded_historical"
  | "draft_not_binding"
  | "explanation_not_binding"
  | "statistics_evidence"
  | "research_evidence"
  | "unknown";
```

该模块提供：

- `classifyAuthorityUse(domain, title, path)`：根据 `legalStatus`、`documentRole`、`effectiveDate`、`supersedes`、`evidenceRole`、文件标题和路径做通用分类。
- `buildAuthorityStatusStatement(classification, domain)`：生成一条稳定、简短、可复用的状态说明。
- `reconcileAuthorityText(text, classification)`：对摘要、实体描述、概念描述、claims 文本进行通用修正。
- `reconcileSourceAnalysisAuthority(analysis, manifest)`：对完整 `SourceAnalysis` 做一致性处理。

`reconcileAuthorityText` 的策略应是保守修正，而不是重写全文：

- 对非现行材料，给文本前置状态限定；
- 对草案、征求意见稿、编制说明、月报、公报、研究报告，避免出现“可作为执法依据”“现行强制标准”等未限定措辞；
- 对历史标准，允许描述“当时规定了什么”，但必须避免“当前应执行”的语气；
- 对统计报告，允许描述统计事实、趋势和背景，不允许把统计结果写成排放限值或行政处罚依据。

示例规则应基于通用词类：

- 强依据词：`现行`、`强制执行`、`执法依据`、`验收依据`、`必须按照`、`应作为限值`
- 状态限定词：`历史版本`、`已被代替`、`征求意见稿`、`编制说明`、`统计资料`、`背景证据`

不要在规则中枚举单个标准编号。

### analysis.ts 修改点

当前 `normalizeSourceAnalysis()` 只校正标题和 domain metadata。应改为：

1. 先执行 `normalizeDomainMetadataLegalStatus()`；
2. 再执行 `reconcileSourceAnalysisAuthority()`；
3. 返回被统一校正后的 `summary`、`concepts`、`entities`、`claims`、`questions`。

同时，在 `providerAnalysis()` 的 LLM prompt 中加入“已推断权威元数据”上下文：

- 文档角色；
- 法律状态；
- 生效/废止/代替关系；
- 是否只是说明、统计或研究证据；
- LLM 输出必须与这些状态一致。

这里不是让 LLM 决定最终状态，而是让 LLM 在生成正文时遵守已推断状态。最终仍由代码校正兜底。

### markdown.ts 修改点

当前 `buildSourcePage()` 会在部分情况下输出 `Status Notice`，但摘要和后续内容仍可能不一致。应改为：

1. 对所有非 `current_binding_basis` 或非 `current_recommended_method` 的页面，输出标准化 `Status Notice`；
2. `Status Notice` 必须位于 `## Summary` 之前；
3. `Summary` 使用已校正后的 `analysis.summary`；
4. concepts、entities、claims 输出时使用校正后的文本；
5. 对非依据性文档，在页面底部加 `## Use Boundaries`，说明该材料适合作为何种证据，不适合作为什么依据。

### 测试

新增测试应覆盖通用类型，而不是单个文档：

1. `superseded` 标准页：不得出现未限定的“现行标准”“当前执行依据”。
2. `draft` 征求意见稿：必须说明“不得直接作为现行执行依据”。
3. `explanation` 编制说明：允许解释技术背景，不得替代正式标准。
4. `statistics` 月报/年报：允许统计事实，不得作为排放限值或处罚依据。
5. `current` 标准：不得被错误降级，不应过度加入历史警告。

### 验收标准

- `deep lint --deep` 中由“非现行元数据 + 正文现行表述”引起的 `contradiction_candidate` 明显下降。
- 历史标准、征求意见稿、编制说明、统计报告页面都能稳定输出使用边界。
- 权威限值类问答不受负面影响。

## 4.2 P0：graph query 领域化种子排序

### 目标

解决图谱查询对中文业务查询排序不稳定的问题，尤其是统计报告类查询和限值依据类查询。

### 修改文件

- `packages/engine/src/graph-tools.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/types.ts`
- `packages/cli/src/commands/graph.ts`
- `packages/engine/src/domain/env-air.ts`
- 新增测试：`packages/engine/test/graph-query-domain-ranking.test.ts`

### 方案

把 `graph query` 从“通用字符串匹配 + 邻接扩展”升级为“通用匹配 + 领域意图 + profile boost + 可诊断种子排序”。

### types.ts 修改点

扩展 `GraphQueryOptions`：

```ts
export interface GraphQueryOptions {
  budget?: number;
  depth?: number;
  minConfidence?: number;
  semanticMatches?: GraphSemanticMatch[];
  intent?: string;
  region?: string;
  pollutant?: string;
  asOfDate?: string;
  evaluationPeriod?: string;
  evaluationYear?: string;
  explainSeeds?: boolean;
}
```

新增 `GraphSeedDiagnostic`：

```ts
export interface GraphSeedDiagnostic {
  nodeId: string;
  pageId?: string;
  score: number;
  reasons: string[];
}
```

`GraphQueryResult` 增加：

- `seedDiagnostics?: GraphSeedDiagnostic[]`
- `warnings?: string[]`

### vault.ts 修改点

`runResolvedGraphQuery()` 应加载 domain profile，并调用已有的环境空气 query plan 构建逻辑：

1. 从 `loadDomainProfile()` 读取 profile；
2. 调用 `buildEnvAirQueryPlan(question, profile, options)`；
3. 将 query plan 传给 `searchVault()` 和 `queryGraph()`；
4. 保持无 profile 时的通用 fallback。

这样 graph query 与后续 MCP/query 检索共享同一套意图识别，不再各自分叉。

### graph-tools.ts 修改点

新增种子候选打分流程：

1. 从 semantic search、page search、node match、hyperedge match 收集候选。
2. 对候选统一打分：
   - 文本匹配分；
   - 语义检索分；
   - 节点/页面类型分；
   - domain profile boost；
   - 权威状态分；
   - 时间、地区、污染物匹配分；
   - 查询意图匹配分。
3. 对低匹配候选做截断，不允许仅因为图邻接强就进入前排。
4. BFS 扩展时保留原邻接置信度，但起始节点按种子得分排序。
5. 输出 seed diagnostics，便于测试和调试。

通用排序规则：

- `current_basis`、`limit_lookup` 意图：boost `current_authority`、`standard`、`regulation`、`pollutant`、`limit`；
- `statistics`、`trend`、`report_lookup` 意图：boost `statistics`、`monthly_report`、`annual_report`、`bulletin`、`city_count`；
- `evolution` 意图：boost `draft`、`compilation_explanation`、`amendment`、`superseded`；
- `local_adaptation` 意图：boost `local_standard`、`local_policy`、`region`；
- `methodology` 意图：boost `technical_guide`、`monitoring_method`、`evaluation_method`。

这些 boost 应通过 profile 和 metadata 类别实现，不要绑定具体文件名。

### cli graph 修改点

`swarmvault graph query` 增加参数：

- `--intent`
- `--region`
- `--pollutant`
- `--as-of-date`
- `--evaluation-period`
- `--evaluation-year`
- `--explain-seeds`

当用户不传 `--intent` 时，由 domain profile 自动分类。

### 测试

新增小型 fixture 图谱，不依赖完整 env-public：

1. 统计报告查询应优先返回 `monthly_report` / `statistics` 页面，不应被交通、排放、OBD 等泛实体抢占。
2. PM2.5 限值查询应优先返回标准、限值、污染物节点。
3. 历史演化查询应优先返回草案、编制说明、修改单、历史版本。
4. 当匹配弱时，结果应输出 `warnings`，而不是静默给出看似确定的图谱答案。

### 验收标准

- `全国城市空气质量月度报告 339个城市` 类查询前排应包含统计报告或月报类来源。
- `GB3095 PM2.5 24小时平均` 类查询前排应包含 GB3095、PM2.5、浓度限值等节点。
- `graph query --json --explain-seeds` 可解释为什么某些节点进入前排。

## 4.3 P0：deep lint slug 误报修复

### 目标

消除由旧 ASCII slug 判断造成的大量误报，使 `deep lint` 重新聚焦真实风险。

### 修改文件

- `packages/engine/src/deep-lint.ts`
- `packages/engine/src/slug.ts`
- 新增测试：`packages/engine/test/deep-lint-slug.test.ts`

### 方案

当前 `deep-lint.ts` 中 `ascii_slug_collision_risk` 使用 `slugify(title)` 判断中文标题是否退化为 `item`。这已经不符合当前知识页路径规则。

修改原则：

1. `deep lint` 判断 slug 风险时必须使用实际生成路径或当前知识标签 slug 函数；
2. 只有真实路径冲突、真实退化路径、真实 label key 冲突才告警；
3. 不再因为中文标题无法 ASCII 化就告警。

### deep-lint.ts 修改点

移除或降级：

```ts
const asciiSlug = slugify(title);
if (asciiSlug === "item") {
  findings.push({ code: "ascii_slug_collision_risk", ... });
}
```

替换为：

- 对 `page.path` 的 basename 做检查；
- 对所有 concept/entity 页按实际路径分组；
- 只有多个不同 title 映射到同一实际 basename 或 label key 时告警；
- 如果 basename 是 `item`、纯 hash、空值或明显无语义，才输出 `knowledge_slug_low_information`；
- 保留 `knowledge_label_key_collision`，但避免与路径冲突重复报同一个问题。

### slug.ts 修改点

如果当前 `slugifyKnowledgeLabel()` 没有导出足够信息，可增加：

```ts
export function explainKnowledgeSlug(label: string): {
  slug: string;
  labelKey: string;
  degraded: boolean;
  reasons: string[];
}
```

该函数用于 lint 和测试，不改变生产路径行为。

### 测试

1. 中文 concept/entity 标题正常生成路径时，不产生 `ascii_slug_collision_risk`。
2. 两个不同标题真实生成同一 label key 时，产生 `knowledge_label_key_collision`。
3. 实际路径退化为 `item` 或纯 hash 时，产生低信息 slug 告警。

### 验收标准

- `ascii_slug_collision_risk` 从数千条降至接近 0。
- lint 输出中真实问题更突出，测试人员不再被路径误报淹没。

## 4.4 P1：空提取源和 OCR 工作流

### 目标

把 `empty_extraction_source` 从“发现问题”升级为“可定位、可修复、可复测”的工作流。

### 修改文件

- `packages/engine/src/ingest.ts`
- `packages/engine/src/deep-lint.ts`
- `packages/cli/src/commands/source.ts`
- 新增测试：`packages/engine/test/empty-extraction.test.ts`

### 方案

对空提取源不要直接用空文本进入 LLM 分析。应在 ingest 阶段保留明确状态：

```ts
extraction: {
  textLength: number;
  extractionMethod: "text" | "pdf_text" | "ocr_required" | "manual_required";
  emptyReason?: string;
  sourcePath?: string;
}
```

当文本为空时：

1. source page 仍可建立，但必须标记 `needs_ocr` 或 `manual_required`；
2. 不生成概念、实体、claims；
3. deep lint 输出源文件路径和修复建议；
4. CLI 提供列出空提取源的命令。

### CLI 修改点

在 `source` 命令下新增或扩展：

- `swarmvault source doctor --empty-only`
- `swarmvault source doctor --needs-ocr`

输出：

- vault path；
- 原始文件路径；
- 文件类型；
- 当前 extraction method；
- 建议操作。

### 验收标准

- 空提取源不再污染概念和实体图谱；
- deep lint 可以清楚告诉维护人员哪些源需要 OCR 或人工转换；
- 后续加入 OCR 后不需要重写知识库质量检查逻辑。

## 4.5 P1：结构化回答 fallback 诊断增强

### 目标

减少“答案方向正确但 fallback 原因不透明”的情况，提升 MCP 调用和测试验收时的可解释性。

### 修改文件

- `packages/engine/src/query.ts`
- `packages/engine/src/answer.ts`
- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/types.ts`
- 新增测试：`packages/engine/test/env-air-structured-answer.test.ts`

### 方案

对环境空气业务问题，结构化回答应稳定输出以下字段：

- `answerBasis`：`knowledge_base`、`data_required`、`mixed`、`insufficient_evidence`
- `evidenceClass`：`current_authority`、`technical_explanation`、`statistics_evidence`、`historical_reference`、`local_reference`
- `useBoundary`：能做什么、不能做什么；
- `currentBasisNeeded`：是否需要进一步查现行标准；
- `recommendedNextTool`：是否需要环境数据 MCP。

当进入 fallback 时，应返回：

```ts
structuredAnswerDiagnostics: {
  fallback: true;
  missingFields: string[];
  repairAttempts: number;
  lastError?: string;
}
```

这样测试人员可以判断是上下文不足、模板不匹配，还是模型输出格式不稳定。

### 业务规则

对以下问题类型应有稳定结构：

- 限值、标准、执行依据；
- 技术指南、编制说明是否可直接作为验收依据；
- 月报、公报、年报是否可作为处罚依据；
- 当前城市空气质量；
- 历史版本和现行版本纠正。

这些规则应由 intent 和 evidence class 驱动，不按固定问题文本触发。

### 验收标准

- 业务结论正确时，fallback 率下降；
- 仍需 fallback 时，返回明确诊断；
- MCP 端可以把 `recommendedNextTool=environment_data_mcp` 稳定传给 deer-flow。

## 4.6 P1：候选页噪声和晋升策略

### 目标

降低 `candidate` 页面过多和 `noisy_promoted_page` 风险，使 wiki 更像专家整理后的知识库，而不是文档拆片堆积。

### 修改文件

- `packages/engine/src/knowledge-quality.ts`
- `packages/engine/src/compile.ts`
- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/deep-lint.ts`
- 新增测试：`packages/engine/test/knowledge-promotion-quality.test.ts`

### 方案

候选页晋升不应只看出现频率。建议引入通用评分：

- 是否有多个来源支撑；
- 是否属于 domain profile 的核心概念；
- 是否有清晰定义；
- 是否有业务用途；
- 是否有权威来源；
- 是否只是文档标题、章节标题或一次性短语；
- 是否与已有概念高度重复。

对于环境空气领域，核心概念优先包括：

- 污染物；
- 标准和限值；
- 评价方法；
- 监测方法；
- 时段和统计口径；
- 空气质量等级；
- 预警、溯源、达标评价；
- 地方适配和历史演化。

这应通过 profile 配置和通用 scoring 实现，不写死具体文档。

### 验收标准

- `noisy_promoted_page` 下降；
- `candidate` 页中低价值标题页比例下降；
- 核心概念页的综合性和跨来源引用增强。

## 4.7 P1：跨平台测试和格式化稳定性

### 目标

让 Windows 本地、CI 和后续多人协作的测试结果一致。

### 修改文件

- `packages/obsidian-plugin/test/workspace/resolve-root.test.ts`
- `packages/obsidian-plugin/src/workspace/resolve-root.ts`
- `packages/engine/test/personal-knowledge.test.ts`
- `packages/engine/test/vault.test.ts`
- `biome.json`
- 新增：`.gitattributes`
- 新增：`.editorconfig`

### 方案

#### Obsidian 路径测试

测试 mock 中应统一 normalize 路径：

```ts
const normalizeMockPath = (value: string) => path.normalize(value);
```

mock Set 存储 normalize 后的路径，断言也用 normalize。另加 Windows 风格路径测试，确保真实场景可用。

源码 `resolve-root.ts` 不建议为了测试强行支持 POSIX mock；真实逻辑使用 Node `path` 是合理的。

#### engine 长耗时测试

对涉及真实构建、个人知识库或 vault 初始化的测试添加局部 timeout，而不是全局放宽所有测试：

```ts
it("...", async () => {
  ...
}, 60_000);
```

#### 格式化

新增 `.gitattributes`：

```gitattributes
* text=auto eol=lf
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.pdf binary
*.zip binary
```

新增 `.editorconfig`：

```editorconfig
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

格式化应单独提交，避免与业务改造混在一起。

### 验收标准

- `pnpm test` 在 Windows 本地通过；
- `pnpm check` 不再因换行符失败；
- 格式化提交不混入业务逻辑改动。

## 4.8 P2：deep lint 上下文选择优化

### 目标

让 `deep lint --deep` 的 LLM 检查更贴近当前问题，而不是只读取前若干页面。

### 修改文件

- `packages/engine/src/deep-lint.ts`
- `packages/engine/src/search.ts`
- 新增测试：`packages/engine/test/deep-lint-context-selection.test.ts`

### 方案

当前 deep lint 的 LLM 上下文选择偏静态。建议改为问题驱动：

1. 对每类 lint 检查构建查询：
   - 状态矛盾；
   - 执行依据；
   - 统计报告；
   - 空源；
   - 地方标准；
   - 历史版本。
2. 从 graph 和 search index 中选相关页面；
3. 每类问题限制上下文预算；
4. 输出 LLM 检查使用的 page ids，便于复现。

### 验收标准

- deep lint 报告的高风险项更聚焦；
- LLM 检查结果可以通过 page ids 复现；
- 不增加过多 token 成本。

## 5. 推荐实施顺序

### 第一阶段：先修正质量评估可信度

1. 修复 `deep lint` slug 误报。
2. 修复跨平台测试和换行符问题。
3. 增加空提取源诊断。

原因：先降低噪声，后续才能判断真正的知识质量问题。

### 第二阶段：修复权威状态一致性

1. 新增 `authority-text.ts`。
2. 修改 `analysis.ts` 的后处理链路。
3. 修改 `markdown.ts` 的状态说明和使用边界输出。
4. 增加单测。
5. 对 env-public 完整重构。

原因：这是环保局业务中最重要的安全风险，必须优先解决。

### 第三阶段：增强 graph query 和 MCP 检索可解释性

1. 扩展 `GraphQueryOptions`。
2. `vault.ts` 复用 domain query plan。
3. `graph-tools.ts` 实现种子排序和 diagnostics。
4. CLI 增加 `--explain-seeds`。
5. 用小型 fixture 和真实 env-public 双重验证。

原因：该阶段直接影响 deer-flow 通过 MCP 使用知识库时的上下文质量。

### 第四阶段：优化回答结构和候选页质量

1. 增强 structured answer diagnostics。
2. 优化 candidate promotion。
3. 优化 deep lint 上下文选择。

原因：这些问题影响专家感和长期维护质量，但不应阻塞前面 P0 修复。

## 6. 完整验证方案

每轮代码修改后，应执行以下验证。

### 6.1 源码级验证

```powershell
cd D:\Github\swarmvault
pnpm -r typecheck
pnpm build
pnpm --filter @swarmvaultai/engine test
pnpm --filter @swarmvaultai/cli test
pnpm --filter @swarmvaultai/viewer test
pnpm test
pnpm check
```

如 `pnpm check` 因格式化统一产生大量变更，应单独提交格式化结果。

### 6.2 知识库重构验证

```powershell
cd D:\kb\env-public
swarmvault compile --force
swarmvault retrieval status --json
swarmvault retrieval doctor --json
swarmvault lint --json
swarmvault lint --deep --json
```

重点观察：

- 是否仍有 heuristic fallback；
- `contradiction_candidate` 是否下降；
- `ascii_slug_collision_risk` 是否消除或明显下降；
- 空提取源是否被清楚标记为 OCR/manual required；
- graph report 是否正常生成。

### 6.3 查询验证

```powershell
swarmvault query "PM2.5 的24小时平均浓度限值是多少？" --json
swarmvault query "全国城市空气质量月度报告能不能作为行政处罚或排放限值依据？" --json
swarmvault query "今天北京市空气质量怎么样？请给出判断。" --json
swarmvault query "用户引用 HJ/T 194-2005 做现行手工监测依据，agent 应如何纠正？" --json
swarmvault query "编制说明里的技术指标能否直接作为验收检测要求？" --json
swarmvault query "2020 年和 2022 年以后全国城市空气质量月报覆盖城市数量有何变化？" --json
```

预期：

- 限值问题使用现行标准；
- 月报、公报、统计资料不被当成执法依据；
- 今天/当前/实时问题路由到环境数据 MCP；
- 历史标准纠正时明确现行替代依据；
- 编制说明只作为解释材料；
- 证据不足时明确说明缺口，不编造统计变化。

### 6.4 graph query 验证

```powershell
swarmvault graph query "环境空气质量评价" --budget 20 --json --explain-seeds
swarmvault graph query "GB3095 PM2.5 24小时平均" --budget 20 --json --explain-seeds
swarmvault graph query "全国城市空气质量月度报告 339个城市" --budget 20 --json --explain-seeds
```

预期：

- 图谱前排节点与查询意图一致；
- seed diagnostics 能解释排序原因；
- 统计报告查询不再被无关交通、OBD、清洁生产实体抢占；
- 弱匹配时给出 warning。

## 7. 风险和缓解措施

### 7.1 权威状态校正过度

风险：把现行有效标准错误降级，导致回答过于保守。

缓解：

- `current_binding_basis` 和 `current_recommended_method` 不做强制负面限定；
- 单测覆盖 current/current recommended；
- deep lint 对“现行标准被错误标为历史”单独报警。

### 7.2 排序规则过度依赖中文关键词

风险：换一批资料或换一种问法后排序失效。

缓解：

- 关键词只作为 profile boost 的一部分；
- 同时使用 metadata、documentRole、evidenceRole、semantic score、graph edge；
- 对所有 boost 输出 diagnostics。

### 7.3 lint 噪声下降后暴露更多真实问题

风险：修复 slug 误报后，测试报告看起来问题类型变化。

缓解：

- 在报告中区分“误报消除”和“真实问题新增”；
- 保留历史计数对比；
- 不以总 warning 数作为唯一质量指标。

### 7.4 格式化提交造成大规模 diff

风险：影响代码审查。

缓解：

- `.gitattributes`、`.editorconfig` 和格式化单独提交；
- 业务逻辑修改单独提交；
- commit message 明确区分。

### 7.5 LLM prompt 修改引入成本上升

风险：构建时间和 token 成本增加。

缓解：

- 只在 source analysis prompt 中加入紧凑 metadata；
- 校正逻辑主要由代码兜底；
- 对 deep lint 的 LLM 上下文采用预算控制。

## 8. 最终验收指标

完成所有 P0-P1 后，建议用以下指标判断是否达到下一阶段质量：

- 源码测试：`typecheck`、`build`、engine/cli/viewer tests、`pnpm test`、`pnpm check` 全通过。
- 重构：完整 `compile --force` 成功，无 heuristic fallback。
- 检索：`retrieval status` 和 `doctor` 均正常。
- lint：`ascii_slug_collision_risk` 基本清零；状态矛盾显著下降；空提取源有明确修复路径。
- 问答：权威依据、说明材料、统计资料、实时数据四类边界稳定。
- graph query：统计报告、限值、历史演化、地方适配查询均能返回符合意图的前排结果。
- MCP：deer-flow 调用知识库时能拿到明确的 `answerBasis`、`recommendedNextTool`、证据来源和使用边界。

## 9. 建议的提交拆分

建议按以下提交拆分，便于回滚和审查：

1. `fix(lint): align deep lint slug checks with knowledge label slugs`
2. `fix(test): stabilize workspace path tests on windows`
3. `chore(format): enforce lf line endings`
4. `feat(engine): reconcile authority status across source analysis text`
5. `feat(graph): add domain-aware graph query seed ranking`
6. `feat(query): expose structured answer fallback diagnostics`
7. `feat(ingest): mark empty extraction sources for OCR repair`

每个提交后都执行相关最小测试。完成 P0 后必须完整重构 env-public，再做全盘测试。

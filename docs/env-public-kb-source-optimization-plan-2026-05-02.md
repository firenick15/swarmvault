# 环境空气公共知识库源码优化完整方案

日期：2026-05-02  
项目：`D:\Github\swarmvault`  
公共知识库 Vault：`D:\kb\env-public\vault`  
测试报告：`D:\kb\env-public\tests\env-public-full-test-validation-report-20260501.md`

## 1. 结论摘要

结合本轮代码检查和 2026-05-01 全盘测试报告，当前项目已经解决了上一轮最严重的 LLM 编译失败和 heuristic fallback 问题：完整重构后 `source analysis` 统计为 `provider=994`、`empty=3`、`fallback=0`，说明 GLM-5 配置和主编译链路基本可用。但知识库仍不应直接进入稳定生产阶段，原因不是“某几个标准没有补好”，而是源码层仍存在几类会反复影响环境空气业务的通用机制缺口：

1. 检索索引新鲜度没有在查询入口强制校验。测试报告中首次严格查询失败，根因是 retrieval index stale，而不是知识库本体缺证据。
2. 环境空气领域意图、标准族、事实类型、检索排序仍偏窄。现有代码对 `GB 3095`、`HJ 663`、`HJ 633` 等核心问题已经较强，但对运行质控、采样/分析方法、统计公报、臭氧协同控制等跨文档问题不够稳定。
3. 候选页聚合存在通用 slug/归一化风险。源码中同时存在 Unicode 友好的 `slugifyKnowledgeLabel()` 和 ASCII 旧 `slugify()`，其中 `aggregateItems()` 仍用旧 slug 聚合，中文概念可能被错误合并，导致超大聚合页、知识页碰撞和“宽泛概念吸走证据”。
4. 候选页质量控制分散在多个文件中，规则表达还偏硬编码。当前能识别一部分文件名型页面、短缩写和 god node，但缺少统一的、profile-aware 的质量评分模块。
5. 查询层的“证据选择”和“回答提示词”没有充分利用领域 profile。`search.ts` 中的精排、结构化事实 boost、chunk hydration 仍主要围绕少数 hardcoded intent 展开，难以支撑长期扩展。
6. DeerFlow 工具路由仍有业务风险。对“今天/某城市/空气质量”这类实际数据问题，模型建议和确定性策略冲突时，当前 `finalizeToolRouting()` 会优先保留 base policy，可能继续只调用知识库。
7. `lint --deep` 已经能发现很多问题，但诊断粒度还不够支持闭环治理。例如短缩写碰撞、超大聚合、空提取、文件标题型候选、无 page 解释节点等问题需要结构化输出。

因此，下一轮源码修改应围绕“可复用领域机制”展开，而不是针对 `HJ 633`、`HJ 817`、某一次 PM2.5 问答、某一个报告标题写枚举补丁。核心目标是让 SwarmVault 对环境空气公共知识库具备长期可维护能力：新标准、新地方文件、新统计报告、新客户报告进入后，仍能被正确分层、检索、引用和路由。

## 2. 设计原则

### 2.1 禁止的修改方式

以下修改方式不建议采用：

1. 在搜索代码中写死单个标准号的特殊排序，例如只针对 `HJ 817`、`HJ 818`、`GB 3095-2026` 加分。
2. 在回答提示词中写死单个问题的标准答案，例如“337 变 339 城市”或“北京市 PM2.5 年均值”。
3. 直接扩大所有召回范围，以牺牲准确性换表面命中率。
4. 把 OCR、草案、编制说明、研究论文内容自动提升为现行执行依据。
5. 为解决某个短缩写 collision，把 `CO`、`O3`、`SF6` 等逐个散落在多个文件中 allowlist。

### 2.2 推荐的修改方式

应采用以下通用机制：

1. 用 `domain profile` 描述业务知识：标准族、术语族、意图规则、证据角色、工具路由策略、短缩写分类。
2. 用 query plan 承载业务意图：问题匹配后输出 `expandedTerms`、`pinnedStandards`、`standardClusters`、`rankingSignals`、`factTypeBoosts`、`evidenceRoleBoosts`。
3. 检索层只消费 query plan，不直接认识具体业务问题。
4. 候选页治理使用统一质量评分模块，支持 profile 配置，不散落在 `vault.ts`、`candidate-promotion.ts`、`deep-lint.ts`。
5. 对现行依据、解释性证据、演化材料、地方适配、项目私有报告保持不同证据权重和引用语义。
6. 所有新增能力都要通过 synthetic test 验证通用性，避免只靠当前公共库里的某一个文件验证。

### 2.3 本次复核后的新增约束

进一步对照源码后，原方案还需要补充以下约束，否则后续落地存在兼容性和安全风险：

1. MCP 决策字段必须使用现有枚举值。当前 `RecommendedNextTool` 是 `"knowledge_base" | "environment_data_mcp" | "both"`，方案和提示词中出现的 `env_data_mcp` 只能作为口语说明，源码和测试必须统一为 `environment_data_mcp`。
2. 任何二次检索、权威边界补充检索、schema evidence 注入、context pack 构建，都必须继承 `scope/tenantId/projectId/visibility/sourceScope`，不能只在第一次 `searchVault()` 时过滤。
3. `domain profile` 不能只改 TypeScript 默认常量。`profile-loader.ts` 目前对外部 profile 主要是浅合并和类型断言，新增字段必须同步加校验、兼容默认值、外部文件引用和 warning。
4. 自动 repair retrieval index 不能裸调用 rebuild。MCP 并发请求下必须有单飞锁或复用现有 compile/retrieval lock，并采用临时文件重建后原子替换，避免并发写 SQLite。
5. GLM-5 有 200k 上下文，但当前 `analysis.ts` 的 provider source analysis 输入上限仍偏小，长标准、长报告和表格型 PDF 可能只被截断分析。知识库质量问题不只在检索端，也在 LLM 分析阶段。
6. 候选页质量模块不能只判断标题，还要同时看 source spread、claim coherence、authority layer spread、documentRole spread、是否有稳定事实或条款支撑，避免误伤真正的跨文档主题。
7. `mixed_public_private` 场景下，公共权威材料和项目私有报告可以共同进入上下文，但回答必须标明哪些结论来自私有报告，且不能把某客户历史报告中的写法升级成公共通用口径。

## 3. 问题归因

### 3.1 Retrieval stale 导致“假性无证据”

报告中曾出现严格查询不能命中 `GB 3095-2012` 与 `GB 3095-2026` 的情况。重建 retrieval index 后，同一问题可以正确回答。这说明当前风险不在 LLM 或资料缺失，而在查询入口没有保证检索索引与 graph 同步。

现有代码状态：

- `packages/engine/src/retrieval.ts` 已有 `getRetrievalStatus()`、`doctorRetrieval({ repair })`、manifest graph hash 和 schema hash 校验。
- `packages/engine/src/vault.ts` 的 `executeQuery()` 只在索引或 graph 文件缺失时触发 compile/rebuild，没有在每次 query 前检查 stale。
- CLI 已有 `swarmvault retrieval status/rebuild/doctor`，但用户和 MCP 调用方不会天然记得在 query 前手工执行。

结论：需要把 retrieval freshness check 前移到查询入口，变成默认安全机制。

### 3.2 领域 profile 不够表达真实业务

`DEFAULT_ENV_AIR_PROFILE` 已经包含环境空气术语、污染物别名、部分核心标准和一些 intentRules。但当前 profile 更像“关键词扩展清单”，还不够表达环保局业务中的标准族、证据分层和操作场景。

现有缺口：

- `standardCatalog` 只覆盖少量核心标准，自动监测运行质控、颗粒物/气态系统安装验收、手工监测、采样保存、分析方法、统计报告等链条不完整。
- `intentRules` 只有 `expandedTerms`、`pinnedStandards`、`rankingSignals`，缺少 `standardClusters`、`documentRoleBoosts`、`evidenceRoleBoosts`、`factTypeBoosts`、`mustTermGroups`。
- `topicSeeds` 数量少，难以引导 LLM 把同一主题下的标准、指南、编制说明、统计报告整合成有机 wiki。
- `classifyEnvAirToolRouting()` 仍依赖默认 profile 里的若干词表和手写规则，对“实际数据查询”识别不够稳。

结论：应扩展 domain profile 数据结构，使业务规则可以配置和复用。

### 3.3 搜索排序仍是少数 intent 的硬编码增强

`packages/engine/src/search.ts` 已实现了结构化事实、标准精确召回、chunk FTS、page FTS、metadata boost 等能力。但对环境空气业务而言，排序增强仍偏硬编码：

- `ambientLimitIntent`、`assessmentValidityIntent`、`amendmentIntent` 是几个单独布尔变量。
- `factBoostExpression()` 主要 boost `limit_value`、`formula`、`technical_parameter`、`validity_rule` 等有限场景。
- `hydrateRowsWithDomainChunks()` 只对限值、有效性、修改单做专门 snippet 改善。
- `appendRows()` 对 chunk 结果按 page id 去重，导致同一标准内多个关键条款只能保留一个 chunk，运行质控类问题容易丢上下文。

结论：搜索层应从 query plan 读取通用 ranking context，而不是继续增加零散布尔变量。

### 3.4 候选页聚合与 slug collision 是 P0 质量风险

源码里存在两套 slug 逻辑：

- `slugify()`：ASCII 导向，用于普通输出 slug。
- `slugifyKnowledgeLabel()`：支持 Unicode 标签和 hash fallback，更适合中文知识页。

但 `aggregateItems()` 仍使用：

```ts
const key = slugify(item.name);
```

这会使中文概念在某些情况下落入弱区分 key，带来错误合并风险。测试报告中的 `aggregate_page_too_large`、`knowledge_slug_collision`、宽泛主题页吸收大量 source id 等问题，和这一类聚合机制高度相关。

结论：这是必须优先修的通用缺陷，不是数据源清理可以解决的问题。

### 3.5 候选质量规则分散，且不可配置

当前候选质量逻辑分布在：

- `packages/engine/src/vault.ts` 的 `aggregateTopicQuality()`
- `packages/engine/src/candidate-promotion.ts` 的 `slugQualityScore()` 和 promotion gates
- `packages/engine/src/deep-lint.ts` 的 deterministic findings

问题：

- 文件标题型候选、短缩写、宽泛机构名、prompt 残留、超大聚合页等判断没有统一来源。
- `candidate-promotion.ts` 直接引用 `DEFAULT_ENV_AIR_PROFILE.shortSlugAllowlist`，不利于自定义 profile 和 SaaS 多业务域扩展。
- deep lint 发现的问题不一定和编译时 candidate gating 使用同一套逻辑。

结论：需要统一候选质量评分模块，并接入 compile、promotion、lint。

### 3.6 权威边界回答需要“具体材料 + schema 规则”

报告反馈中提到，权威边界类问题有时更依赖 schema 规则，而不是同时展示具体材料来源。例如问“研究报告/公报/技术指南能不能作为执行依据”，回答应同时引用：

- 被问到的具体材料；
- `swarmvault.schema.md` 或 frontmatter 中的 `authorityLayer/legalStatus/documentRole/evidenceRole`；
- 如果涉及标准本身，还应引用现行标准或规范。

当前 `vault.ts` 会为 `authority_boundary_question` 附加 schema evidence，但检索策略不保证具体目标材料一定进入高位 evidence。

结论：应增加 authority boundary 的双通道证据构造。

### 3.7 DeerFlow 工具路由需要更接近实际业务

测试报告指出，“今天 + 城市 + 空气质量”这类问题需要调用环境数据 MCP，而不是只走知识库。当前代码里：

- `classifyEnvAirToolRouting()` 已做基础判别；
- `finalizeToolRouting()` 会在模型建议与 base policy 冲突时保留 base；
- prompt 要求 “Only recommend environment_data_mcp when actual monitoring data...”，但最终策略仍可能压过模型判断。

结论：应把“实际数据问题”的确定性规则做准，而不是靠模型建议兜底。

### 3.8 空提取和数据源清理是必要但不是主线

完整编译后剩余 `empty=3`、`fallback=0`。这说明 heuristic fallback 不再是当前主要矛盾，但 3 个空提取仍需要治理。

判断：

- 空提取大概率来自扫描 PDF、加密/图片型 PDF、或提取器无法解析的源文件。
- 对这些源文件，应先输出结构化诊断，必要时启用显式 OCR。
- OCR 结果必须带 provenance，不能默认与原生文本同等权威。

结论：数据源清理需要做，但不应替代源码机制优化。

## 4. 源码修改方案

### P0-1：查询入口强制 retrieval freshness check

目标：消除 stale index 导致的假性无证据。

修改文件：

- `packages/engine/src/types.ts`
- `packages/engine/src/config.ts`
- `packages/engine/src/retrieval.ts`
- `packages/engine/src/vault.ts`
- `packages/cli/src/index.ts`
- `packages/engine/test/retrieval.test.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

具体方案：

1. 在 `VaultConfig.retrieval` 增加：

```ts
queryStalePolicy?: "error" | "auto_repair" | "warn";
```

建议默认策略：

- CLI 交互查询：默认 `auto_repair`，避免用户误用旧索引。
- CI 或严格测试：允许配置为 `error`。
- MCP 服务：建议 `auto_repair`，并在 `retrievalDebug` 返回 repair 记录。

复核修正：`auto_repair` 必须是“受控自动修复”，不能在并发 MCP 请求中直接多路重建同一个 SQLite 文件。实现时需要：

- 复用或新增 retrieval rebuild lock，保证同一 vault 同一时间只有一个 repair。
- rebuild 写入临时索引和临时 manifest，完成校验后再原子替换。
- 其他并发 query 等待 repair 完成，或在超时后返回明确的 stale 错误。
- repair 只能基于现有 graph 重建 retrieval index，不能隐式触发完整 LLM compile。

2. 在 `config.ts` 的 zod schema 中加入同名字段。

3. 在 `retrieval.ts` 新增：

```ts
export async function ensureRetrievalReady(
  rootDir: string,
  options?: { policy?: "error" | "auto_repair" | "warn" }
): Promise<{ status: RetrievalStatus; repaired: boolean; warnings: string[] }>;
```

行为：

- 如果 graph 缺失，抛出明确错误：先运行 `swarmvault compile`。
- 如果 index/schema/manifest stale：
  - `error`：抛出错误并提示 `swarmvault retrieval doctor --repair`。
  - `auto_repair`：调用 `rebuildRetrievalIndex()`。
  - `warn`：继续查询，但把 warning 注入 debug。

4. 在 `vault.ts` 的 `executeQuery()`、explore/query 相关入口、MCP query entry 统一调用 `ensureRetrievalReady()`。

5. 在 `RetrievalDebugInfo` 中增加：

```ts
retrievalStatus?: {
  staleBeforeQuery: boolean;
  repaired: boolean;
  warnings: string[];
};
```

6. 在 CLI 层增加显式覆盖参数，便于测试和运维：

```powershell
swarmvault query "..." --retrieval-stale-policy error
swarmvault query "..." --retrieval-stale-policy auto_repair
```

如果不希望暴露 CLI 参数，也至少要允许通过 `swarmvault.config.json` 控制。

验收测试：

```powershell
pnpm --filter @swarmvaultai/engine test -- retrieval env-air-retrieval
```

新增测试场景：

- 手工制造 graph hash mismatch，query 自动 repair 后能召回新页面。
- `queryStalePolicy=error` 时 query 抛出明确错误。
- `queryStalePolicy=warn` 时 query 不 repair，但 debug 带 warning。
- 并发触发 5 个 query 时只执行一次 rebuild，所有结果使用同一个 fresh manifest。

### P0-2：修复中文知识项聚合 key，消除通用 slug collision 风险

目标：避免中文概念、污染物缩写、地方标准编号被错误合并为同一候选页或超大概念页。

修改文件：

- `packages/engine/src/utils.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/deep-lint.ts`
- `packages/engine/test/knowledge-slug.test.ts`（新增）
- `packages/engine/test/env-air-compile.test.ts` 或现有 compile 测试文件

具体方案：

1. 在 `utils.ts` 新增知识标签归一 key：

```ts
export function normalizeKnowledgeLabelKey(value: string): string;
```

要求：

- 保留中文、英文、数字和标准编号语义。
- 统一全角/半角、大小写、空白、连字符。
- 对 `PM2.5`、`PM 2.5`、`pm25` 可通过 profile alias 进一步合并，但基础函数不擅自把不同缩写合并。
- 对空 key 使用稳定 hash fallback。

2. 修改 `vault.ts` 的 `aggregateItems()`：

现状：

```ts
const key = slugify(item.name);
```

改为：

```ts
const key = normalizeKnowledgeLabelKey(item.name);
```

3. 输出文件路径仍使用 `slugifyKnowledgeLabel(aggregate.name)`，但 collision 解决应基于 canonical label，不应让多个不同 label 抢同一个 path。

4. 在 deep lint 增加两个确定性检查：

- `knowledge_label_key_collision`：同 key 下出现多个明显不同 label。
- `ascii_slug_collision_risk`：旧 `slugify()` 会把多个中文 label 压成同一 key 的风险。

5. 对已生成的历史错误聚合页，不在源码修改中硬删。完整重构后通过新聚合 key 自然改正；旧 `.stale` 页面按既有机制归档。

6. 需要把“聚合 key”和“页面 path slug”分离：

- 聚合 key 用于判断哪些 LLM 抽取项代表同一知识对象。
- path slug 用于落盘和链接，必须 collision-safe。
- alias 合并只能通过 profile alias/canonical label 完成，不能靠 slug 近似合并。

7. 对历史页面迁移要输出 mapping：

```text
oldPageId -> newPageId
oldPath -> newPath
reason=knowledge_label_key_changed
```

这样 graph explain、旧 output 引用和 stale 页面归档可以追踪来源，避免用户看到“页面消失”。

验收测试：

- 构造中文概念 `臭氧协同控制`、`大气污染虚拟治理成本法`、`环境空气质量评价`，确保聚合 key 不同。
- 构造 `CO`、`O3`、`SF6`、`DB11/T 123`，确保短缩写不会被错误合并，也不会被全部当作噪声。
- 运行完整 compile 后，`aggregate_page_too_large` 数量应显著下降。
- 旧页面 path 变化时，`.stale` 归档和 mapping 文件能说明迁移原因。

### P0-3：建设统一候选质量评分模块

目标：把候选页过滤、自动晋升、deep lint 的质量判断统一起来，并让规则具备 profile 可配置性。

修改文件：

- `packages/engine/src/candidate-promotion.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/deep-lint.ts`
- `packages/engine/src/domain/profile-loader.ts`
- `packages/engine/src/domain/env-air-profile.ts`
- `packages/engine/src/knowledge-quality.ts`（新增）
- `packages/engine/test/knowledge-quality.test.ts`（新增）

具体方案：

1. 新增 `knowledge-quality.ts`，提供：

```ts
export interface KnowledgeCandidateQualityInput {
  title: string;
  kind: "concept" | "entity";
  descriptions?: string[];
  sourceIds?: string[];
  authorityLayers?: string[];
  documentRoles?: string[];
  nodeDegree?: number;
  profile?: LoadedDomainProfile;
}

export interface KnowledgeCandidateQualityResult {
  score: number;
  severity: "ok" | "candidate_only" | "index_only" | "reject";
  reasons: string[];
  tags: string[];
}
```

2. 质量规则必须通用：

- 文件名/目录型标题：标题包含年份 + 清单/目录/公告/报告，但缺少稳定业务概念时降级。
- prompt 残留：包含 `No claims extracted`、`Concepts`、`Entities` 等生成痕迹时拒绝。
- 过短缩写：依赖 profile 的 `shortSlugAllowlist` 和 `termAliases` 分类，不在多个文件中散写 allowlist。
- 过宽组织/主题：source spread 大、authority layer 跨度大、描述与标题低一致性时降为 `index_only`。
- 长句标题：像完整句子或文件标题，不像概念/实体时降级。
- 标准编号、污染物、方法名、地方标准号作为受控短标签允许保留。

3. `vault.ts` 的 `aggregateTopicQuality()` 改为调用新模块。

4. `candidate-promotion.ts` 的 `slugQualityScore()` 改为调用新模块，移除对 `DEFAULT_ENV_AIR_PROFILE` 的直接依赖。

5. `deep-lint.ts` 使用同一模块输出确定性 findings。

6. 质量评分模块不要直接依赖 `DEFAULT_ENV_AIR_PROFILE`。调用链应传入 `LoadedDomainProfile`；如果没有 profile，则使用通用默认规则。这样 SaaS 后续扩展到其他环保业务或客户私有术语时，不会被环境空气默认短缩写表绑死。

7. 评分结果要区分“不能成为概念页”和“仍可作为检索索引项”：

- `reject`：prompt 残留、空标题、明显生成错误。
- `index_only`：文件标题、宽泛组织名、过宽主题，可参与检索但不生成专家概念页。
- `candidate_only`：信息不足但可能有价值，需要更多来源确认。
- `ok`：可以生成 active concept/entity。

验收测试：

- 同一批 synthetic candidate 在 compile、promotion、lint 三处得到一致判定。
- 文件标题型候选不会晋升为 active concept。
- `O3`、`CO`、`PM2.5` 在环境空气 profile 下不会被误判为噪声。

### P0-4：扩展 domain profile 的 intent/ranking 表达能力

目标：用配置承载环境空气业务知识，避免在搜索代码中继续写单点补丁。

修改文件：

- `packages/engine/src/domain/env-air-profile.ts`
- `packages/engine/src/domain/profile-loader.ts`
- `packages/engine/src/domain/intents.ts`
- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/types.ts`
- `packages/engine/test/env-air-intents.test.ts`（新增或扩展）

新增 profile 字段建议：

```ts
interface EnvAirStandardCatalogEntry {
  identity: string;
  family: string;
  number: string;
  current?: string;
  title: string;
  aliases: string[];
  clusterIds?: string[];
  documentRoleHints?: string[];
}

interface EnvAirStandardCluster {
  id: string;
  title: string;
  standards: string[];
  aliases?: string[];
  evidenceRoles?: string[];
  documentRoles?: string[];
}

interface EnvAirIntentRule {
  id: string;
  priority: number;
  anyText?: string[];
  allText?: string[];
  anyTermGroups?: string[][];
  anyPollutant?: boolean;
  expandedTerms?: string[];
  pinnedStandards?: string[];
  standardClusters?: string[];
  rankingSignals?: string[];
  factTypeBoosts?: Record<string, number>;
  documentRoleBoosts?: Record<string, number>;
  evidenceRoleBoosts?: Record<string, number>;
  chunkTermBoosts?: Record<string, number>;
  routePolicy?: "knowledge" | "data" | "both" | "defer";
}
```

外部 profile 加载必须同步修改：

1. `profile-loader.ts` 不能继续对新增复杂字段直接 `as EnvAirProfile[...]`。需要为 `standardClusters`、`intentRules`、`topicSeeds`、`rankingRules` 增加轻量校验，非法项跳过并返回 warning。
2. `domain.rankingPath` 目前在 config 中存在，但 loader 只读取了 `referenced.rankingRules`，没有真正合并 ranking rule。新增 ranking context 时要把 `rankingPath` 接入，避免配置项“看起来支持但实际无效”。
3. 外部 profile 的数组字段应支持两种模式：
   - replace：完全替换默认 profile；
   - extend：在默认 profile 后追加或覆盖同 id 项。
   
   建议初期使用显式字段：

```json
{
  "mergeMode": "extend"
}
```

4. `buildDomainQueryPlan()`、`buildEnvAirQueryPlan()`、`classifyEnvAirToolRouting()` 必须全部接收同一个 `LoadedDomainProfile`，不能出现 query plan 用自定义 profile、工具路由仍走默认 profile 的分裂。

环境空气默认 profile 应新增的通用标准族，不按单问答写补丁：

1. `ambient_quality_core`：环境空气质量标准、评价技术规范、AQI 技术规定。
2. `ambient_auto_monitoring_acceptance`：自动监测系统安装、验收、比对测试相关标准。
3. `ambient_auto_monitoring_operation_qaqc`：连续自动监测运行维护、质控、有效数据、异常值处理。
4. `ambient_manual_sampling_analysis`：手工采样、样品保存、分析方法、检出限。
5. `ambient_statistics_reporting`：月报、公报、年报、统计口径。
6. `ozone_pm25_coordinated_control`：臭氧、PM2.5、VOCs、NOx 协同控制及来源解析。
7. `local_adaptation`：地方标准、地方办法、地方执行口径。
8. `evolution_tracking`：征求意见稿、编制说明、修改单、历史版本。

注意：标准族可以包含标准号，但不能只为某一次测试写死排序逻辑。新增标准进入时，只要归入正确 cluster，检索和回答能力应自然继承。

验收测试：

- 新增一个 synthetic 标准 `HJ 999`，只要归入 `ambient_auto_monitoring_operation_qaqc`，运行质控问题即可召回它，不需要改搜索代码。
- 自定义 profile 中修改 cluster 后，query plan、search debug、tool routing 三处结果一致。

### P0-5：将搜索排序改为 profile-driven ranking context

目标：让检索层支持标准族、证据角色、事实类型、chunk 术语的通用增强。

修改文件：

- `packages/engine/src/search.ts`
- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/domain/intents.ts`
- `packages/engine/src/types.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

具体方案：

1. 在 query plan 中生成：

```ts
interface DomainRankingContext {
  expandedTerms: string[];
  pinnedStandards: string[];
  standardClusters: string[];
  rankingSignals: string[];
  factTypeBoosts: Record<string, number>;
  documentRoleBoosts: Record<string, number>;
  evidenceRoleBoosts: Record<string, number>;
  chunkTermBoosts: Record<string, number>;
}
```

2. `searchPages()` 不再新增更多 `xxxIntent` 布尔变量，而是从 `DomainRankingContext` 生成 SQL 排序参数。

安全约束：

- 动态 SQL 只能使用内部 allowlist 后的字段名、fact type 和 document role，不能把 profile 中的字符串直接拼进 SQL。
- profile 中的 boost 权重必须做范围限制，例如 `0 <= weight <= 10`。
- chunk 多结果返回必须有全局 evidence budget 和单 page budget，避免长标准或超大报告挤掉其他证据层。
- ranking context 的变化如果影响 retrieval index schema，必须提升 `RETRIEVAL_INDEX_SCHEMA_VERSION` 并让 `retrieval status` 显示 stale。

3. `factBoostExpression()` 支持从 `factTypeBoosts` 和 `rankingSignals` 动态计算。例如：

- `limit_value`：限值/标准值问题。
- `formula`：公式、计算、指数、评价方法问题。
- `validity_rule`：有效数据、评价有效性、达标评价问题。
- `technical_parameter`：质控、校准、检出限、转换效率、平行性问题。
- `status_rule`：现行、废止、替代、实施日期问题。
- `method_step`：采样、运维、比对、校准步骤问题。

4. `hydrateRowsWithDomainChunks()` 改为通用函数：

```ts
hydrateRowsWithRankingContext(rows, rankingContext, query)
```

逻辑：

- 如果页面是 pinned standard 或 pinned cluster 成员，优先选择包含 `chunkTermBoosts`、pollutant focus、fact search terms 的 chunk。
- 表格型 chunk 可保留表头和命中行。
- 同一 page 可允许返回多个 chunk，但设置上限，避免一个长标准占满 evidence。

5. `appendRows()` 的 page 去重策略调整：

- 对 page FTS 仍按 page 去重。
- 对 chunk FTS，在 pinned standard 或 structured fact 高相关时允许每页最多 2-3 个 chunk。
- 对 facts 保持 stable id 去重。

6. `retrievalDebug.queryPlan` 输出 ranking context，便于测试人员判断为什么召回某个标准。

验收测试：

- 运行质控类问题能稳定召回运行质控 cluster 下的多个标准/条款。
- 统计口径类问题优先召回公报/月报/年报，不被无关标准压过。
- 臭氧综合问题能同时召回标准限值、统计报告、技术指南/研究证据，并在回答中区分权威性。

### P0-6：改进工具路由，服务 DeerFlow 的实际业务调用

目标：让知识库 MCP 能准确告诉 DeerFlow 什么时候应调用环境数据 MCP、什么时候只需要知识库、什么时候需要两者。

修改文件：

- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/types.ts`
- `packages/engine/test/env-air-tool-routing.test.ts`
- DeerFlow 侧如已有 schema 依赖，则同步检查，但本轮方案主要改 SwarmVault。

具体方案：

1. 在 profile 中增加或复用：

- `dataObjectTerms`
- `dataTimeTerms`
- `dataLocationTerms`
- `dataOperationTerms`
- `basisOnlyTerms`
- `routePolicy`

2. `classifyEnvAirToolRouting()` 改成 profile-aware：

- 输入 `LoadedDomainProfile`。
- 输出：

```ts
{
  knowledgeNeeded: boolean;
  dataNeeded: boolean;
  recommendedNextTool: "knowledge_base" | "environment_data_mcp" | "both";
  confidence: number;
  reasons: string[];
  matchedSignals: {
    time: string[];
    location: string[];
    dataObject: string[];
    operation: string[];
    basisOnly: string[];
    knowledge: string[];
  };
}
```

注意：现有 `RecommendedNextTool` 没有 `"none"`，也没有 `"env_data_mcp"`。如果确实需要表达“不需要额外工具”，应通过 `AgentDecision.reportUsability` 或新增可选字段表达，不能破坏现有 enum。

3. 通用判定规则：

- `time + location + air quality/status/data object`：倾向 data。
- `time + location + data operation`：倾向 data。
- `依据/标准/怎么评价/限值/口径`：倾向 knowledge。
- `某地区某年份报告依据 + 指标值`：倾向 both，因为既要标准依据，也可能需要数据事实。
- 明确“不要查数据，只问标准依据”：knowledge。

4. `finalizeToolRouting()` 不应盲目压制模型建议，而应比较：

- base confidence；
- model recommendation；
- query plan routePolicy；
- evidence state。

当 base confidence 低、模型建议 data、且命中时间地点数据对象时，应允许切到 `environment_data_mcp` 或 `both`。

此处源码和文档统一使用 `environment_data_mcp`。提示词、MCP description、测试断言和 DeerFlow 解析逻辑都要同步，不再混用 `env_data_mcp`、`needs_data_mcp` 作为工具名。

5. 返回字段保持向后兼容：保留原有 `recommendedNextTool`、`agentDecision.mustCallTools`，新增字段只做补充。

6. MCP `query_vault` 的 description 目前提到 `needs_data_mcp`，但 `EvidenceState` 没有这个枚举。应改为：`agentDecision.reportUsability=needs_data_mcp` 表示必须调用环境数据 MCP，`recommendedNextTool=environment_data_mcp|both` 表示推荐下一步工具。

验收测试：

- “今天北京市空气质量怎么样”：`environment_data_mcp`。
- “北京市 2025 年 PM2.5 年均值评价报告依据哪些标准”：`both` 或 knowledge+data depending on是否要求实际数值；不得错误只给知识库且缺实际数据说明。
- “GB 3095-2026 中 O3 限值是多少”：knowledge。
- “近 7 天某站点 NO2 小时值异常诊断”：data 或 both。

### P0-7：权威边界证据双通道构造

目标：回答“能否作为执行依据”时，同时引用具体材料和 schema/frontmatter 规则。

修改文件：

- `packages/engine/src/vault.ts`
- `packages/engine/src/search.ts`
- `packages/engine/src/types.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

具体方案：

1. `buildQuerySearchOptions()` 对 `authority_boundary_question` 不只扩大 role filter，还要保留用户问题中的目标材料关键词。

2. 在 `executeQuery()` 中，authority boundary 执行两个 retrieval pass：

- pass A：按目标材料召回具体 source/page。
- pass B：召回 schema/domain policy evidence。

3. evidence 组装时增加 `evidencePurpose`：

```ts
"target_material" | "authority_policy" | "current_basis" | "background"
```

4. 提示词中明确：

- 不能把 `draft_consultation`、`compilation_explanation`、`research_literature`、`statistics` 直接表述为强制执行依据。
- 可以说明其作为解释、背景、趋势、编制意图或辅助论证的价值。
- 如缺少现行标准证据，应声明无法仅凭该材料判断执行要求。

5. 双通道检索必须继承原始 `SearchQueryOptions` 的隔离字段：

- `scope`
- `tenantId`
- `project`
- `visibility`
- `includeDrafts/includeSuperseded`

任何 schema evidence 或额外目标材料 evidence 都不能绕过租户/项目过滤。

验收测试：

- 研究报告能否作为执法依据：必须引用报告本身和 schema/frontmatter。
- 征求意见稿能否执行：必须说明草案状态，不可当成现行要求。
- 技术指南如何用于报告：可作为方法参考，但需区分强制标准。

### P0-8：强化 SaaS 多租户和项目私有知识隔离

目标：后续客户报告进入知识库后，公共权威库、租户私有库、项目私有报告可以共同服务 agent，但不能发生证据泄露或口径污染。

修改文件：

- `packages/engine/src/search.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/context-packs.ts`
- `packages/engine/src/mcp.ts`
- `packages/engine/src/types.ts`
- `packages/engine/test/search-scope.test.ts`（新增）
- `packages/engine/test/query-scope.test.ts`（新增）
- `packages/engine/test/context-pack-scope.test.ts`（新增）

具体方案：

1. 定义统一 scope 语义：

- `public_only`：只能使用公共权威库和公共解释材料。
- `tenant_only`：只能使用指定租户私有材料。
- `project_only`：只能使用指定项目私有材料。
- `mixed_public_private`：可以同时使用公共材料、指定租户材料、指定项目材料。

2. `search.ts` 的过滤逻辑要保持现有行为，但需要补测试覆盖：

- 没有 `tenantId` 的 `tenant_only` 不应退化为全量租户检索。
- 没有 `projectId` 的 `project_only` 不应退化为全量项目检索。
- `mixed_public_private` 只能 OR 当前租户/当前项目，不能 OR 所有私有材料。

3. `vault.ts` 中所有额外 evidence 构造都要带 scope：

- authority boundary 第二次检索；
- current basis pinned evidence；
- gap fill 后的 evidence 合并；
- raw source excerpts；
- saved output 的 related source/page 追踪。

4. `buildAgentDecision()` 的 `privateKnowledgeUsed` 不应只看 `projectIds` 或 `authorityLayer === "project"`，还应看：

- `visibility === "tenant" | "project"`
- `sourceScope === "tenant_private" | "project_private" | "generated_report"`

5. 回答提示词增加私有知识边界：

- 项目私有报告可以作为该客户/该项目写作参考。
- 私有报告中的结论不能自动升级为公共标准或其他客户可复用口径。
- 当回答引用私有报告时，应在 evidenceSet 中保留 `visibility/sourceScope/tenantId`。

6. MCP 返回中建议新增：

```ts
scopeAudit?: {
  requestedScope?: QueryOptions["scope"];
  tenantId?: string;
  projectId?: string;
  privateEvidenceCount: number;
  publicEvidenceCount: number;
  warnings: string[];
};
```

验收测试：

- A 租户查询不能看到 B 租户报告。
- project_only 缺 projectId 时结果为空或明确报错。
- mixed_public_private 能同时召回公共标准和当前项目报告，但不能召回其他项目报告。
- 使用项目报告生成回答时，`agentDecision.privateKnowledgeUsed=true`。

### P0-9：提升长文档 LLM 分析容量和分段综合能力

目标：充分利用 GLM-5 200k 上下文，减少长标准、长报告、表格型 PDF 被 18k 字符截断后形成浅层概念页的问题。

修改文件：

- `packages/engine/src/analysis.ts`
- `packages/engine/src/topic-synthesis.ts`
- `packages/engine/src/config.ts`
- `packages/engine/src/types.ts`
- `packages/engine/src/domain/env-air-profile.ts`
- `packages/engine/test/analysis-long-doc.test.ts`（新增）
- `packages/engine/test/topic-synthesis.test.ts`

现有问题：

- `analysis.ts` 的 provider source analysis 初始输入上限偏小，compact retry 更小。
- 长标准中的表格、附录、质控条款和术语定义可能被截断。
- 后续 wiki synthesis 即使使用 LLM，也只能基于截断后的 concepts/entities/claims 工作。

具体方案：

1. 在 config 中增加：

```json
{
  "analysis": {
    "maxInputChars": 120000,
    "compactRetryChars": 60000,
    "longDocumentMode": "section_map_reduce"
  }
}
```

2. provider adapter 仍可按模型能力设置上限。GLM-5 200k 可配置更高，但默认值要保守，避免小模型或本地模型超限。

3. 长文档分析采用通用分段流程：

- 按标题、条款、表格、附录切分；
- 每段抽取 concepts/entities/claims/facts；
- 最后用 LLM 做 reduce，合并重复项、保留条款出处、区分强制条款和解释性材料。

4. 对环境空气 profile，source-analysis prompt 要强调：

- 优先抽取可跨文档复用的专业概念，不要把文件标题、目录标题、公告标题当作概念。
- 标准类文件要保留适用范围、实施状态、限值、公式、数据有效性、质控要求。
- 统计报告要保留统计期、区域/城市覆盖、指标口径和趋势结论。
- 编制说明/草案只作为演化和解释材料。

5. long document mode 的输出必须记录 provenance：

```ts
analysisSegments?: Array<{
  id: string;
  heading?: string;
  charStart: number;
  charEnd: number;
  providerId: string;
}>;
```

验收测试：

- 构造超过默认上限的 synthetic 标准，关键条款位于后半部分，仍能被抽取和检索。
- 长统计报告中的城市数量、统计期、污染物趋势不会因截断丢失。
- long document mode 不增加 heuristic fallback。

### P1-1：结构化事实抽取增强为“事实族”，不是单标准补丁

目标：让运行质控、采样方法、统计口径、标准状态等事实更容易被检索和引用。

修改文件：

- `packages/engine/src/domain/env-air-facts.ts`
- `packages/engine/src/search.ts`
- `packages/engine/test/env-air-facts.test.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

具体方案：

1. 保持现有 fact kind 兼容，不轻易新增大量枚举。优先强化：

- `technical_parameter`
- `validity_rule`
- `formula`
- `status_rule`
- `method_step`
- `limit_value`

2. 为事实增加通用 `qualifiers/searchTerms`：

- 质控类：零点、量程、漂移、噪声、示值误差、转换炉效率、平行性、比对测试、校准。
- 数据有效性：有效小时、有效日、有效月、有效年、缺测、负值、异常值、审核。
- 统计口径：城市数量、评价城市、国控点、统计时段、同比/环比、百分位。
- 标准状态：实施日期、替代、废止、修改单、征求意见。

3. fact extraction 不根据单个标准号判断，而根据标题、条款上下文、表格标题、术语族判断。

4. structured fact snippet 应保留条款号、表号、公式号和原文片段，便于回答引用。

验收测试：

- 对 synthetic “气态污染物运行质控标准”和 “颗粒物运行质控标准” 均能抽出 technical_parameter/validity_rule。
- 统计报告中的城市数量变化可作为 statistics evidence 命中。
- 修改单中的替代表述可作为 status_rule 命中。

### P1-2：优化 LLM wiki 构建提示词，鼓励跨文档专家综合

目标：减少单文档摘要式概念页，形成有机的专业 wiki。

修改文件：

- `packages/engine/src/domain/env-air-profile.ts`
- `packages/engine/src/topic-synthesis.ts` 或当前 topic synthesis 所在文件
- `packages/engine/src/analysis.ts`
- `packages/engine/test/topic-synthesis.test.ts`

提示词优化原则：

1. 概念页不是文档摘要，必须综合多个来源。
2. 按证据角色分层表达：

- 现行强制/规范依据；
- 技术方法和落地操作；
- 统计证据和背景趋势；
- 演化材料；
- 地方适配；
- 项目私有报告经验。

3. 不得把研究论文、白皮书、统计公报中的建议表达为法定要求。
4. 对同一主题下标准和指南冲突时，应以 `legalStatus/current_effective` 和 `authorityLayer` 为准。
5. 输出概念页应包含：

- 适用场景；
- 执行依据；
- 方法/口径；
- 常见误用；
- 需要调数据 MCP 的边界；
- 相关标准族和相关页面。

建议将 `topicSynthesisPromptLines` 改为领域 profile 驱动模板，不在 topic synthesis 代码里写死环境空气内容。

验收测试：

- `臭氧污染协同控制` 概念页应同时整合标准限值、统计报告、技术指南/研究综述，并区分权威级别。
- `环境空气质量评价` 概念页不应只堆 `GB 3095/HJ 663`，还应说明评价期、有效数据、AQI 报告边界。
- `采样罐 QA/QC` 不应吞并全部 VOCs 文件，而应聚焦采样/保存/分析质控链。

### P1-3：增强 deep lint 的确定性质量诊断

目标：让测试报告可以直接定位“源码问题、数据源问题、配置问题、历史输出问题”。

修改文件：

- `packages/engine/src/deep-lint.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/types.ts`
- `packages/cli/src/index.ts`
- `packages/engine/test/deep-lint.test.ts`

新增 finding code：

- `retrieval_stale_at_query_time`
- `knowledge_label_key_collision`
- `ascii_slug_collision_risk`
- `overbroad_aggregate_page`
- `document_title_candidate`
- `prompt_residue_candidate`
- `empty_extraction_source`
- `ocr_candidate_source`
- `authority_boundary_missing_target_material`
- `tool_routing_ambiguous`
- `graph_node_without_page`

CLI 增强：

```powershell
swarmvault lint --deep --json
swarmvault lint --deep --category retrieval
swarmvault lint --deep --category candidates
swarmvault lint --deep --category authority
```

如果当前 CLI 不适合一次加全部参数，可先实现 `--json` 和分类字段，后续再加 category filter。

验收测试：

- deep lint 不因 LLM provider 返回枚举外 code 而中断。未知 code 应归一到 `follow_up_question` 或 `coverage_gap`，并保留 raw code warning。
- deterministic findings 即使 LLM deep lint 失败也能输出。
- JSON 输出可被测试脚本稳定消费。

### P1-4：Graph explain 的 page linking 和 alias canonicalization

目标：解决 `Page: none` 以及标准/概念别名分裂问题。

修改文件：

- `packages/engine/src/graph-query-core.ts`
- `packages/engine/src/graph-export.ts`
- `packages/engine/src/domain/standard-relations.ts`
- `packages/engine/src/domain/env-air.ts`
- `packages/engine/test/graph-query.test.ts`

具体方案：

1. 为 graph node 增加 canonical page resolution：

- 如果 node id 对应 active concept/entity page，返回 page path。
- 如果只存在 alias，返回 canonical page。
- 如果是标准编号 alias，映射到标准 identity page 或 source page。

2. 对污染物缩写、标准编号、地方标准编号建立 profile-aware alias map。

3. `graph explain` 输出：

```ts
{
  nodeId,
  canonicalLabel,
  pagePath?: string,
  aliasOf?: string,
  sourceIds: string[]
}
```

验收测试：

- `环境空气质量评价` explain 不应出现 `Page: none`，除非确实没有对应页，并应说明 fallback source。
- `GB3095`、`GB 3095-2026`、`环境空气质量标准` 能指向同一标准 identity。

### P1-5：空提取 source 的诊断和显式 OCR 流程

目标：治理 `empty=3`，但不把 OCR 风险混入权威证据。

修改文件：

- `packages/engine/src/ingest.ts`
- `packages/engine/src/extraction.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/types.ts`
- `packages/cli/src/index.ts`
- `packages/engine/test/extraction.test.ts`

具体方案：

1. analysis status 增加 empty 分类细节：

```powershell
swarmvault analysis status --show empty
```

输出：

- source id；
- 文件路径；
- capture type；
- 提取器；
- 文件大小；
- 是否可能为扫描 PDF；
- 建议动作。

2. 增加显式 OCR 选项：

```json
{
  "extraction": {
    "ocr": {
      "enabled": false,
      "provider": "vision-provider-id",
      "markProvenance": true
    }
  }
}
```

3. OCR 结果写入 source analysis 时标记：

- `extractionMode: "ocr"`
- `ocrConfidence`
- `warnings: ["ocr_extracted_text_requires_review"]`

4. query evidence 中可显示 OCR provenance，回答不得把低置信 OCR 当成唯一强依据。

验收测试：

- 空 PDF 不再静默进入空 source。
- OCR disabled 时给出明确诊断。
- OCR enabled 时 evidence 带 provenance。

### P2-1：标准 identity 和关系模型统一

目标：长期支持新标准、修改单、替代关系、地方标准关系。

修改文件：

- `packages/engine/src/domain/standard-relations.ts`
- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/domain/env-air-profile.ts`
- `packages/engine/src/search.ts`
- `packages/engine/test/standard-relations.test.ts`

具体方案：

1. 建立标准 identity normalize 模块，统一：

- `GB 3095`
- `GB3095`
- `GB 3095-2026`
- `HJ/T 193`
- `DB11/T xxx`

2. 支持 relation：

- `replaces`
- `replacedBy`
- `amends`
- `implements`
- `references`
- `localizes`

3. search index 和 facts 表都使用 canonical identity，同时保留原始标准号。

4. query plan 通过 identity 查 cluster，而不是字符串 contains。

验收测试：

- 问历史版本和现行版本差异时，可以召回现行标准、历史标准、修改单/编制说明。
- 地方标准不会覆盖国家标准，但可作为地方适配 evidence。

### P2-2：质量报告和回归测试命令

目标：每次完整重构后能稳定判断是否变好。

修改文件：

- `packages/cli/src/index.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/types.ts`
- `packages/engine/test/quality-report.test.ts`

新增命令建议：

```powershell
swarmvault quality report --json
swarmvault quality report --domain env-air-public
```

报告内容：

- source analysis 分布：provider/heuristic/empty/fallback。
- retrieval 状态：fresh/stale/schema ok。
- 候选页噪声率。
- 超大聚合页。
- slug collision。
- authority layer 分布。
- documentRole/legalStatus unknown 比例。
- deep lint findings 按类别统计。
- golden query 通过率。

验收标准：

- 完整重构后无需人工拼多个命令即可判断质量变化。
- 报告可落盘到 `D:\kb\env-public\tests\`。

## 5. 数据源清理建议

源码修改不能完全替代数据源治理。当前应进行但不要过度的清理：

1. 对 3 个 `empty_extraction_source` 单独检查文件是否扫描版、损坏、加密或空文件。
2. 不建议因为 heuristic fallback 历史问题批量删除文件；当前完整编译已经 `fallback=0`。
3. 对文件名明显不表达主题的材料，可以保留原文件，但在 source metadata 或 ingest manifest 中补充 title/role。
4. 对草案、编制说明、修改单、历史版本，不要移动到 core；应放入 evolution 或通过 metadata 标记。
5. 对地方文件，应保留地区信息，避免地方口径被当作全国通用要求。
6. 对统计报告，应标注统计期、发布机构、覆盖城市/站点口径。

## 6. 实施顺序

建议按以下顺序落地，避免大改后难以定位问题：

### 第一批 P0：查询可靠性、隔离安全与聚合正确性

1. P0-1 retrieval freshness check。
2. P0-2 中文知识项聚合 key。
3. P0-3 统一候选质量评分。
4. P0-8 SaaS 多租户和项目私有知识隔离。

完成后立即执行：

```powershell
pnpm --filter @swarmvaultai/engine typecheck
pnpm --filter @swarmvaultai/cli typecheck
pnpm --filter @swarmvaultai/engine test -- retrieval knowledge-quality knowledge-slug search-scope query-scope context-pack-scope
```

然后完整重构知识库，重点看：

- stale query 是否消失；
- 超大聚合页是否减少；
- slug collision 是否减少；
- A/B 租户和项目私有材料是否严格隔离；
- fallback 是否仍为 0。

### 第二批 P0：LLM 分析容量和领域 profile

1. P0-4 profile intent/ranking 扩展。
2. P0-9 长文档 LLM 分析容量和分段综合。
3. P1-2 LLM wiki 构建提示词优化可以在这一批先落地核心部分，因为它直接影响下一次完整重构质量。

完成后执行：

```powershell
pnpm --filter @swarmvaultai/engine test -- env-air-intents analysis-long-doc topic-synthesis
```

然后必须完整重构知识库，因为这一批会改变 source analysis 和 wiki synthesis 结果。

### 第三批 P0：业务检索、工具路由和权威边界

1. P0-5 profile-driven search ranking。
2. P0-6 DeerFlow 工具路由。
3. P0-7 authority boundary 双通道证据。

完成后执行：

```powershell
pnpm --filter @swarmvaultai/engine test -- env-air-retrieval env-air-tool-routing
```

然后运行全盘测试，重点看：

- HJ 817/HJ 818 类运行质控是否稳定；
- 统计公报类问题是否不再被无关标准压过；
- “今天 + 城市 + 空气质量”是否推荐环境数据 MCP；
- 权威边界回答是否同时引用具体材料和 schema。

### 第四批 P1/P2：质量治理和长期维护

1. P1-1 事实族增强。
2. P1-3 deep lint 结构化诊断。
3. P1-4 graph explain。
4. P1-5 empty/OCR 诊断。
5. P2-1 标准关系模型统一。
6. P2-2 quality report。

完成后执行完整回归：

```powershell
pnpm --filter @swarmvaultai/engine typecheck
pnpm --filter @swarmvaultai/cli typecheck
pnpm --filter @swarmvaultai/engine test
pnpm --filter @swarmvaultai/cli test
pnpm --filter @swarmvaultai/engine build
```

## 7. 完整知识库重构与验证命令

源码修改完成后，在 `D:\kb\env-public\vault` 下执行：

```powershell
cd D:\kb\env-public\vault

node D:\Github\swarmvault\packages\cli\dist\index.js compile --force-analysis --fail-on-fallback
node D:\Github\swarmvault\packages\cli\dist\index.js retrieval status
node D:\Github\swarmvault\packages\cli\dist\index.js lint
node D:\Github\swarmvault\packages\cli\dist\index.js lint --deep
node D:\Github\swarmvault\packages\cli\dist\index.js analysis status
```

如果新增 `quality report` 后，再执行：

```powershell
node D:\Github\swarmvault\packages\cli\dist\index.js quality report --json > D:\kb\env-public\tests\env-public-quality-report-latest.json
```

关键验收指标：

1. `fallback=0`。
2. `empty` 只保留真实空提取/OCR 待处理源，不混入 LLM 失败。
3. retrieval state 为 `fresh`。
4. `aggregate_page_too_large` 显著下降。
5. `knowledge_slug_collision` 或新 collision finding 显著下降。
6. 工具路由 golden set 通过。
7. 权威边界类回答不把解释性材料当成强制依据。
8. 统计报告类问题能召回 statistics evidence。
9. 运行质控类问题能召回对应标准族和具体条款。
10. wiki 概念页不再明显表现为单文档模板摘要。
11. 多租户/项目 scope 测试通过，private evidence 不跨租户泄露。
12. 长文档后半部分关键条款能进入 source analysis、structured facts 和检索 evidence。

## 8. 风险与控制

### 8.1 自动 repair 可能增加首次 query 耗时

控制方式：

- 只在 stale/missing/schema mismatch 时 repair。
- `retrievalDebug` 返回 repair 信息。
- CI 可配置 `queryStalePolicy=error`。

### 8.2 搜索 boost 扩展可能导致过召回

控制方式：

- boost 使用软排序，不做硬过滤。
- pinned standards 和 clusters 设置 evidence 上限。
- debug 输出命中信号，便于回归。

### 8.3 候选质量过滤可能误伤专业短名

控制方式：

- 短缩写判断走 profile 的 term aliases 和 short label taxonomy。
- 降级为 `candidate_only/index_only` 优先于直接 reject。
- deep lint 输出原因，便于调整 profile。

### 8.4 OCR 可能引入错误文本

控制方式：

- 默认关闭 OCR。
- OCR evidence 必须标 provenance。
- 低置信 OCR 不作为唯一强依据。

### 8.5 DeerFlow 兼容性风险

控制方式：

- 不删除现有 MCP 返回字段。
- 新增字段保持 optional。
- `recommendedNextTool`、`agentDecision.mustCallTools` 语义保持稳定。
- 增加 DeerFlow 侧集成测试样例。

### 8.6 多租户证据泄露风险

控制方式：

- 所有检索入口和二次检索都复用同一个 scope filter builder。
- 缺少 `tenantId/projectId` 时 fail closed，不退化为全量查询。
- `retrievalDebug` 和 `scopeAudit` 输出 public/private evidence 计数。
- golden test 中构造 A/B 租户交叉污染用例。

### 8.7 长文档分析成本和质量风险

控制方式：

- long document mode 默认可配置，不强制所有 vault 开启最大上下文。
- 分段 reduce 需要去重和 provenance，避免重复 claim 膨胀。
- 对 GLM-5 使用较大上下文时记录 token/usage，便于评估成本。
- 长文档分析失败时应保留 provider failure trail，不能静默变成 heuristic。

## 9. 最终建议

下一轮应优先执行 P0-1 至 P0-9。尤其是 retrieval freshness、中文聚合 key、统一候选质量、profile-driven search ranking、工具路由、多租户隔离和长文档 LLM 分析容量，这几类会反复影响公共知识库和后续 SaaS 项目私有库的基础能力。

数据源清理只应作为并行动作处理 3 个 `empty` 源和明显目录错误，不应把源码问题转移为人工维护负担。当前最重要的方向是让源码支持“环境空气领域知识作为 profile 配置和 query plan 流动”，而不是继续在检索、回答、lint、候选页晋升里分散写业务特例。

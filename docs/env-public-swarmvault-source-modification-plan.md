# 环境空气公共知识库 SwarmVault 源码改造方案

生成时间：2026-04-28  
复核打磨时间：2026-04-28  
分析对象：`D:\Github\swarmvault`  
业务 Vault：`D:\kb\env-public\vault`  
原始资料：`D:\kb\env-public\raw`

## 1. 结论摘要

当前 SwarmVault 的工程基础可以完成“文件导入、文本抽取、基础 wiki 页面、图谱、FTS 检索、MCP 工具、上下文包”的闭环，但第一轮公共知识库编译结果还不能作为环境空气污染业务的专业知识库交付版使用。

核心原因不是资料本身不足，而是当前源码仍按通用知识库和代码知识库的假设运行：

- Source 分析结构过于通用，只支持 `summary/concepts/entities/claims/questions/tags`，无法原生保存“效力状态、现行依据、地方适用、征求意见稿、替代关系、污染物、标准号”等业务元数据。
- GLM-5 provider 当前只支持从环境变量读取 API key，且 `chat/completions` 的结构化输出请求与京东云 GLM-5 返回 `400 Bad Request`。编译阶段大量静默回退到 heuristic 分析。
- 当前编译结果中 997 个 source 分析里，966 个高度疑似 heuristic 回退；997 个分析全部 `tags` 为空。
- 生成了 2927 个 candidate 概念/实体，但 0 个 active concept，0 个 active entity。按规则抽样判断，2699 个 candidate 明显是数字、单位、公式残片或泛化英文短词。
- 图谱社区、god nodes、相似边主要被年份、数字、单位和 OCR/公式残片驱动，不能支撑专业专题检索。
- 聚合页是确定性模板，不是 LLM 专家综述，因此无法把 GB、HJ、编制说明、月报、论文、征求意见稿、地方口径有机综合到同一个专题页面。
- MCP 和 `query_vault` 的回答提示词仍是通用模式，不能稳定执行“现行依据优先、草案不得作为执行依据、地方文件只在本地区适用、报告写作要区分依据和证据”的业务规则。

因此建议先不要直接开展下一轮“同配置重新编译”。应先完成 Provider 兼容、分析结构扩展、噪声过滤、专题合成、检索排序、MCP 专用工具和质量门禁改造，再清空或刷新分析缓存后重新构建公共知识库。

### 1.1 本轮复核后的关键修正

结合 `sage-wiki`、`llm-wiki-compiler`、`llmwiki` 的实现后，本方案需要补充几个工程边界，否则即使提示词质量提高，也可能在生产环境里出现不可控风险：

- 不应把“环境空气业务逻辑”直接硬编码进 SwarmVault 核心引擎。更合理的方向是把 SwarmVault 改成支持 domain profile、prompt pack、ranking policy、metadata schema 的通用引擎，再为本项目挂载 `env-air` 业务配置。这样既满足环保局项目，又不会把通用开源能力污染成单行业代码。
- 不应让 LLM 专题合成结果直接覆盖 active wiki。环境空气领域涉及法律、标准、草案、地方口径和客户报告，必须借鉴 `llm-wiki-compiler` 的 candidate/review 机制：先生成候选页，完成引用校验、权威性校验和人工抽检后再晋升。
- 不应把 200k 上下文窗口理解成“可以一次把所有材料塞给模型”。正确做法是先做 chunk-level 检索、标准号和主题强召回、RRF 融合、可选 rerank，再把受控证据包交给 LLM 综合。
- 不应只优化 `query_vault` 的最终回答提示词。真正影响回答质量的是检索前的 query expansion、检索中的权威性排序、context pack 的 must-include 规则，以及回答阶段对“现行依据/证据解释/历史演化/地方适配/项目私有材料”的优先级约束。
- 不应在公共知识库阶段忽视 SaaS 私有报告的未来接入。公共标准、地方文件、客户报告、自动生成报告必须提前设计隔离字段和查询 scope，否则后续很容易出现跨客户泄露、客户报告反过来覆盖公共依据、过期报告被当作现行口径的问题。

### 1.2 参考项目对本方案的启发和取舍

`sage-wiki` 的主要启发：

- 它的检索不是单纯 page-level FTS，而是 chunk-level BM25、向量检索、LLM query expansion、RRF 融合、LLM rerank、graph expansion、token budget 的组合管线。SwarmVault 当前检索更接近“页面搜索”，对法规标准、限值、技术术语这种短强信号场景不够。
- 它支持 tiered compilation 和 compile-on-demand。对本项目的意义是：公共核心依据可以高质量全量编译，低频历史材料、研究资料和后续项目报告可以按热度、查询命中和业务任务动态提升，而不是每次都做全量专家合成。
- 它把 prompt 作为可配置模板，而不是散落在代码里。SwarmVault 后续应把 `env-air` 的分析、合成、问答、deep lint 提示词放进 vault 或 profile 配置，便于环保业务人员迭代。

`llm-wiki-compiler` 的主要启发：

- 两阶段编译先抽取概念，再生成页面，可以减少顺序依赖，避免某个源文件失败后写出半成品页面。
- `compile --review` 候选队列、approve/reject 锁、source state 延迟落盘，适合本项目的“专家知识库”场景。标准和报告合成页不应无审核进入 active。
- claim-level provenance 和 lint 引用校验很适合环境标准。限值、适用范围、实施日期、替代关系必须可回到源文件和段落/页码，而不是只在 frontmatter 里列一个文件名。

`llmwiki` 的主要启发：

- 文件系统是事实源，SQLite/索引是可重建派生物。SwarmVault 应继续保持 raw/source/wiki 可审计，检索索引、chunk 索引、图谱索引可以重建。
- 一个 workspace 对应一个 MCP 服务，有利于上下文隔离。未来 SaaS 私有报告知识库应采用 public vault + tenant/project vault 的明确边界，而不是把所有客户材料混在一个全局 vault 里。
- 它的 hosted 版本有租户隔离测试、引用图谱、路径逃逸测试。SwarmVault 接入 deer-flow 前，也应增加 MCP 层的 scope、ACL 和泄露回归测试。

## 2. 本次实际测试验证

### 2.1 源码侧验证

在 `D:\Github\swarmvault` 执行：

```powershell
pnpm --filter @swarmvaultai/engine typecheck
pnpm --filter @swarmvaultai/engine exec vitest run test/retrieval.test.ts test/context-packs.test.ts test/provider-registry.test.ts test/openai-compatible-capabilities.test.ts
pnpm --filter @swarmvaultai/cli exec vitest run test/notices.test.ts
pnpm --filter @swarmvaultai/engine build
```

结果：

- Engine typecheck 通过。
- Engine 相关 4 个测试文件、14 个测试用例通过。
- CLI notice 测试 7 个测试用例通过。
- Engine build 通过。

说明：基础工程、检索索引、上下文包、Provider 注册机制和构建脚本本身可运行。下面的问题主要是“业务知识质量”和“GLM-5 兼容性”，不是 TypeScript 编译失败。

### 2.2 Vault 结构和索引健康

执行：

```powershell
cd /d D:\kb\env-public\vault
node D:\Github\swarmvault\packages\cli\dist\index.js retrieval status --json
node D:\Github\swarmvault\packages\cli\dist\index.js lint --no-deep --json
```

结果：

- Retrieval status 为 fresh。
- Index 存在：`D:\kb\env-public\vault\state\retrieval\fts-000.sqlite`
- Manifest 存在：`D:\kb\env-public\vault\state\retrieval\manifest.json`
- Graph 存在。
- Page count：3953。
- Shard count：1。
- 浅层 lint 仅报告 orphan page 信息，没有阻断性错误。

图谱统计：

```json
{
  "sources": 997,
  "pages": 3953,
  "nodes": 3924,
  "edges": 28997,
  "hyperedges": 520,
  "communities": 17,
  "pagesByKind": {
    "source": 997,
    "concept": 1641,
    "entity": 1286,
    "insight": 1,
    "graph_report": 2,
    "community_summary": 17,
    "index": 9
  },
  "pagesByStatus": {
    "active": 1026,
    "candidate": 2927
  }
}
```

### 2.3 GLM-5 provider 行为

执行：

```powershell
cd /d D:\kb\env-public\vault
node D:\Github\swarmvault\packages\cli\dist\index.js query "PM2.5 24小时平均限值是多少，现行依据是什么" --no-save --json
node D:\Github\swarmvault\packages\cli\dist\index.js lint --deep --json
```

结果均失败：

```json
{"error":"Provider glm5-jd failed: 400 Bad Request"}
```

当前配置：

```json
{
  "providers": {
    "glm5-jd": {
      "type": "openai-compatible",
      "model": "glm-5",
      "baseUrl": "https://modelservice.jdcloud.com/coding/openai/v1",
      "apiKeyEnv": "JD_GLM_API_KEY",
      "apiStyle": "chat",
      "capabilities": ["chat", "structured"]
    }
  }
}
```

源码事实：

- `packages/engine/src/config.ts` 只允许 `apiKeyEnv`。
- `packages/engine/src/providers/registry.ts` 只通过 `process.env[name]` 读取密钥。
- `packages/engine/src/providers/openai-compatible.ts` 在 chat 结构化输出时固定发送：

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "type": "json_schema",
      "name": "swarmvault_response",
      "schema": "...",
      "strict": true
    }
  }
}
```

风险判断：

- 京东云 GLM-5 可能不支持 OpenAI strict `json_schema` 格式，或者期望 `json_object`、普通 JSON prompt、不同字段形态。
- 当前错误只返回 `400 Bad Request`，源码没有打印响应 body，无法快速判断是 key、模型名、字段、token 参数还是 schema 问题。
- 编译阶段 `analyzeSource` 捕获 provider 异常后静默回退到 heuristic，导致“编译成功”掩盖了“LLM 构建基本没发生”。

### 2.4 分析缓存质量

对 `D:\kb\env-public\vault\state\analyses` 统计：

```json
{
  "total": 997,
  "heuristicLikely": 966,
  "emptyTags": 997,
  "genericConceptDescription": 966,
  "genericQuestions": 966,
  "zeroConcepts": 31,
  "zeroEntities": 129
}
```

典型 heuristic 特征：

- Concept description 为 `Frequently referenced concept in ...`
- Question 为 `How does 2020 relate to ...`
- Concepts 包含 `2020`、`30000`、`39793`、`pm10`、`nmol` 等。
- Entities 包含公式残片和 OCR 残片，例如 `= n i`、`{ N O`、`Q n n`。

判定：第一轮编译的“source 页面”主要是文本抽取摘要，不是专家式 LLM 分析。

### 2.5 Candidate 噪声

统计：

```json
{
  "candidateCount": 2927,
  "activeConcepts": 0,
  "activeEntities": 0,
  "noiseCandidateCount": 2699,
  "noiseBuckets": {
    "numeric": 752,
    "mostly_ascii_short": 1818,
    "formula_or_generic": 53,
    "short": 76
  }
}
```

典型噪声：

- `concept:0000`
- `concept:010-67112738`
- `concept:1000`
- `entity:n`
- `entity:n-i`
- `entity:item`
- `entity:n-o`
- `entity:co`
- `concept:mmol`
- `concept:nmol`

`candidate preview-scores` 显示大量明显噪声已经满足 sources、confidence、agreement、degree 四个门槛，只因为 age 小于 24 小时暂未晋升。后续如果启用 auto-promote，存在把噪声晋升为 active 概念页的高风险。

### 2.6 图谱质量

`graph god-nodes --limit 20` 结果前列包括：

```text
Co degree=1346 bridge=14
= n 规范值 degree=989 bridge=14
Technical degree=821 bridge=14
-Determination degree=818 bridge=13
2017 degree=661 bridge=13
1000 degree=573 bridge=12
vocs degree=570 bridge=12
Ambient degree=547 bridge=12
nmol degree=326 bridge=11
```

社区示例：

- `community:2010-6`，label `2010`，size 593。
- `community:1000-4`，label `1000`，size 511。
- `community:10mg-10`，label `10mg`，size 393。
- `community:50-100-3`，label `50-100`，size 207。

边统计：

```json
{
  "edges": 28997,
  "edgeTypes": {
    "mentions": 9315,
    "conflicted_with": 61,
    "semantically_similar_to": 19620,
    "contradicts": 1
  },
  "evidence": {
    "extracted": 9315,
    "ambiguous": 62,
    "inferred": 19620
  }
}
```

判定：当前图谱被通用 token overlap 和噪声概念驱动。图谱结构存在，但专业语义不足。

### 2.7 检索测试

执行：

```powershell
node D:\Github\swarmvault\packages\cli\dist\index.js graph query "GB 3095 PM2.5 24小时平均" --budget 12
node D:\Github\swarmvault\packages\cli\dist\index.js graph query "地方标准" --budget 12
node D:\Github\swarmvault\packages\cli\dist\index.js graph query "非甲烷总烃自动监测 编制说明" --budget 12
```

结果：

- `GB 3095 PM2.5 24小时平均` 可以召回 `2012_环境空气质量标准_GB3095-2012`，但同时带出大量 `spearman`、`ambient`、`n-i` 等噪声。
- `地方标准` 返回 `Seeds: none`。
- `非甲烷总烃自动监测 编制说明` 返回 `Seeds: none`。

用 `searchVault` 测试：

- `2025年12月全国城市空气质量月报` 没有把精确的 2025 年 12 月月报排在第一，反而排到了若干 2025 年标准和其他月份月报之后。
- `PM2.5 24小时平均限值` 能召回 HJ 663、GB 3095 编制说明、月报、监测方法，但未稳定把现行 GB 3095 标准置顶。
- `地方标准`、`征求意见稿 现行依据` 无结果。
- `HJ 653` 可正确召回 `HJ 653-2021`，但混入大量编制说明和旧版文件，缺少“现行优先”的排序。

### 2.8 上下文包测试

执行：

```powershell
node D:\Github\swarmvault\packages\cli\dist\index.js context build "城市环境空气质量评价现行依据和PM2.5限值" --target "GB 3095 PM2.5 24小时平均" --budget 2500 --format json --json
```

生成：

- `D:\kb\env-public\vault\state\context-packs\2026-04-28T06-52-13-206Z-pm2-5.json`
- `D:\kb\env-public\vault\wiki\context\2026-04-28T06-52-13-206Z-pm2-5.md`

结果摘要：

- Included items：7。
- Omitted items：46。
- Included 中有 candidate `3095` 和 HJ663、GB3095 编制说明、HJ633、HJ664 等。
- `2012_环境空气质量标准_GB3095-2012` 源页面因 token budget 被 omitted。

判定：上下文包机制对 agent 有价值，但当前排序和预算分配会让“核心标准正文”被挤出上下文。需要权威性优先、精确标题优先和业务意图优先。

## 3. 根因定位

### 3.1 Provider 兼容性和密钥配置不足

涉及文件：

- `packages/engine/src/types.ts`
- `packages/engine/src/config.ts`
- `packages/engine/src/providers/registry.ts`
- `packages/engine/src/providers/openai-compatible.ts`
- `packages/cli/src/index.ts`

问题：

- 只支持 `apiKeyEnv`，不支持文件内配置、私有 secrets 文件、API key file。
- OpenAI-compatible chat 结构化输出只有一种 `json_schema` 请求形态。
- Provider 错误不读取 response body，无法定位第三方服务兼容问题。
- 没有 `provider test` 命令，不能在大规模 compile 前做 smoke test。
- `analyzeSource` 静默 fallback，用户难以及时发现实际没有使用 LLM。

### 3.2 SourceAnalysis 缺少业务元数据

涉及文件：

- `packages/engine/src/types.ts`
- `packages/engine/src/analysis.ts`
- `packages/engine/src/markdown.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/search.ts`
- `packages/engine/src/mcp.ts`

当前结构：

```ts
export interface SourceAnalysis {
  title: string;
  summary: string;
  concepts: AnalyzedTerm[];
  entities: AnalyzedTerm[];
  claims: SourceClaim[];
  questions: string[];
  tags: string[];
}
```

不足：

- `swarmvault.schema.md` 虽然要求识别 `authority_layer/legal_force/document_role/legal_status/jurisdiction`，但这些字段没有落盘位置。
- 只能把元数据挤进 summary、claims、tags，后续检索无法结构化过滤。
- 无法做“现行有效优先”“草案只用于演化”“地方只在本地区适用”。

### 3.3 概念和实体抽取不适合中文环境标准 PDF

涉及文件：

- `packages/engine/src/analysis.ts`
- `packages/engine/src/tokenize.ts`
- `packages/engine/src/graph-enrichment.ts`

问题：

- heuristic 依赖 compromise 和英文 token，对中文 PDF、标准号、公式、单位、表格残片非常不友好。
- 没有环境业务 allowlist/denylist。
- 没有对年份、页码、单位、浓度值、公式变量、CAS 号、电话号码、OCR 残片做分类型处理。
- 结果直接进入概念、实体、候选页和图谱，噪声被放大。

### 3.4 聚合页不是专家 wiki

涉及文件：

- `packages/engine/src/markdown.ts`
- `packages/engine/src/vault.ts`

`buildAggregatePage` 当前只是：

- 取第一个 description 作为 summary。
- 列出 Seen In。
- 用字符串包含关系抽取 Source Claims。

它不会：

- 判断资料效力。
- 对比现行标准和历史版本。
- 把编制说明作为解释材料。
- 把月报作为统计证据。
- 把研究文献作为机理证据。
- 对一个专题输出专家综述结构。

这与公共知识库目标“不是每个文档单独一个概念页，而是相关文档有机整合”不一致。

### 3.5 检索排序缺少业务意图和权威性

涉及文件：

- `packages/engine/src/search.ts`
- `packages/engine/src/retrieval.ts`
- `packages/engine/src/embeddings.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/context-packs.ts`

问题：

- FTS 表没有 domain metadata 字段。
- `searchPages` 排序固定为 active/source 优先，再按 BM25，不理解“标准号精确命中”“现行依据”“地区限定”“草案演化问题”等意图。
- `hybrid` 配置为 true，但当前 GLM-5 provider 没有 embeddings 能力，也没有独立 embedding provider，因此语义检索实际不起作用。
- `rerank` 依赖 queryProvider，而 queryProvider 当前 GLM-5 structured/text 请求失败，无法稳定 rerank。
- context pack 只按 graph/search 分数和 token budget 裁剪，没有强制保留核心依据。

### 3.6 MCP 工具过于通用

涉及文件：

- `packages/engine/src/mcp.ts`
- `packages/engine/src/context-packs.ts`
- `packages/engine/src/vault.ts`

当前 MCP 工具包括 `search_pages`、`query_graph`、`query_vault`、`build_context_pack` 等，适合作为通用 vault 工具，但对环保局环境空气业务不够直接：

- 没有“查现行执行依据”的专用工具。
- 没有“版本演化和替代关系”的专用工具。
- 没有“地方适配”的专用参数。
- 没有“报告写作上下文包”的专用输出。
- 没有对 deer-flow 的环境监测数据 MCP 结果进行联合回答的提示词约束。

## 4. 源码改造总路线

建议按 7 个阶段推进。每个阶段完成后都可独立验证。

1. Provider 和配置可靠化。
2. Source 分析结构和质量门禁升级。
3. PDF/中文/环境术语噪声治理。
4. 多文档专题候选合成和审核。
5. 检索、图谱、chunk 索引和上下文包业务排序。
6. MCP/deer-flow 专用工具和提示词。
7. 自动化 golden tests 和重建流程。

推进时需要坚持三条横向原则：

- 环境空气能力以 domain profile 形式挂载，不直接把行业规则写死在通用引擎主流程里。引擎提供扩展点，`env-air` 提供 schema、prompt、术语表、排序策略和质量门禁。
- LLM 生成内容先进入 review/candidate 状态。只有通过引用校验、质量门禁和必要人工抽检的页面，才允许成为 active 专题页。
- 检索和回答链路要先保证“找对依据”，再优化“写得像专家”。权威性排序、标准号召回、chunk 级证据和 context pack must-include 比单纯调回答 prompt 更重要。

## 5. 阶段 1：Provider 和配置可靠化

### 5.1 配置结构改造

修改 `packages/engine/src/types.ts`：

```ts
export interface ProviderConfig {
  type: ProviderType;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  apiKeyFile?: string;
  headers?: Record<string, string>;
  apiStyle?: "responses" | "chat";
  structuredOutputMode?: "json_schema" | "json_object" | "prompt_json";
  maxRetries?: number;
  timeoutMs?: number;
  debugProviderErrors?: boolean;
}
```

修改 `packages/engine/src/config.ts` 的 `providerConfigSchema`，增加同名字段。

推荐新增私有 secrets 文件支持：

```json
{
  "providers": {
    "glm5-jd": {
      "apiKey": "实际 key"
    }
  }
}
```

文件建议：

- `swarmvault.secrets.json`
- 自动加入 `.gitignore`
- 不写入 graph、session、compile state

安全要求：

- 不建议在 `swarmvault.config.json`、`swarmvault.schema.md` 或任何会提交到 Git 的文件中直接写 `apiKey`。
- `swarmvault.secrets.json` 创建时应检查并提示文件权限；在 Windows 上至少确认文件不位于公共同步目录，且默认加入 vault 根目录 `.gitignore`。
- provider debug log 只能打印 header 名称、baseUrl、model、状态码和响应 body 摘要，不得打印完整 key。
- 后续 SaaS 部署应改用平台 secret manager 或数据库加密字段，文件密钥只适合本地公共知识库构建阶段。

密钥优先级建议：

1. `apiKey`，只建议放在 `swarmvault.secrets.json`。
2. `apiKeyFile`。
3. `apiKeyEnv`。

### 5.2 Provider registry 改造

修改 `packages/engine/src/providers/registry.ts`：

- 新增 `resolveProviderSecret(rootDir, providerId, config)`。
- 支持读取 `swarmvault.secrets.json`。
- 支持相对路径 `apiKeyFile`。
- 如果 provider 需要 API key 但未配置，抛出明确错误。

建议错误信息：

```text
Provider glm5-jd has no API key. Configure one of apiKeyEnv, apiKeyFile, or swarmvault.secrets.json providers.glm5-jd.apiKey.
```

### 5.3 OpenAI-compatible adapter 改造

修改 `packages/engine/src/providers/openai-compatible.ts`：

新增结构化输出模式：

```ts
type StructuredOutputMode = "json_schema" | "json_object" | "prompt_json";
```

chat 模式请求策略：

- `json_schema`：保持当前 strict schema。
- `json_object`：发送 `response_format: { type: "json_object" }`，把 schema 作为 system prompt。
- `prompt_json`：不发送 `response_format`，只在 prompt 中要求返回 JSON。

GLM-5 建议先用：

```json
{
  "structuredOutputMode": "json_object",
  "apiStyle": "chat"
}
```

如果仍 400，再降级：

```json
{
  "structuredOutputMode": "prompt_json",
  "apiStyle": "chat"
}
```

同时增加：

- `AbortController` 超时。
- 读取 provider error response body。
- 请求 ID 和错误摘要写入 session log。
- 400/401/429/5xx 区分。
- 针对 structured parse 失败重试一次，重试 prompt 中附带“上次不是合法 JSON”。

### 5.4 新增 provider smoke test 命令

修改 `packages/cli/src/index.ts`：

新增：

```powershell
swarmvault provider test <provider-id>
```

测试内容：

- 普通 chat：问 `Return the word ok.`
- structured：要求返回 `{ "ok": true, "model": "..." }`
- 输出请求模式、响应片段、错误 body。

验收命令：

```powershell
cd /d D:\kb\env-public\vault
swarmvault provider test glm5-jd --json
```

验收标准：

- chat 成功。
- structured 成功。
- 失败时可以看到京东云返回的具体错误 body。

## 6. 阶段 2：Source 分析结构和质量门禁升级

### 6.1 扩展 SourceAnalysis

修改 `packages/engine/src/types.ts`：

```ts
export type AuthorityLayer =
  | "core"
  | "method"
  | "evidence"
  | "evolution"
  | "local"
  | "international"
  | "project"
  | "unknown";

export type LegalForce =
  | "mandatory"
  | "recommended"
  | "explanatory"
  | "statistical"
  | "research"
  | "draft"
  | "superseded"
  | "unknown";

export type DocumentRole =
  | "law"
  | "regulation"
  | "policy"
  | "standard"
  | "monitoring_method"
  | "qa_qc"
  | "emission_standard"
  | "technical_guide"
  | "statistics"
  | "official_explanation"
  | "whitepaper"
  | "research_literature"
  | "draft"
  | "compilation_explanation"
  | "amendment"
  | "local_reference"
  | "international_reference"
  | "unknown";

export type LegalStatus =
  | "current_effective"
  | "issued_not_yet_effective"
  | "draft_consultation"
  | "superseded"
  | "amended"
  | "explanation_only"
  | "unknown";

export interface DomainMetadata {
  authorityLayer: AuthorityLayer;
  legalForce: LegalForce;
  documentRole: DocumentRole;
  legalStatus: LegalStatus;
  jurisdiction: "national" | "province" | "city" | "international" | "unknown";
  region?: string;
  standardCode?: string;
  publishDate?: string;
  effectiveDate?: string;
  replaces?: string[];
  replacedBy?: string[];
  pollutants?: string[];
  useFor?: string[];
  doNotUseFor?: string[];
  confidence?: number;
  notes?: string[];
  metadataSource?: "sidecar" | "rule" | "llm" | "mixed";
  verificationState?: "unreviewed" | "rule_verified" | "human_verified";
  llmUncertainFields?: string[];
}

export interface SourceAnalysis {
  ...
  domain?: DomainMetadata;
  analysisMode?: "provider" | "heuristic" | "vision" | "code" | "empty";
  providerId?: string;
  providerModel?: string;
  warnings?: string[];
}
```

这里要避免一个常见风险：不能把 LLM 对法律效力的判断直接当成事实。`standardCode`、`publishDate`、`effectiveDate`、`replaces/replacedBy`、`jurisdiction` 等字段优先来自 sidecar、文件名规则、正文正则和人工校验；LLM 只负责补充语义字段，例如 `useFor/doNotUseFor`、资料用途、常见误用、与专题的关系。若 `legalStatus` 只能由 LLM 猜测，应标记 `metadataSource: "llm"`、`verificationState: "unreviewed"`，检索排序不得把它当作已验证现行依据。

### 6.2 扩展 analysis zod schema

修改 `packages/engine/src/analysis.ts`：

- `ANALYSIS_FORMAT_VERSION` 从 8 提升到 9 或 10。
- `sourceAnalysisSchema` 增加 `domain`。
- `providerAnalysis` 把 `provider.id/model` 和 `analysisMode: "provider"` 写入分析结果。
- fallback 时写入：

```ts
analysisMode: "heuristic",
warnings: [`Provider analysis failed: ${message}`]
```

### 6.3 取消静默 fallback

新增配置：

```json
{
  "analysis": {
    "failurePolicy": "fail",
    "maxFallbackRatio": 0.05
  }
}
```

源码修改：

- `config.ts` 增加 analysis schema。
- `compileVault` 统计 provider failures、heuristic fallbacks。
- 如果 `failurePolicy = "fail"`，任一 provider 分析失败即终止。
- 如果 `failurePolicy = "warn"`，允许 fallback，但 compile 输出和 session log 必须包含 fallback count。
- 如果 fallback ratio 超过阈值，compile 返回非零退出码或至少 warning。

公共知识库建议：

```json
{
  "analysis": {
    "failurePolicy": "fail",
    "maxFallbackRatio": 0.02
  }
}
```

### 6.4 Source 页面 frontmatter 落盘

修改 `packages/engine/src/markdown.ts` 的 `buildSourcePage`：

在 frontmatter 增加：

```yaml
authority_layer: core
legal_force: mandatory
document_role: standard
legal_status: current_effective
jurisdiction: national
region:
standard_code: GB 3095-2026
publish_date: 2026-...
effective_date: 2026-...
replaces:
  - GB 3095-2012
pollutants:
  - PM2.5
  - PM10
  - O3
use_for:
  - 环境空气质量评价
do_not_use_for:
  - 固定污染源排放达标判定
analysis_mode: provider
provider_id: glm5-jd
```

修改 `GraphPage` 或增加 `metadata` 字段，让 graph/search 能读到这些信息。

## 7. 阶段 3：PDF/中文/环境术语噪声治理

### 7.1 术语过滤器

新增文件：

- `packages/engine/src/domain/env-air-terms.ts`
- `packages/engine/src/domain/env-air-normalize.ts`

能力：

- 标准化 `PM2.5`、`PM 2.5`、`PM_{2.5}`、`细颗粒物`。
- 标准化 `O3`、`臭氧`、`MDA8`、`8小时滑动平均`。
- 标准化 `NO2`、`SO2`、`CO`、`PM10`、`VOCs`、`NOx`、`NMHC`。
- 识别 `GB 3095-2012`、`HJ 663-2013`、`HJ 653-2021`。
- 识别 `征求意见稿`、`编制说明`、`修改单`、`代替`、`废止`、`实施`。

拒绝进入 concept/entity 的模式：

- 纯数字、年份、页码。
- `10mg`、`0kpa`、`nmol` 这类单位残片。
- `= n i`、`{ N O`、`\Delta` 这类公式残片。
- `Technical`、`Ambient`、`Determination` 这类英文标题碎片。
- 电话号码、内部编号、目录序号。

注意：`PM2.5`、`PM10`、`O3`、`NO2`、`SO2`、`CO` 虽短，但应通过 allowlist 保留。

### 7.2 heuristic 降级质量控制

修改 `analysis.ts`：

- `extractTopTerms` 后必须经过 `filterDomainConceptCandidate`。
- `extractEntities` 后必须经过 `filterDomainEntityCandidate`。
- heuristic 生成的概念最多作为低置信 candidate，不应自动参与核心专题合成。
- heuristic 问题不要再生成英文 `How does ... relate to ...`，至少改成中文：

```text
这份资料对{主题}的适用边界是什么？
这份资料是否为现行执行依据？
它与相关标准、编制说明或历史版本的关系是什么？
```

### 7.3 文本清洗

新增文件：

- `packages/engine/src/domain/env-air-text-cleanup.ts`

处理：

- 合并 `P M 2 . 5` 为 `PM2.5`。
- 合并 `G B 3 0 9 5` 为 `GB 3095`。
- 移除页眉页脚、重复版权行、目录点线。
- 对 PDF 表格提取残片增加保护，不把变量说明当实体。
- 对 `$\mathrm { P M } _ { 2 .` 这类 LaTeX 残片做最小修复。

接入位置：

- `analysis.ts` 的 `providerAnalysis` 之前。
- `search.ts` 写入 FTS 之前。

## 8. 阶段 4：多文档专题候选合成和审核

### 8.1 新增 Topic Synthesis 管线

新增文件：

- `packages/engine/src/topic-planner.ts`
- `packages/engine/src/topic-synthesis.ts`
- `packages/engine/src/domain/env-air-topic-schema.ts`
- `packages/engine/src/prompts/env-air.ts`

推荐流程：

1. Source classification：每个 source 先有 domain metadata。
2. Topic candidate planning：按标准号、污染物、业务任务、文档角色聚类。
3. Canonical topic mapping：映射到稳定专题，例如“环境空气质量评价”“AQI/IAQI”“臭氧 MDA8”“PM2.5 评价”“环境空气监测点位布设”。
4. Topic evidence pack：为每个专题收集 core、method、evidence、evolution、local、international。
5. LLM synthesis：用 GLM-5 对多个文档进行专家综述。
6. Citation validation：检查每个实质性结论是否有 source id 或条款线索。
7. Quality gates：检查是否误用草案、是否把编制说明替代标准正文、是否缺少现行核心依据。
8. Write review candidates：先写入 review/candidate 队列，不直接写 active 专题页。
9. Approve/promote：通过 `topic approve` 或人工审核后再晋升 active。

这个调整非常关键。环境空气知识库不是一般资料摘要系统，专题页可能会被 deer-flow 用于报告依据和业务判断。未经审核的 LLM 综合页如果直接进入 active，风险比普通概念页更高。

### 8.2 页面类型建议

两种方案：

方案 A：复用 `concept`，增加 frontmatter：

```yaml
kind: concept
topic_type: env_air_topic
status: active
```

优点：对现有 viewer、MCP、search 影响小。

方案 B：新增 PageKind `topic`。

需要修改：

- `types.ts` 的 `PageKind`
- `search.ts` kind normalization 和排序
- `markdown.ts` index 页面
- `vault.ts` graph build 和 page parse
- `mcp.ts` list/read/search 工具 schema
- viewer filters

建议先采用方案 A，等稳定后再升级为 `topic`。

### 8.3 专题页模板

每个重要专题页必须包含：

1. 专家结论摘要。
2. 现行执行依据。
3. 适用范围和不适用范围。
4. 核心指标、限值、方法或控制要求。
5. 资料分层：强制依据、技术方法、解释说明、统计证据、研究证据、历史演化、地方口径。
6. 历史演化和替代关系。
7. 地方适配。
8. 常见误用和报告写作风险。
9. 可用于报告的专业表述。
10. 引用来源清单。

### 8.4 Topic synthesis system prompt

建议新增 `packages/engine/src/prompts/env-air.ts`：

```ts
export const ENV_AIR_TOPIC_SYNTHESIS_SYSTEM = `
你是服务生态环境部门的环境空气污染业务专家，正在把多份资料综合成可追溯的专业 wiki 专题页。

你必须区分资料效力：
1. 现行法律法规、国家标准、生态环境标准和技术规范优先作为执行依据。
2. 地方标准和地方文件只在对应地区适用。
3. 编制说明、官方解读、修改单说明只能解释背景、修订原因和口径，不能替代标准正文。
4. 公报、月报、年报、白皮书、蓝皮书、研究论文只能作为统计、趋势、机理或辅助证据。
5. 征求意见稿、历史版本和废止件不能作为现行执行依据，只能用于演化追踪。

输出必须像专家综述，而不是逐篇摘要。每个实质性结论必须引用 source id，并尽量给出标准号、条款号、表号、页码或文件名线索。
如果证据不足，必须明确说“当前资料中未找到”。不要把模型推断写成资料事实。
`;
```

用户 prompt 结构：

```text
专题：{topicName}
业务目标：{goal}

资料分组：
## 现行核心依据
{core sources}

## 方法规范
{method sources}

## 解释和编制说明
{explanation sources}

## 统计和报告
{statistics sources}

## 研究和技术综述
{research sources}

## 历史版本、修改单、征求意见稿
{evolution sources}

## 地方口径
{local sources}

请生成 markdown 专题页，使用固定章节：
...
```

### 8.5 示例专题清单

第一轮重建建议强制生成这些专题候选页，并在抽检后晋升 active：

- 环境空气质量评价
- 环境空气质量标准 GB 3095
- AQI/IAQI
- PM2.5 评价和限值
- PM10 评价和限值
- 臭氧 MDA8
- SO2/NO2/CO 评价
- 环境空气监测点位布设
- 颗粒物自动监测系统技术要求
- 颗粒物手工监测和比对
- 气态污染物自动监测和质控
- VOCs 与臭氧协同控制
- 非甲烷总烃监测和应用边界
- 固定污染源废气监测
- 大气污染物排放标准体系
- 重污染天气应急减排
- 全国城市空气质量月报
- 空气质量持续改善行动计划
- 地方大气污染物排放标准适配
- 历史版本、征求意见稿和修改单使用边界

### 8.6 候选审核机制

建议借鉴 `llm-wiki-compiler`，为 SwarmVault 增加专题候选队列，而不是复用现有 concept candidate 的自动晋升逻辑。

建议落盘结构：

```text
state/
  topic-candidates/
    pending/
      <candidate-id>.json
    approved/
    rejected/
```

候选 JSON 至少包含：

```json
{
  "id": "topic-env-air-pm25-limit-20260428",
  "topic": "PM2.5 评价和限值",
  "targetPath": "wiki/concepts/PM2.5 评价和限值.md",
  "sources": ["source:...", "source:..."],
  "domainMetadata": {
    "authority_layer": ["core", "evidence", "evolution"],
    "mustIncludeCurrentBasis": true
  },
  "quality": {
    "citationCoverage": 0.95,
    "hasCurrentCoreBasis": true,
    "draftUsedAsCurrentBasis": false,
    "unsupportedClaimCount": 0
  },
  "frontmatter": {},
  "body": "...",
  "createdAt": "2026-04-28T00:00:00.000Z"
}
```

建议新增命令：

```powershell
swarmvault topic plan --profile env-air --json
swarmvault topic synthesize --profile env-air --review --limit 20
swarmvault topic review list
swarmvault topic review show <candidate-id>
swarmvault topic review approve <candidate-id>
swarmvault topic review reject <candidate-id> --reason "引用不足或把征求意见稿误作现行依据"
```

候选审核必须加锁，避免 compile、approve、reject 并发写同一页面。source hash 状态也应延迟到候选 approve 后再标记为已综合，避免一个失败候选让相关资料长期不再被重建。

## 9. 阶段 5：检索、图谱和上下文包业务排序

### 9.1 检索架构从 page-level 升级到 chunk-level

当前 `searchPages` 以页面为主，适合找 wiki 页，但不适合找“某个限值、某个条款、某个标准号、某个实施日期”这种强证据问题。建议参考 `sage-wiki` 的增强检索机制，把检索拆成：

1. Strong signal detection：标准号、污染物、限值、地区、年份、文件名精确识别。
2. Query normalization/expansion：中文同义词、标准号空格、污染物写法、业务意图扩展。
3. Chunk-level BM25：从 source/wiki chunk 中找证据片段。
4. Optional vector search：embedding 可用时加入语义召回。
5. RRF fusion：融合 BM25、向量、标准号强召回、图谱邻居。
6. Authority-aware rerank：按现行依据、文档角色、地区适用和问题意图调整。
7. Context packing：按 must_include/supporting/background 组装证据包。

需要新增或扩展 chunk 索引表：

```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  source_id TEXT,
  heading TEXT,
  body TEXT NOT NULL,
  chunk_type TEXT,
  start_line INTEGER,
  end_line INTEGER,
  page_number INTEGER,
  authority_layer TEXT,
  document_role TEXT,
  legal_status TEXT,
  standard_code TEXT,
  jurisdiction TEXT,
  region TEXT,
  pollutants TEXT
);
```

page-level 结果仍然保留，但最终回答和 context pack 应优先使用 chunk 证据，因为它能给出更窄、更可审计的出处。

### 9.2 Search index 增加元数据字段

修改 `packages/engine/src/search.ts`：

FTS `pages` 表增加字段：

```sql
authority_layer TEXT,
legal_force TEXT,
document_role TEXT,
legal_status TEXT,
jurisdiction TEXT,
region TEXT,
standard_code TEXT,
pollutants TEXT,
effective_date TEXT,
source_rank INTEGER
```

`rebuildSearchIndex` 从 frontmatter 读取上述字段。

`SearchPageFilters` 增加：

```ts
authorityLayer?: string;
legalStatus?: string;
documentRole?: string;
jurisdiction?: string;
region?: string;
pollutant?: string;
includeDrafts?: boolean;
includeSuperseded?: boolean;
```

### 9.3 权威性排序

新增 `packages/engine/src/domain/env-air-ranking.ts`：

排序规则：

1. 标准号/标题精确命中。
2. 用户问“现行依据/按什么执行/限值/标准”时：
   - `legal_status=current_effective`
   - `authority_layer=core/method`
   - `document_role=standard/monitoring_method/qa_qc/policy/law`
3. 用户问“为什么/背景/编制说明/修订原因”时：
   - 编制说明、官方解读、研究综述上升，但标准正文仍保留。
4. 用户问“以前/改了什么/征求意见稿/历史版本”时：
   - evolution 上升，draft/superseded 不再强降权。
5. 用户问“某地/地方/省市”时：
   - region/jurisdiction 命中上升。
6. 统计报告、月报、论文不得排在现行标准前面，除非用户明确问统计趋势或研究证据。

### 9.4 中文和标准号 query normalization

新增 `packages/engine/src/domain/env-air-query.ts`：

能力：

- `PM2.5` 同义：`PM 2.5`、`细颗粒物`、`颗粒物 PM2.5`。
- `臭氧` 同义：`O3`、`O_3`、`MDA8`、`8小时滑动平均`。
- `GB3095` 归一到 `GB 3095`。
- `HJ653` 归一到 `HJ 653`。
- `地方标准` 扩展为 `地方 大气污染物 排放标准 省 市 地方标准`。
- `征求意见稿 现行依据` 识别为“需要说明不能作为现行依据”的 intent。

### 9.5 Embedding provider

当前 `hybrid=true` 但没有 embedding provider，语义检索实际不可用。建议配置独立 embedding provider：

```json
{
  "providers": {
    "embedding-local": {
      "type": "openai-compatible",
      "model": "bge-m3",
      "baseUrl": "http://localhost:11434/v1",
      "apiStyle": "chat",
      "capabilities": ["embeddings"]
    }
  },
  "tasks": {
    "embeddingProvider": "embedding-local"
  },
  "retrieval": {
    "hybrid": true,
    "rerank": true
  }
}
```

如果京东云有 embedding 模型，也可配置为 OpenAI-compatible embeddings。

### 9.6 Context pack 保留核心依据

修改 `packages/engine/src/context-packs.ts`：

新增 context pack item class：

- `must_include`: 现行核心依据、精确标准号命中。
- `supporting`: 编制说明、技术指南、统计证据。
- `background`: 研究、国际参考、历史版本。

预算分配：

- 至少 40% 给现行依据。
- 至少保留 1 个标准正文 source page。
- 如果目标是“现行依据/限值/标准”，不得只保留 candidate 或编制说明。
- candidate page 默认降权，除非已经人工晋升或专题合成页。

## 10. 阶段 6：MCP/deer-flow 专用工具和提示词

### 10.1 MCP 工具建议

在 `packages/engine/src/mcp.ts` 新增或增强：

```text
env_search_knowledge
env_answer_with_sources
env_get_current_basis
env_trace_evolution
env_compare_versions
env_get_local_rules
env_build_report_context
env_get_standard_profile
```

如果不希望增加太多工具，也至少增强 `query_vault` 和 `build_context_pack` 输入：

```ts
{
  question: string;
  intent?: "current_basis" | "explanation" | "evolution" | "local" | "statistics" | "report_writing" | "research";
  region?: string;
  pollutants?: string[];
  includeDrafts?: boolean;
  includeSuperseded?: boolean;
  requireCurrentBasis?: boolean;
  scope?: "public_only" | "tenant_only" | "project_only" | "mixed_public_private";
  tenantId?: string;
  projectId?: string;
}
```

公共知识库阶段可以先只启用 `public_only`，但工具 schema 应提前保留 scope 字段。后续接入客户报告、项目报告和 agent 自动生成报告时，deer-flow 必须显式传入 `tenantId/projectId`，SwarmVault MCP 不能默认跨租户混搜。

### 10.2 MCP 回答提示词

修改 `packages/engine/src/vault.ts` 的 `executeQuery` system prompt，或抽到 `prompts/env-air.ts`：

```ts
export const ENV_AIR_QUERY_SYSTEM = `
你是环境空气污染业务知识库问答工具，服务环保局业务人员和环境数据分析 Agent。

回答前必须判断问题意图：
- 问“现在按什么执行、限值是多少、标准是什么”：优先现行有效法律法规、国家标准、生态环境标准、技术规范。
- 问“为什么、背景、修订原因”：可引用编制说明、官方解读、统计报告和研究综述，但不能让解释材料替代标准正文。
- 问“以前怎么规定、改了什么、征求意见稿”：引用历史版本、修改单、编制说明和征求意见稿，并明确其非现行执行依据属性。
- 问“地方怎么落地”：必须说明地区适用范围，不得把地方口径扩展到全国。
- 问“报告怎么写”：先给依据和业务判断，再给可直接写入报告的专业表述。

回答规则：
1. 必须引用 source id。
2. 涉及限值、方法、执行依据时，优先引用标准正文；编制说明只能解释。
3. 没有证据时必须说明“当前知识库未检索到足够证据”。
4. 草案、历史版本、废止件不得作为现行执行依据。
5. 如果用户同时提供环境监测数据分析结果，应区分“数据计算结论”和“法规/技术依据”。
`;
```

### 10.3 deer-flow 调用方式

deer-flow 侧建议只接 SwarmVault MCP，不需要适配其他 agent。

MCP server 命令：

```powershell
cd /d D:\kb\env-public\vault
node D:\Github\swarmvault\packages\cli\dist\index.js mcp
```

deer-flow 的 agent 逻辑建议：

1. 用户问业务知识：调用 SwarmVault MCP。
2. 用户问监测数据：调用环境数据 MCP。
3. 用户问“数据说明/报告/成因分析”：先用环境数据 MCP 得到数据计算结果，再用 SwarmVault MCP 拉取依据和写作上下文。
4. 最终回答分层：
   - 数据事实。
   - 适用依据。
   - 业务判断。

当两类 MCP 共同参与回答时，deer-flow 的总提示词应强制区分：

- 环境数据 MCP 输出的是“监测数据事实、统计计算和趋势分析”。
- SwarmVault MCP 输出的是“法规标准、技术规范、解释证据和报告写作依据”。
- 不能用历史报告中的结论覆盖当前数据计算结果。
- 不能用项目私有报告覆盖公共标准；私有报告只能作为同客户/同项目的写作风格、背景材料或历史分析线索。

### 10.4 SaaS 和项目私有层的提前设计

虽然当前只建设公共知识库，但后续报告入库和多用户 SaaS 会改变检索风险模型。建议现在就把数据模型和 MCP 参数预留好：

```ts
export interface AccessScope {
  visibility: "public" | "tenant" | "project" | "private";
  tenantId?: string;
  projectId?: string;
  ownerUserId?: string;
  allowedRoles?: string[];
}

export interface GeneratedReportMetadata {
  reportType: "monitoring_analysis" | "improvement_plan" | "monthly_report" | "research_note";
  customerName?: string;
  projectName?: string;
  dataPeriod?: string;
  reportDate?: string;
  generatedByAgent?: string;
  sourceDataRefs?: string[];
  validity?: "current_project_context" | "historical_reference" | "superseded" | "unknown";
}
```

检索策略：

- `public_only`：只查公共知识库，用于标准依据、通用政策、公开技术资料。
- `tenant_only`：只查某客户自己的报告和资料。
- `project_only`：只查某项目资料，用于续写、复盘、同项目历史分析。
- `mixed_public_private`：先查公共依据，再查私有报告，最终回答中必须标注“公共依据”和“项目历史材料”。

权威性规则：

- 公共 core/method 永远高于项目报告。
- 项目报告不得提供新的法定限值、执行标准或监管口径。
- 历史报告若数据期或报告期早于用户当前任务，应标记为历史参考，不得直接复用结论。
- 跨租户检索必须在数据库层、MCP 参数层和测试层同时拦截，不能只靠 prompt 约束。
   - 风险和边界。
   - 可引用报告表述。

## 11. 阶段 7：质量门禁和自动化测试

### 11.1 新增 golden test 命令

建议新增：

```powershell
swarmvault test golden --file D:\kb\env-public\tests\env-public-golden-set.md
```

或先新增独立脚本：

```powershell
node D:\Github\swarmvault\scripts\env-public-golden-test.mjs D:\kb\env-public\vault D:\kb\env-public\tests\env-public-golden-set.md
```

测试维度：

- Search top-k。
- Graph query seeds。
- Context pack must_include。
- query_vault answer citations。
- metadata filters。
- candidate noise ratio。
- fallback ratio。

### 11.2 关键质量指标

第一版验收指标：

| 指标 | 目标 |
|---|---:|
| Provider smoke test | 100% 通过 |
| Source provider analysis coverage | >= 95% |
| Heuristic fallback ratio | <= 5% |
| tags 非空比例 | >= 90% |
| domain metadata 完整率 | >= 90% |
| topic review 候选页数量 | >= 20 |
| 专题候选 citation coverage | >= 90% |
| 专题候选误用草案为现行依据 | 0 |
| candidate 噪声比例 | <= 10% |
| chunk 级精确证据 Top5 命中 | >= 90% |
| 标准号精确查询 Top1 命中 | >= 90% |
| 现行依据类问题 Top3 包含现行标准正文 | >= 90% |
| 草案/历史类问题明确非现行 | 100% |
| 地方类问题说明适用地区 | 100% |
| query_vault 可回答并带 source id | 100% |
| context pack 必含核心依据 | 100% |

### 11.3 必测问题集

建议至少覆盖：

1. `PM2.5 24小时平均限值是多少，现行依据是什么？`
2. `环境空气质量评价现在应按哪个技术规范执行？`
3. `HJ 663-2013 和 HJ 663-2026 是什么关系？`
4. `AQI 日报技术规定和环境空气质量标准是什么关系？`
5. `臭氧 MDA8 在空气质量评价中怎么使用？`
6. `地方大气污染物排放标准能否替代国家标准？`
7. `征求意见稿能不能作为现行执行依据？`
8. `全国城市空气质量月报适合用于什么，不适合用于什么？`
9. `非甲烷总烃自动监测相关资料有哪些，哪些是方法依据，哪些是编制说明？`
10. `写空气质量改善报告时，如何引用月报、标准和研究材料？`

后续接入项目私有报告后，必须增加：

1. `某项目历史报告中的判断和现行标准不一致时，应以哪个为准？`
2. `只允许查询 tenant A 时，能否检索到 tenant B 的报告？`
3. `mixed_public_private 模式下，回答是否清楚区分公共依据和项目历史材料？`

## 12. 文件级修改清单

### 12.0 架构边界调整

下面的文件清单以“最快落地”为目标列出，但正式实现时建议增加 domain profile 层，避免把 `env-air` 写死在引擎里。

推荐结构：

```text
packages/engine/src/domain-profile.ts
packages/engine/src/domain-profiles/default.ts
packages/engine/src/prompt-packs.ts

D:\kb\env-public\vault\
  domain\
    env-air.profile.json
    env-air.metadata.schema.json
    env-air.terms.json
    env-air.ranking.json
  prompts\
    env-air.source-analysis.md
    env-air.topic-synthesis.md
    env-air.query.md
    env-air.deep-lint.md
```

`packages/engine` 只负责加载 profile、执行 schema 校验、调用 prompt、应用 ranking policy。`env-air` 具体术语、提示词和质量规则优先放在 vault 配置中。只有确实需要高性能或复用的通用能力，例如标准号归一化、chunk 索引、candidate review、citation validation，才进入 engine 源码。

### 12.1 Engine

`packages/engine/src/types.ts`

- 增加 ProviderConfig 字段。
- 增加 DomainMetadata 相关类型。
- SourceAnalysis 增加 domain、analysisMode、providerId、providerModel、warnings。
- 可选：GraphPage 增加 domain metadata 字段，或增加 `metadata?: Record<string, unknown>`。

`packages/engine/src/config.ts`

- provider schema 支持 `apiKey/apiKeyFile/structuredOutputMode/maxRetries/timeoutMs/debugProviderErrors`。
- 增加 `analysis` 配置。
- 增加 `domain` 配置。
- 增加 `retrieval` metadata filter 配置。

`packages/engine/src/providers/registry.ts`

- 增加 secrets 文件读取。
- 增加 provider secret resolution。
- 创建 provider 时传入 structuredOutputMode、timeout、retry 配置。

`packages/engine/src/providers/openai-compatible.ts`

- 支持 `json_schema/json_object/prompt_json`。
- 错误时读取 response body。
- 超时和 retry。
- structured parse 修复重试。

`packages/engine/src/analysis.ts`

- 扩展 sourceAnalysisSchema。
- 加入 env-air prompt pack。
- provider fallback 记录并可 fail。
- heuristic 抽取走 domain filter。
- 提高 ANALYSIS_FORMAT_VERSION。

`packages/engine/src/markdown.ts`

- Source page frontmatter 写入 domain metadata。
- Topic/concept 专题页支持专家综述结构。
- Candidate 页面标出 analysisMode 和低置信来源。

`packages/engine/src/vault.ts`

- compile 统计 provider fallback。
- 引入 topic planner 和 topic synthesis。
- buildGraph 使用 domain metadata 建立关系：
  - `supersedes`
  - `replaced_by`
  - `explains`
  - `amends`
  - `implements`
  - `applies_to_region`
  - `supports_evidence_for`
- executeQuery 使用 env-air query prompt。

`packages/engine/src/search.ts`

- 索引 domain metadata。
- 支持 metadata filters。
- 权威性排序。
- 标准号和中文查询 boost。

`packages/engine/src/context-packs.ts`

- context item 分层。
- 现行核心依据 must_include。
- candidate 默认降权。

`packages/engine/src/mcp.ts`

- 增加 env 专用工具或增强通用工具 schema。
- 输出中返回 intent、metadata filters、authority ordering。

`packages/engine/src/deep-lint.ts`

- deep lint prompt 改成环境空气业务审计。
- 增加质量项：
  - 草案被当现行依据。
  - 编制说明替代标准正文。
  - 月报替代限值依据。
  - 地方文件无地区边界。
  - candidate 噪声过高。

新增文件：

- `packages/engine/src/domain-profile.ts`
- `packages/engine/src/prompt-packs.ts`
- `packages/engine/src/domain/env-air-terms.ts`
- `packages/engine/src/domain/env-air-query.ts`
- `packages/engine/src/domain/env-air-ranking.ts`
- `packages/engine/src/domain/env-air-text-cleanup.ts`
- `packages/engine/src/topic-planner.ts`
- `packages/engine/src/topic-synthesis.ts`
- `packages/engine/src/prompts/env-air.ts`
- `packages/engine/src/provider-smoke.ts`
- `packages/engine/src/quality-gates.ts`

### 12.2 CLI

`packages/cli/src/index.ts`

- `provider test <provider-id>`
- `compile --fail-on-fallback`
- `compile --force-analysis`
- `compile --topic-synthesis`
- `topic plan --profile env-air`
- `topic synthesize --profile env-air --review`
- `topic review list/show/approve/reject`
- `test golden --file <path>`
- 通用 `--root <vault>` 或 `--vault <path>`，避免必须切换工作目录。
- `candidate list --limit <n>` 和 `candidate preview-scores --limit <n>`，避免大 vault 输出过大。

### 12.3 Viewer

如果需要前端查看：

- source/detail 页面显示 legal status、authority layer、standard code。
- graph filter 增加 legal_status、document_role、jurisdiction。
- candidate 页面增加噪声标记和人工晋升提示。

### 12.4 Tests

新增测试：

- `packages/engine/test/provider-secret.test.ts`
- `packages/engine/test/openai-compatible-structured-modes.test.ts`
- `packages/engine/test/env-air-analysis-quality.test.ts`
- `packages/engine/test/env-air-ranking.test.ts`
- `packages/engine/test/topic-synthesis.test.ts`
- `packages/engine/test/topic-review-queue.test.ts`
- `packages/engine/test/chunk-retrieval.test.ts`
- `packages/engine/test/citation-validation.test.ts`
- `packages/engine/test/context-pack-authority.test.ts`
- `packages/engine/test/mcp-env-tools.test.ts`
- `packages/engine/test/mcp-scope-acl.test.ts`
- `packages/cli/test/provider-test-command.test.ts`
- `packages/cli/test/golden-test-command.test.ts`

## 13. 重新构建建议流程

完成阶段 1 到阶段 5 后，再执行公共知识库重建。

### 13.1 清理旧分析缓存

因为 `ANALYSIS_FORMAT_VERSION` 会提升，理论上会自动重算。仍建议备份旧结果：

```powershell
cd /d D:\kb\env-public\vault
Rename-Item state\analyses state\analyses_before_env_air_v2
Rename-Item wiki wiki_before_env_air_v2
```

如果不想移动 wiki，则至少删除旧 analyses 和 candidates：

```powershell
Remove-Item state\analyses -Recurse -Force
Remove-Item wiki\candidates -Recurse -Force
```

### 13.2 Provider smoke test

```powershell
cd /d D:\kb\env-public\vault
swarmvault provider test glm5-jd --json
```

不通过则不得 compile。

### 13.3 Compile

```powershell
swarmvault compile --fail-on-fallback
swarmvault topic plan --profile env-air --json
swarmvault topic synthesize --profile env-air --review --limit 20
swarmvault topic review list
```

专题页合成通过后，再逐个审核：

```powershell
swarmvault topic review show <candidate-id>
swarmvault topic review approve <candidate-id>
```

不建议在第一轮重建中使用“自动 approve 全部专题页”。如果后续确实需要批量晋升，也应先要求 quality gate 全部通过，并保留人工抽样比例。

### 13.4 Retrieval rebuild

```powershell
swarmvault retrieval rebuild
swarmvault retrieval status --json
```

### 13.5 Lint 和 golden test

```powershell
swarmvault lint --deep --json
swarmvault test golden --file D:\kb\env-public\tests\env-public-golden-set.md --json
```

### 13.6 手工抽检

必须打开检查：

- `wiki\concepts\环境空气质量评价.md`
- `wiki\concepts\PM2.5 评价和限值.md`
- `wiki\concepts\臭氧 MDA8.md`
- `wiki\concepts\AQI-IAQI.md`
- `wiki\concepts\地方大气污染物排放标准适配.md`
- `wiki\sources\2012-gb3095-2012-*.md`
- `wiki\sources\2026-gb3095-2026-*.md`
- `wiki\sources\2013-hj663-2013-*.md`
- `wiki\sources\2026-hj663-2026-*.md`

## 14. 当前 raw 目录建议

当前 `D:\kb\env-public\raw` 顶层为：

- `core`：497 个 source。
- `evidence`：128 个 source。
- `evolution`：372 个 source。

当前没有 `local_references` 顶层目录。后续如果补地方标准和地方口径，建议恢复或新增：

```text
raw/
  core/
  evidence/
  evolution/
  local_references/
  technical_guides/
```

但源码改造后，不应只依赖目录判断资料类型。目录只能作为初始 hint，最终以 LLM 和规则共同识别的 domain metadata 为准。

建议新增 sidecar metadata 支持：

```text
某文件.pdf
某文件.meta.json
```

示例：

```json
{
  "authority_layer": "core",
  "document_role": "standard",
  "legal_status": "current_effective",
  "standard_code": "GB 3095-2026",
  "jurisdiction": "national",
  "pollutants": ["PM2.5", "PM10", "O3", "SO2", "NO2", "CO"]
}
```

导入时 `ingest` 应读取 sidecar，写入 manifest details，并作为 LLM 分析强提示。

## 15. 风险和优先级

### 15.1 当前方案仍需注意的风险

1. Provider 风险：GLM-5 当前 400 错误还没有响应 body，不能确认是 `response_format`、模型名、鉴权、token 参数还是 schema 结构问题。Provider smoke test 是所有编译工作的前置条件。
2. 缓存风险：提升 `ANALYSIS_FORMAT_VERSION` 会触发大规模重算，997 个 source 可能产生明显费用和耗时。正式全量前应先抽 20-50 个典型文件做试编译。
3. 元数据幻觉风险：LLM 可能把征求意见稿、编制说明、月报误判成现行依据。法律效力字段必须优先来自 sidecar、规则抽取和人工校验，LLM 字段要带 `verificationState`。
4. 直写 active 风险：专题合成如果直接写入 active，错误会马上被 deer-flow 检索并用于回答。必须增加 review/candidate 队列和引用校验。
5. 过度行业硬编码风险：如果把 env-air 规则全部写死到 `packages/engine/src/domain`，后续通用能力维护困难。应优先用 domain profile/prompt pack。
6. 检索页粒度风险：page-level 检索容易把一个大标准页整体召回，却找不到具体限值、条款、实施日期。必须补 chunk 级证据检索。
7. 200k 上下文误用风险：大窗口不能替代检索和证据筛选。把过多材料一次性交给模型，会增加遗漏、串证和成本。
8. 公共/私有混搜风险：后续客户报告接入后，如果没有 tenant/project scope，可能出现跨客户泄露，或历史项目报告反向覆盖公共标准。
9. 报告复用风险：agent 生成的历史报告是“项目结论”，不是公共依据。进入知识库后必须标记客户、项目、数据期、报告期、有效性和适用范围。
10. 自动晋升风险：当前 candidate 噪声已经很高，任何 auto-promote 都可能把数字、单位、公式残片晋升为 active 页面。专题候选和概念候选都应默认关闭自动晋升。

### 15.2 优先级

P0 必须先做：

- 文件/私有配置 API key 支持，同时避免 key 进入 Git 和日志。
- GLM-5 structured output 兼容。
- Provider error body 输出和 provider smoke test。
- Compile fallback fail/warn 门禁。
- domain profile 基础加载机制，至少能加载 `env-air` prompt 和 metadata schema。

P1 紧接着做：

- SourceAnalysis domain metadata，并区分规则/sidecar 事实字段与 LLM 语义字段。
- env-air source analysis prompt。
- 噪声过滤和中文/标准号文本清洗。
- Source page frontmatter 写入 domain metadata。
- search metadata index 和权威性排序。

P2 做专家 wiki 能力：

- chunk-level index 和证据检索。
- Topic planner。
- LLM synthesis candidate page。
- citation validation 和 topic review queue。
- context pack must_include。
- MCP env 专用工具或增强后的通用工具。

P3 做长期能力：

- golden test 命令。
- viewer 元数据展示。
- sidecar metadata 编辑/校验。
- embedding provider 和向量检索。
- SaaS public/private/tenant/project scope。
- 生成报告入库、引用图谱、过期检测和 ACL 回归测试。

## 16. 最小可交付改造版本

如果希望先尽快得到可用的公共知识库，最小改造范围应调整为：

1. Provider 支持 `apiKeyFile` 或 `swarmvault.secrets.json`，并确保密钥不进入 Git、日志、graph、session、compile state。
2. OpenAI-compatible 支持 `structuredOutputMode: "json_object" | "prompt_json"`，并打印可诊断的 provider error body。
3. 增加 `swarmvault provider test glm5-jd --json`，不通过不得 compile。
4. `analyzeSource` 不再静默 fallback，compile 输出 fallback count，并支持 `--fail-on-fallback`。
5. 引入最小 domain profile：从 vault 加载 `env-air` metadata schema、source-analysis prompt、query prompt、ranking policy。
6. SourceAnalysis 增加 `domain`、`analysisMode`、`providerId`、`providerModel`、`warnings`，domain metadata 标记 `metadataSource` 和 `verificationState`。
7. Source page frontmatter 写入 domain metadata。
8. env-air 概念/实体噪声过滤和中文/标准号文本清洗。
9. search 按标准号、legal_status、authority_layer、document_role 排序；现行依据类问题必须 boost 标准正文。
10. 增加 chunk 级索引的最小实现，至少让限值、实施日期、条款线索能以片段返回。
11. 新增 20 个专题页的 LLM synthesis，但写入 topic review queue，不直接 active。
12. 增加 citation validation，专题候选缺少现行核心依据或把草案当现行依据时不得 approve。
13. `query_vault` 和 `build_context_pack` 使用环境空气业务提示词，并支持 `intent/region/pollutants/requireCurrentBasis/scope`。
14. golden test 覆盖至少 10 个核心问题，新增 candidate 噪声、fallback ratio、现行依据 must_include 指标。

这个最小版本完成后，先抽样重建 20-50 个典型 source 和 3-5 个专题候选，验证 Provider、metadata、检索、引用和回答链路。抽样通过后，再全量重建公共知识库。全量重建后再评估是否进入 P2/P3 的更大范围架构升级。

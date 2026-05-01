# 环境空气公共知识库全盘测试与源代码修改方案

日期：2026-05-01  
项目：`D:\Github\swarmvault`  
公共知识库 Vault：`D:\kb\env-public\vault`

## 1. 结论摘要

本轮全盘测试显示，当前代码的基础工程质量已经可用：engine/cli 类型检查、单元测试、构建均通过，检索索引也处于 fresh 状态。但公共知识库在面向环保局环境空气业务的真实问答中仍存在几类需要继续改源码解决的问题：

1. `lint --deep` 仍然会因为 GLM-5 返回的结构化字段不符合严格枚举而失败，并触发 Windows Node 原生断言崩溃。这是 P0。
2. 997 份 source analysis 中仍有 5 份真实 `heuristic` fallback，另有 3 份 `empty` PDF 空提取。5 份 heuristic 主要是结构化解析容错和超时恢复不足，3 份 empty 是 OCR/源文件文本提取能力不足。
3. 当前查询层对“现行依据”“历史评价期”“评价方法/数据有效性”的意图识别不够细，导致 `answerBasis` 错误、工具路由偏宽、O3 第90百分位有效性问题无法稳定命中 HJ 663/GB 3095 关键证据。
4. 回答 grounding 仍会出现无效引用 ID，说明只靠提示词要求 `[E1]` 不够，最终输出层需要代码级引用归一和阻断。
5. 普通 lint 告警多数不是编译失败，但暴露出“草案误入 core”“文件型 entity 晋升”“旧 output 无引用/过期”等质量治理问题，需要通过分类规则、候选页治理、输出失效策略继续改进。

总体建议：需要开展第二轮源码修改。修改重点不是针对某一个标准写枚举补丁，而是建设“结构化输出容错层 + 环境空气意图/时态层 + 检索排序/事实抽取增强 + grounding 强约束 + 质量诊断可观测性”。本次复核后，需要进一步强调三条边界：第一，结构化输出容错只能修复格式和轻量类型问题，不能把不可靠内容自动升级为执行依据；第二，环境空气业务规则应通过 domain profile 和 query plan 扩展，避免继续写散在默认 profile 或单个标准补丁里；第三，所有返回给 deer-flow 的 MCP 决策字段必须保持向后兼容，只能增量添加字段。

### 1.1 本次复核后新增的问题与风险

对方案和代码再次复核后，原方案还存在以下需要打磨的地方：

1. `ProviderAdapter.generateStructured()` 是全局接口，调用点覆盖 `analysis.ts`、`deep-lint.ts`、`extraction.ts`、`orchestration.ts`、`topic-synthesis.ts`、`vault.ts` 等文件。如果直接改变接口但不更新 `BaseProviderAdapter` 和所有测试，会造成全项目编译风险。正确做法是增加可选第三参数，并保证旧调用完全兼容。
2. 结构化 repair 不能无差别“修好所有字段”。对 `authorityLayer`、`legalStatus`、`documentRole`、`standardCode`、`effectiveDate`、`replaces/replacedBy` 等会影响强制依据判断的字段，不能把任意 LLM 输出强行映射为有效值；应优先使用规则推断，无法确认时保留 `unknown`、加入 `llmUncertainFields` 和 warning。
3. 当前项目已有 `domain.profilePath` 和 `loadDomainProfile()`，但 `classifyEnvAirToolRouting()`、`buildEnvironmentDataToolHints()` 仍使用 `DEFAULT_ENV_AIR_PROFILE` 的静态常量。方案如果只继续改 `env-air-profile.ts` 默认值，会削弱后续 SaaS 多租户和不同业务域扩展能力。
4. 目前存在两个 query plan 入口：`buildEnvAirQueryPlan()` 和 `buildDomainQueryPlan()`。`vault.ts` 里仍用旧入口提取标准片段、计算 required standards；`search.ts` 和主查询流程则走 profile-aware 的 `buildDomainQueryPlan()`。如果新增时态、评价期、数据有效性信号，只改一个入口会导致调试信息、检索排序、strict grounding 不一致。
5. 现有 structured fact 已经有 `validity_rule`，因此不应再草率增加一批细碎 fact kind，除非证明现有 `validity_rule + metric/qualifiers/searchText` 无法表达。否则会扩大类型、测试和索引兼容成本。
6. MCP `query_vault` 已经承诺返回 `evidenceState`、`answerBasis`、`toolRouting`、`agentDecision` 等 DeerFlow 决策字段。新增 `temporalIntent`、`citationNormalization`、`qualityWarnings` 时必须保持旧字段语义不变，避免 deer-flow 端工具选择逻辑被破坏。
7. 后续项目私有报告会进入知识库，`scope`、`tenantId`、`projectId`、`visibility`、`sourceScope` 的隔离必须纳入回归测试。当前方案对公共库质量讲得多，对 SaaS 隐私隔离风险讲得不足。
8. `lint --deep` 的 Windows Node assertion 不能被简单归结为一个业务异常。方案应以“业务层 catch provider failure 并正常退出”为首要修复，避免命令失败后触发底层异常；不应承诺一次业务代码修改就修复 Node 内部 bug。
9. OCR fallback 成本较高，且可能引入识别错误。它应是显式 opt-in，并在 evidence 中标记 OCR provenance，不能默认把 OCR 内容当作与原生文本同等可靠的权威证据。

## 2. 本轮测试范围与结果

### 2.1 工程测试

执行命令：

```powershell
pnpm --filter @swarmvaultai/engine typecheck
pnpm --filter @swarmvaultai/cli typecheck
pnpm --filter @swarmvaultai/engine test
pnpm --filter @swarmvaultai/cli test
pnpm --filter @swarmvaultai/engine build
```

结果：

- `@swarmvaultai/engine typecheck`：通过。
- `@swarmvaultai/cli typecheck`：通过。
- `@swarmvaultai/engine test`：47 个 test files 中 46 个通过、1 个 skipped；337 个测试中 335 个通过、2 个 skipped。
- `@swarmvaultai/cli test`：1 个 test file、7 个测试通过。
- `@swarmvaultai/engine build`：通过。
- build 仍出现 Node `[DEP0190] Passing args to a child process with shell option true...` 警告，需要 P2 修复。

备注：当前工作区存在两处上一轮留下的未提交源码改动：

- `packages/engine/src/fact-extraction/facts.ts`
- `packages/engine/test/env-air-facts.test.ts`

这两处是结构化 fact stable id 去重修复，应在下一次落地时作为已完成但未提交的 P0 修复处理，不应回退。

### 2.2 Vault 状态测试

执行命令：

```powershell
node D:\Github\swarmvault\packages\cli\dist\index.js retrieval status
```

在 `D:\kb\env-public\vault` 下结果：

- Retrieval backend：`sqlite`
- Index：`D:\kb\env-public\vault\state\retrieval\fts-000.sqlite`
- Manifest：present
- Graph：present
- Pages indexed：2641
- State：fresh

索引表结构实测包含 `pages.standard_identity`、`facts.standard_identity` 等当前代码所需字段。

### 2.3 普通 lint

执行命令：

```powershell
node D:\Github\swarmvault\packages\cli\dist\index.js lint
```

结果：命令退出码为 0，但有以下质量告警：

- `noisy_promoted_page`
  - `wiki\entities\欧盟bat参考文件.md`
  - `wiki\entities\欧盟ippc陶瓷工业bat参考文件.md`
- `stale_page` / `ungrounded_output`
  - `wiki\outputs\2025-pm2-5.md`
- `draft_in_core_layer`
  - `wiki\sources\2024-d6d2eafa.md`
  - 标题：`2024_生态环境监测条例_草案征求意见稿`
- 多个 source/output/graph 页面为 `orphan_page`
- `stale_working_tier`
  - `wiki\insights\research-playbook.md`

判断：这些不是运行级阻断，但反映了源分类、候选晋升、输出失效、insight consolidation 四类质量治理问题。

### 2.4 深度 lint

执行命令：

```powershell
node D:\Github\swarmvault\packages\cli\dist\index.js lint --deep
```

结果：失败，退出码 1。关键错误：

```text
Provider glm5-jd structured initial response could not be parsed ...
path: [ "findings", 1, "code" ]
Invalid option: expected one of "coverage_gap"|"contradiction_candidate"|"contradiction"|"missing_citation"|"candidate_page"|"follow_up_question"
...
repair failed ...
Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
```

判断：

- `deep-lint.ts` 里的 `deepLintResponseSchema` 对 `findings[].code` 使用严格 `z.enum`，GLM-5 返回近义代码时直接导致解析失败。
- `openai-compatible.ts` 的 repair prompt 只笼统要求返回合法 JSON，没有针对 Zod issue 给出精确修复指导，也没有最终软降级。
- `runDeepLint` 没有把 provider 失败转成 lint finding，因此一个非关键 LLM 审计失败会中断整个 lint。
- Node 原生断言崩溃不一定完全由业务代码造成，但 provider abort/cleanup 路径需要更保守，避免失败后仍留下正在关闭的 async handle。

### 2.5 analysis fallback 统计

统计目录：`D:\kb\env-public\vault\state\analyses`

结果：

- 总数：997
- `provider`：989
- `heuristic`：5
- `empty`：3

真实 heuristic fallback：

| sourceId | 标题 | 类型 |
|---|---|---|
| `2012-gb-16171-2012-5cc091a9` | `2012_GB_16171-2012_炼焦化学工业污染物排放标准` | GLM 返回 `claims` 超过 schema 最大 8 条 |
| `2022-11-2b7c77f3` | `2022_11_全国城市空气质量报告` | GLM 调用 120s 超时 |
| `2026-8c7781de` | `2026_十五五环境基准工作方案_征求意见稿` | GLM 返回 `summary` 非字符串 |
| `item-0ced99a3` | `环境空气_气象和颗粒物中酞酸酯类的测定_气相色谱-质谱法编制说明` | GLM 调用 120s 超时 |
| `item-8e06fd0a` | `排污单位自行监测技术指南_煤炭加工-合成气和液体燃料生产` | GLM 返回 `claims[3].citation` 非字符串 |

empty extraction：

| sourceId | 标题 | 类型 |
|---|---|---|
| `19-d339aa89` | `污染源自动监控设施现场监督检查办法_环保部19号令` | PDF 提取无文本 |
| `2023-0b2ec253` | `2023_空气质量持续改善行动计划` | PDF 提取无文本 |
| `2023-a0848379` | `《中国大气臭氧污染防治蓝皮书（2023 年）》执行摘要` | PDF 提取无文本 |

判断：

- 5 份 heuristic 不应靠数据源清理解决，应改 LLM 结构化解析、重试和超时降级。
- 3 份 empty 需要先做数据源/OCR 处理，同时源码也应支持“空提取诊断、OCR fallback、可配置失败策略”。

### 2.6 真实查询测试

#### 查询 A：现行 GB 3095 依据

问题：

```text
现行环境空气质量标准应依据 GB 3095-2026 还是 GB 3095-2012？请说明依据和适用边界。
```

结果：

- `evidenceState=grounded`
- `recommendedNextTool=knowledge_base`
- `answerBasis=evidence_explanation`
- `rankingSignals=explicit_standard_reference`
- 检索到了 GB 3095-2026 current authority，也检索到了 GB 3095-2012 相关演化/说明材料。

问题：

- 业务上这是典型“现行依据”问题，`answerBasis` 应为 `current_effective`。
- 根因在 `vault.ts`：`currentBasisQuery` 已经通过 `queryPlan.currentBasisIntent` 计算出来，但 `inferAnswerBasis()` 只看 `QueryOptions.intent` 和 `requireCurrentBasis`，没有接收 `currentBasisQuery`。

#### 查询 B：北京市 2025 年 PM2.5 年均值评价依据

问题：

```text
北京市2025年PM2.5年均值评价应依据哪些现行标准？请给出标准编号。
```

结果：

- `evidenceState=partial`
- `recommendedNextTool=both`
- `answerBasis=evidence_explanation`
- `rankingSignals=ambient_air_quality_limit_question`
- 出现 invalid evidence ids：
  - `item-e34f75ff#chunk-8`
  - `item-324b43ea#chunk-14`
  - `pm10-pm2-5-19e3ca97#chunk-4`

问题：

- 用户问“依据哪些标准”，不是查询实际监测数据；由于出现“北京市、2025年、PM2.5年均值”，路由被误判为 `both`。
- 对“2025 年评价期”缺少时态判断。2026-05-01 当前 GB 3095-2026 已实施，但评价 2025 年年均值时，系统应能区分“当前问答时间的现行依据”和“评价期当时有效依据”。
- 回答引用了 source/chunk id 而不是 evidence item id `[E1]`，说明 grounding 层对引用格式缺少最终强约束。

#### 查询 C：臭氧日最大8小时平均第90百分位数数据有效性边界

问题：

```text
环境空气臭氧日最大8小时平均第90百分位数评价需要注意哪些数据有效性边界？
```

结果：

- `evidenceState=partial`
- `recommendedNextTool=knowledge_base`
- `answerBasis=evidence_explanation`
- `rankingSignals=ambient_air_quality_limit_question`
- `standard_exact:used:8`
- `structured_fact:planned:0`
- 证据集中混入大气法、颗粒物手工比对、月报、编制说明等材料；未稳定命中 HJ 663 当前评价技术规范和相关有效性条款。

问题：

- 当前规则把含 O3、日最大8小时、评价的查询归入“限值问题”，没有更细的“评价统计/百分位/数据有效性”意图。
- `search.ts` 的领域 boost 主要围绕 GB 3095 浓度限值、AQI、修改单，缺少对 `百分位`、`第90百分位数`、`有效数据`、`数据有效性`、`HJ 663` 的专门但可泛化的 ranking signal。
- 结构化 fact 抽取尚未把“有效性规则、统计期、百分位公式/边界”作为高优先级 fact 类型。

## 3. 是否需要第二轮源码修改

需要。原因如下：

1. `lint --deep` 是运行级失败，不是知识库内容质量问题，必须改源码。
2. heuristic fallback 中至少 3 个是 schema 容错问题，2 个是 timeout/retry 问题，不能靠清理源文件彻底解决。
3. O3 第90百分位、2025 年评价依据、当前标准替代关系都是环保局业务高频问题，当前结果没有达到专业可用标准。
4. Deer-flow agent 后续通过 MCP 调用知识库，如果 `answerBasis`、`recommendedNextTool`、`evidenceState`、引用 ID 不稳定，会直接影响 agent 的工具选择和报告可靠性。
5. 普通 lint 暴露的 draft/core、noisy entity、stale output 需要变成更系统的质量治理机制，否则后续公共库和项目私有报告库扩张后会积累噪声。

## 4. 源代码修改方案

### P0-1：提交并加固结构化 fact stable id 去重

相关文件：

- `packages/engine/src/fact-extraction/facts.ts`
- `packages/engine/test/env-air-facts.test.ts`
- `packages/engine/src/search.ts`

现状：

- 工作区已经实现 `structuredFactsFromBlocks()` 内部 `seenStableIds` 去重，并增加测试。
- 这能解决重复 block 产生相同 stable fact id 的主问题。

继续修改：

1. 保留并提交当前 `facts.ts` / `env-air-facts.test.ts` 改动。
2. 在 `rebuildSearchIndex()` 的 fact 插入循环中增加第二道防线：
   - 用 `seenFactRowIds` 记录 `${page.id}:${fact.id}`。
   - 重复时跳过并记录内部计数。
   - 不建议直接改成 `INSERT OR IGNORE` 作为唯一手段，因为静默忽略会隐藏 fact 抽取重复问题。
3. 在 retrieval/index rebuild 的 debug 或 session stats 中输出 `dedupedFacts`。

验证：

```powershell
pnpm --filter @swarmvaultai/engine test -- env-air-facts env-air-retrieval
pnpm --filter @swarmvaultai/engine typecheck
```

### P0-2：建设通用结构化输出容错层，减少 GLM-5 fallback

相关文件：

- `packages/engine/src/types.ts`
- `packages/engine/src/providers/base.ts`
- `packages/engine/src/providers/openai-compatible.ts`
- 新增：`packages/engine/src/providers/structured-repair.ts`
- `packages/engine/src/analysis.ts`
- `packages/engine/src/deep-lint.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/test/openai-provider.test.ts`
- `packages/engine/test/openai-compatible-capabilities.test.ts`
- 新增测试：`packages/engine/test/structured-repair.test.ts`

核心设计：

1. 给 `ProviderAdapter.generateStructured()` 增加可选第三参数：

```ts
interface StructuredGenerationOptions {
  schemaName?: "source_analysis" | "deep_lint" | "grounded_answer" | "topic_synthesis" | string;
  coercion?: "strict" | "safe";
  maxRepairAttempts?: number;
  allowedEvidenceIds?: string[];
}
```

接口约束：

- 第三参数必须是 optional，旧调用签名保持可编译。
- `BaseProviderAdapter.generateStructured()` 和 `OpenAiCompatibleProviderAdapter.generateStructured()` 都必须接受该参数；Anthropic/Gemini/Heuristic/LocalWhisper 等继承 base 的 provider 不需要额外实现。
- 所有 `provider.generateStructured(...)` 调用点可以分批补充 `schemaName`，但不能要求一次性全改完才能通过测试。
- `StructuredGenerationOptions` 和 repair 结果类型应放在 `types.ts` 或新文件再统一导出，避免 provider 层和业务层循环依赖。

2. 新增 `structured-repair.ts`，实现通用而非业务个例的修复：
   - JSON 提取失败：保留原错误。
   - Zod issue 为 `too_big`：按 schema path 截断数组，例如 `claims` 最多 8、`findings` 最多 20。
   - Zod issue 为 `invalid_type` 且期望 string：
     - 优先提取常见字段 `text`、`summary`、`citation`、`id`、`value`；只有非关键说明性字段才允许退化为紧凑 JSON 字符串。
   - Zod issue 为 enum invalid：
     - 对深度 lint code 使用 `normalizeDeepLintCode()` 映射到允许枚举，同时保存 raw code。
     - 对 authority/document/legal 字段不得任意近义映射为强制依据；非法值应进入 `unknown` 或由 `inferDomainMetadata()` 规则重新判断。
   - null object field：继续执行现有 `stripNullObjectProperties()`，但不得删除整个 required object。
   - repair prompt 要包含精确 path 和 expected/received，不能只说“返回合法 JSON”。
   - repair 应返回 `{ value, warnings }`，warnings 需要进入 source analysis warnings、query groundingWarnings 或 lint finding message。

3. `openai-compatible.ts` 的 `generateStructured()` 流程改为：
   - initial parse
   - local safe coercion
   - issue-guided repair
   - repair 后 local safe coercion
   - 最后仍失败才 throw

4. 对 `source_analysis`：
   - `claims` 超过 8 条时截断，不 fallback。
   - `summary` 非字符串时优先取 `summary.text`、`summary.value` 或首个字符串字段；无法提取时再发起 repair，不应直接把整个 object stringify 成可读摘要。
   - `claims[].citation` 非字符串时规范为 source id 或紧凑字符串。
   - `domain` 中影响权威性的字段如果非法，不能“猜测修好”；应保留规则推断值，并在 `llmUncertainFields` 中记录原字段。

5. 对 `grounded_answer`：
   - `recommendedNextTool` 近义值归一。
   - `usedEvidenceIds` 只允许 evidence set 中存在的 E 编号，其他进入 `unsupportedClaims` 或 `missingEvidence`。
   - 如果模型回答正文引用了 source id/chunk id，交给 P0-4 的 citation normalizer 处理，不在 provider 层做业务替换。

验证：

- 构造 GLM-5 常见坏输出样例：
  - `claims` 9 条以上。
  - `summary` 为 object。
  - `claims[].citation` 为 object。
  - `findings[].code` 为未知近义 code。
- 构造危险输出样例：
  - `legalStatus: "current"`、`authorityLayer: "binding"`、`documentRole: "law-like"`，确认不会被自动提升为 `current_effective/core/standard`。
- 确认不进入 heuristic fallback，不中断 lint/query。

### P0-3：修复 `lint --deep` 的 provider 失败中断

相关文件：

- `packages/engine/src/deep-lint.ts`
- `packages/engine/src/findings.ts`
- `packages/engine/src/types.ts`
- `packages/engine/test/consolidate-cli.test.ts` 或新增 `deep-lint.test.ts`

修改内容：

1. 将 `deepLintResponseSchema.findings[].code` 从严格 enum 改为输入可接收 string，随后在代码中归一为允许的 lint code。
2. 新增：

```ts
function normalizeDeepLintCode(raw: string): LintFinding["code"]
```

建议映射：

- 包含 `contradict` / `冲突`：`contradiction_candidate`
- 包含 `citation` / `引用`：`missing_citation`
- 包含 `coverage` / `gap` / `缺口`：`coverage_gap`
- 包含 `candidate` / `page`：`candidate_page`
- 其他：`follow_up_question`

3. 为 `LintFinding` 增加可选 `metadata?: Record<string, unknown>`，用于记录：
   - `providerId`
   - `providerModel`
   - `rawCode`
   - `normalizedCode`
   - `providerError`
   这比把所有细节拼进 message 更利于后续质量报告和 deer-flow 侧诊断。
4. provider 调用放入 `try/catch`。失败时返回：

```ts
{
  severity: "warning",
  code: "deep_lint_provider_error",
  message: "Deep lint provider failed; deterministic lint findings were still returned. ...",
}
```

5. 无论 provider 成败，都要保留 deterministic findings。
6. `runConfiguredRoles()` 也应单独 try/catch，防止角色审计失败中断 lint。
7. Windows Node 原生断言方面：
   - `openai-compatible.ts` 的 `requestJson()` 在 abort 后不要重复 close/abort handle。
   - timeout 后统一抛出普通 Error，避免 repair 再次立即复用异常状态。
   - 增加进程级回归测试或手工脚本，确认 `lint --deep` provider parse failure 后进程能正常退出；不要把 Node 内部 assertion 作为业务逻辑可完全控制的前提。

验证：

```powershell
node D:\Github\swarmvault\packages\cli\dist\index.js lint --deep
```

预期：即使 GLM-5 返回未知 code，也退出码 0；若 provider 完全失败，则输出 `deep_lint_provider_error` warning，而不是崩溃。

### P0-4：修复查询引用 ID 的强 grounding

相关文件：

- `packages/engine/src/vault.ts`
- `packages/engine/src/mcp.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

问题：

- 真实查询中出现 invalid evidence ids：模型引用了 source/chunk id，而不是 evidence item id `[E1]`。

修改内容：

1. 在 `evaluateGrounding()` 前增加 `normalizeAnswerEvidenceCitations()`：
   - 建立 alias map：
     - evidence id：`E1`
     - citation：`sourceId#chunkId`
     - pageId
     - chunkId
     - factId / factStableId / factLegacyIds
     - canonicalAliases
   - 将模型输出中的 `[sourceId#chunk]`、`[chunk-id]`、`[fact:...]` 尽量替换为 `[E#]`。
2. 对无法映射的引用：
   - strict/debug 模式：降级为 `partial`，加入 `invalid_citation_rewritten_failed`。
   - 普通模式：删除无效引用并在 `groundingWarnings` 记录。
3. `groundedAnswerSchema.usedEvidenceIds` 也要做同样校验，不允许不存在的 evidence id 进入 coverage。
4. query prompt 增加更明确要求：
   - “只引用 evidence item id，例如 [E1]；不要引用 source id、chunk id、文件名或标准号作为 citation。”
5. 在 `QueryResult` 中保留现有 `invalidCitations` 字段语义，同时新增或复用 warning：
   - `citation_alias_rewritten:<raw>-><E#>`
   - `invalid_citation_unmapped:<raw>`
   这样 deer-flow 可以区分“已自动修复”和“仍不可作为报告依据”。
6. MCP `query_vault` 输出结构不能变成只返回文本；必须继续通过 `asToolText(result)` 返回完整 JSON 字段，确保 deer-flow 能读取 `evidenceState`、`agentDecision`、`invalidCitations`。

验证：

- 增加测试：模型返回 `[item-e34f75ff#chunk-8]` 时能映射为 `[E#]` 或被阻断。
- 重新测试北京市 2025 PM2.5 问题，不应再出现 invalid evidence ids。

### P1-0：统一 domain profile、query plan 和工具路由入口

相关文件：

- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/domain/intents.ts`
- `packages/engine/src/domain/profile-loader.ts`
- `packages/engine/src/types.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/search.ts`
- `packages/engine/src/mcp.ts`
- `packages/engine/test/env-air-tool-routing.test.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

问题：

- `buildDomainQueryPlan(query, profile)` 已经支持从 vault config 加载的 `domain.profilePath`。
- 但 `classifyEnvAirToolRouting()`、`buildEnvironmentDataToolHints()` 仍使用 `DEFAULT_ENV_AIR_PROFILE` 常量。
- `vault.ts` 还使用 `buildEnvAirQueryPlan(question)` 提取标准片段和计算 required standards，容易和 profile-aware plan 不一致。

修改内容：

1. 将 `classifyEnvAirToolRouting()` 改为接受可选 profile：

```ts
function classifyEnvAirToolRouting(question: string, profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE): ToolRoutingDecision
```

2. 将 `buildEnvironmentDataToolHints()` 同步改为 profile-aware。
3. `vault.ts` 中使用同一个 `queryPlan` 贯穿：
   - tool routing
   - required standards
   - strict exact term exclusion
   - standard coverage
   - retrieval debug
4. `buildEnvAirQueryPlan()` 如果继续保留，应只作为兼容 wrapper，内部调用 `buildDomainQueryPlan(query, DEFAULT_ENV_AIR_PROFILE)`；不要维护两套规则。
5. `profile-loader.ts` 对 `intentRules`、`standardCatalog` 的加载语义要明确：
   - 如果用户只想追加规则，应支持 `intentRulesAppend` 或 documented merge 策略。
   - 如果用户显式覆盖，应能通过 `replaceDefaults: true` 表达，避免自定义 profile 意外丢掉默认规则。
6. 将 `QueryRetrievalPlan` 增加 `profileId`、`matchedIntentRules`，方便测试人员判断规则来自默认 profile 还是 vault profile。

验证：

- 使用默认 profile 和自定义 profile 各跑一组工具路由测试。
- 自定义 profile 添加一个新 intent rule 后，query debug 中能看到 `matchedIntentRules`。
- 现有默认环境空气测试保持通过。

### P1-1：修复 answerBasis 与 currentBasisQuery 脱节

相关文件：

- `packages/engine/src/vault.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

修改内容：

1. 改造 `inferAnswerBasis()`：

```ts
function inferAnswerBasis(
  options: QueryOptions | undefined,
  recommendedNextTool: QueryResult["recommendedNextTool"],
  context: { currentBasisQuery?: boolean; historicalEvaluationIntent?: boolean }
): QueryResult["answerBasis"]
```

2. 优先级：
   - `environment_data_mcp`：`data_required`
   - `historicalEvaluationIntent` 或 `intent === "evolution"`：`historical_or_evolution`
   - `currentBasisQuery` 或 `requireCurrentBasis`：`current_effective`
   - local：`local_adaptation`
   - 其他：`evidence_explanation`

3. 所有 return path 都传入 `currentBasisQuery`，包括：
   - no evidence
   - strict grounding blocked
   - normal answer

验证：

- “现行环境空气质量标准应依据 GB 3095-2026 还是 GB 3095-2012” 返回 `answerBasis=current_effective`。

### P1-2：增加环境空气查询时态和评价期解析

相关文件：

- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/domain/intents.ts`
- `packages/engine/src/types.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/search.ts`
- `packages/engine/src/mcp.ts`
- `packages/engine/test/env-air-tool-routing.test.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

目标：

解决“当前日期为 2026-05-01，但用户问 2025 年评价依据”的时态混淆。

新增结构：

```ts
interface EnvAirTemporalIntent {
  asOfDate?: string;
  asOfYear?: number;
  evaluationPeriodYear?: number;
  mode: "current_now" | "historical_as_of" | "evaluation_period" | "unspecified";
  conflict?: "current_vs_evaluation_period" | "current_vs_historical_version";
}
```

解析规则：

- `2025年PM2.5年均值评价`：`evaluationPeriodYear=2025`
- `当时/彼时/历史版本/2013版`：`historical_as_of`
- `现行/目前/现在应依据`：`current_now`
- 同时出现“现行”和历史年份时，回答必须区分：
  - 当前现行依据
  - 评价期当时有效依据
  - 是否存在过渡条款或实施日期

接口调整：

- `QueryOptions` 增加可选字段：
  - `asOfDate?: string`
  - `evaluationPeriod?: string`
  - `evaluationYear?: number`
- `QueryRetrievalPlan` 增加：
  - `temporalIntent?: EnvAirTemporalIntent`
- `QueryResult` 可增加：
  - `temporalIntent?: EnvAirTemporalIntent`
- MCP `query_vault` input schema 增加 `asOfDate`、`evaluationYear`，但保持可选，旧 deer-flow 调用不受影响。

检索策略：

- `evaluation_period` 时，不应只 boost 当前 effective；应把 `evidence_period`、`standard_year`、`legal_status`、`implementation/effective date` 纳入排序。
- 对 GB/HJ 标准替代关系，优先检索 current + superseded pair，而不是只取 current。
- 对“现行 + 历史评价期”冲突，不应自动删掉 superseded；应检索 current 和当期可能有效版本，然后让回答显式说明适用边界。
- 如果知识库缺少标准实施日期或替代关系证据，`evidenceState` 应为 `partial`，`missingEvidence` 明确写“缺少实施日期/过渡条款证据”。

验证：

- 北京市 2025 PM2.5 年均值评价问题应说明：
  - 如果问“2025 年评价期当时依据”，需要优先核验当时有效版本。
  - 如果问“现在写报告采用现行标准”，需要说明现行版本及实施日期。
  - 在证据不足时明确缺口，而不是混用当前标准和历史数据。

### P1-3：修复工具路由过宽问题

相关文件：

- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/domain/env-air-profile.ts`
- `packages/engine/src/domain/intents.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/test/env-air-tool-routing.test.ts`

问题：

- 当前 `classifyEnvAirToolRouting()` 中 `hasDataFrame && hasDataOperation` 会让“北京市 + 2025年 + 评价”误判为需要 data MCP。
- “评价依据/标准编号/计算口径”是知识库问题，即使包含城市、年份、污染物，也不一定需要环境数据 MCP。

修改内容：

1. 新增 `basisOnlySignals`：
   - `依据`
   - `标准编号`
   - `适用标准`
   - `采用哪些标准`
   - `评价方法`
   - `计算口径`
2. 若 `basisOnlySignals` 存在，且没有明确的数据动作，则强制 `knowledge_base`。明确的数据动作包括：
   - `查询实际浓度`
   - `是否超标`
   - `排名`
   - `同比/环比`
   - `污染过程`
   - `异常诊断`
   - `调用环境数据MCP`
3. 保留“今天某城市 SO2 小时浓度是否超标”这类问题为 `both`。
4. 对 `年均值评价` 做区分：
   - 问实际年均值/是否达标：`both`
   - 问评价依据/标准编号/方法：`knowledge_base`
5. 路由判断必须使用 P1-0 的 profile-aware 入口，不能在 `env-air.ts` 中继续复制一套默认词表。
6. `ToolRoutingDecision.reasons` 增加更可解释的 reason：
   - `basis_only_question`
   - `actual_monitoring_data_required`
   - `temporal_context_without_data_request`

验证：

- 北京市 2025 PM2.5 年均值评价依据：`knowledge_base`
- 今天某城市 SO2 小时浓度是否超标：`both`

### P1-4：增加“评价统计/百分位/数据有效性”泛化意图，不做单标准补丁

相关文件：

- `packages/engine/src/domain/env-air-profile.ts`
- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/search.ts`
- `packages/engine/src/domain/env-air-facts.ts`
- `packages/engine/src/fact-extraction/document-structure.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

目标：

不是硬编码“HJ 663 fact”，而是针对一类业务问题建立可扩展能力：

- 第90百分位数
- 数据有效性
- 有效数据
- 统计期
- 日最大8小时平均
- 达标评价
- 年评价
- percentile / P90 / MDA8

修改内容：

1. 优先通过 domain profile 新增 intent rule。默认 profile 可以内置一条通用规则，但公共知识库 vault 也应能通过 `domain.profilePath` 覆盖或追加：

```ts
{
  id: "ambient_air_assessment_validity_question",
  priority: 110,
  anyText: ["第90百分位", "百分位", "90百分位", "P90", "数据有效性", "有效数据", "有效性", "日最大8小时", "MDA8", "达标评价"],
  expandedTerms: ["HJ 663", "HJ 663-2026", "环境空气质量评价技术规范", "数据统计有效性", "第90百分位数", "臭氧日最大8小时平均"],
  pinnedStandards: ["HJ 663", "HJ 663-2026", "GB 3095", "GB 3095-2026"],
  rankingSignals: ["ambient_air_assessment_validity_question"]
}
```

2. `search.ts` 增加 ranking signal 处理：
   - 对 `ambient_air_assessment_validity_question`：
     - boost `standard_identity = HJ 663`
     - boost `fact_type in ("validity_rule", "formula", "technical_parameter")`
     - boost chunk text 命中 `百分位`、`第90百分位`、`有效数据`、`数据统计有效性`、`日最大8小时`
     - boost `authority_layer in ("core","method")` 且 `legal_status=current_effective`
   - 不应把 GB 3095 限值表永远排在 HJ 663 评价方法前。
   - 不应把 HJ 663 写成唯一特例；ranking 规则应表达为“评价规范/数据有效性/百分位统计问题优先 method/core + validity/formula chunks”，HJ 663 只是当前环境空气 profile 的 pinned standard。

3. `env-air-facts.ts` / `document-structure.ts`：
   - 当前 `StructuredFactKind` 已有 `validity_rule`，应先增强识别词和 `searchText`，不要立即增加一批新 fact kind。
   - 对 `百分位`、`第90百分位`、`P90`、`日最大8小时`、`有效数据`、`最少有效天数`、`统计期` 等关键词，归入 `validity_rule` 或 `formula`，并通过 `qualifiers.metric`、`qualifiers.percentile`、`averagingPeriod` 表达细分语义。
   - 只有当测试证明 `validity_rule + qualifiers` 无法支撑排序和回答时，再新增 `percentile_rule` / `averaging_period_rule`，并同步修改类型、测试和质量报告。
   - 对表格、公式、条款标题中包含上述关键词的 block 建立 structured facts。

4. `vault.ts`：
   - 对这种查询，在 context prompt 中强调“优先表/公式/条款 evidence，不足时列缺口”。
5. `QueryRetrievalPlan.rankingSignals` 和 `stages` 应能显示该规则是否命中，避免测试人员只能从最终答案倒推。

验证：

- 臭氧日最大8小时平均第90百分位数数据有效性问题应至少检索到 HJ 663 当前评价规范或明确指出 HJ 663 条款缺口。
- `structured_fact` 阶段应从 planned 变成 used，或 chunk evidence 明确来自相关条款。

### P1-5：改进 source analysis 的重试和局部重建能力

相关文件：

- `packages/engine/src/analysis.ts`
- `packages/engine/src/providers/openai-compatible.ts`
- `packages/engine/src/vault.ts`
- `packages/cli/src/index.ts`
- `packages/engine/src/types.ts`
- 新增测试：`packages/engine/test/source-analysis-retry.test.ts`

修改内容：

1. `providerAnalysis()` 增加重试策略：
   - schema parse error：先本地 safe coercion。
   - 仍失败：带 Zod issue 的 repair。
   - 超时：用更短 excerpt 重试一次，例如 8000-10000 chars，保留 title、source id、标准号、目录/表格优先段落。
   - retry 不应无限递归；每个 source 最多 `initial + repair + compact_retry` 三段，超过后按 failurePolicy 处理。
2. `analyzeSource()` 不应直接从一次 provider failure 跳到 heuristic。
3. analysis artifact 增加：

```ts
providerFailures?: Array<{
  phase: "initial" | "repair" | "compact_retry";
  error: string;
  producedAt: string;
}>
```

4. 扩展现有 `analysis` 配置，而不是新建重复配置。当前 config 已有：
   - `analysis.failurePolicy`
   - `analysis.maxFallbackRatio`
   - `analysis.concurrency`
   应在此基础上增加：
   - `analysis.retryOnSchemaError?: boolean`
   - `analysis.retryOnTimeout?: boolean`
   - `analysis.compactRetryChars?: number`
   - `analysis.structuredRepair?: "off" | "safe" | "strict"`
5. CLI 新增命令：

```powershell
swarmvault analysis status
swarmvault analysis retry --mode heuristic
swarmvault analysis retry --source <sourceId>
```

6. `compile --force-analysis` 保持全量能力，但新增 retry 命令用于后续低成本修复少量 fallback。
7. 重试命令必须只重建目标 source 的 analysis 和依赖页面，再刷新 graph/search；不能无意触发 997 份全量 LLM 重编译。

验证：

- 对 5 份 heuristic source 重试后，schema 解析类至少应转为 provider。
- 超时类若仍失败，应留下更明确的 provider failure trail。

### P1-6：PDF 空提取治理与 OCR fallback

相关文件：

- `packages/engine/src/extraction.ts`
- `packages/engine/src/ingest.ts`
- `packages/engine/src/config.ts`
- `packages/engine/src/types.ts`
- `packages/engine/test/vault.test.ts`
- 文档：`docs/pdf-extraction.md`

数据源处理建议：

- 对 3 份 empty PDF，不应直接删除。它们可能是法规/政策/蓝皮书摘要，业务价值高。
- 先人工确认 PDF 是否扫描件、加密件、图片型 PDF 或文字层损坏。
- 若有可下载的文本版/HTML版/官方网页版，优先替换或补充为 raw source。
- 若只能用扫描版，应启用 OCR。

源码修改：

1. config 增加：

```json
{
  "extraction": {
    "pdf": {
      "emptyTextPolicy": "warn",
      "ocrFallback": false,
      "minExtractedChars": 80
    }
  }
}
```

2. `extraction.ts`：
   - 如果 PDF 提取文本低于阈值，写入 `extraction.emptyReason`。
   - 若启用 OCR fallback，则调用 vision/OCR provider。
   - OCR 结果必须写入 provenance，例如 `extraction.textProvenance: "ocr"`，并在 source page frontmatter 或 analysis warnings 中保留。
3. `lint` 增加 `empty_source_extraction` warning，优先级高于普通 orphan。
4. `compile` summary 增加 empty extraction 计数。
5. 默认配置应为 `ocrFallback: false`，避免全量构建时意外产生大量视觉模型成本。
6. 对 OCR 文本的权威性处理应更保守：可以作为检索文本，但涉及限值、实施日期、替代关系等强依据字段时，应要求结构化 fact 或人工复核标记。

验证：

- 当前 3 份 empty source 应在 lint/compile summary 中清晰列出。
- 启用 OCR 后应能生成 non-empty extraction artifact。

### P1-7：修复 draft/core 和 noisy promoted page 治理

相关文件：

- `packages/engine/src/domain/env-air.ts`
- `packages/engine/src/deep-lint.ts`
- `packages/engine/src/markdown.ts`
- `packages/engine/src/consolidate.ts`
- `packages/engine/test/consolidate-cli.test.ts`

修改内容：

1. `inferDomainMetadata()` 中对标题/路径/正文含 `征求意见稿`、`草案`、`编制说明` 的材料，优先覆盖目录推断：
   - `authorityLayer=evolution`
   - `legalStatus=draft_consultation` 或 `explanation_only`
   - `documentRole=draft` 或 `compilation_explanation`
2. 对 concept/entity 晋升增加“文件型标题”抑制：
   - `参考文件`
   - `编制说明`
   - `执行摘要`
   - `全文`
   - `附件`
   - `目录`
   这些不应默认晋升为稳定专业概念/实体，应保留为 source 或 candidate。
3. `lint` 对 noisy promoted page 提供可执行 suggested action：
   - demote to candidate
   - merge into source/module page
   - add alias only

验证：

- `2024_生态环境监测条例_草案征求意见稿` 不再进入 core。
- 欧盟 BAT 文件型页面不再作为稳定 entity 晋升，或被 lint 指出明确处理建议。

### P1-8：输出页 stale/ungrounded 的生命周期治理

相关文件：

- `packages/engine/src/outputs.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/markdown.ts`
- `packages/engine/test/output-automation.test.ts`

问题：

- `wiki\outputs\2025-pm2-5.md` 既 stale 又 ungrounded，说明保存的旧 query output 没有随 schema/grounding 变化自动失效或重建。

修改内容：

1. output frontmatter 记录：
   - `query_hash`
   - `schema_hash`
   - `retrieval_manifest_hash`
   - `grounding_version`
   - `citation_count`
2. 当 schema/retrieval/grounding version 改变：
   - lint 标记为 `stale_output_requires_regeneration`
   - 可选 `swarmvault outputs refresh --stale`
3. 对 citation_count=0 的 output：
   - 若是知识库问答输出，warning。
   - 若是草稿/人工 insight，可通过 frontmatter 标记 `grounding_required: false`。

验证：

- stale output 能被自动识别并可单独刷新。

### P1-9：SaaS 多用户和项目私有知识隔离回归

相关文件：

- `packages/engine/src/search.ts`
- `packages/engine/src/vault.ts`
- `packages/engine/src/mcp.ts`
- `packages/engine/src/outputs.ts`
- `packages/engine/test/projects.test.ts`
- `packages/engine/test/env-air-retrieval.test.ts`

背景：

- 当前阶段重点是公共知识库，但业务目标是 deer-flow 以 SaaS 方式服务多用户，并将用户报告、方案、分析稿作为项目私有知识继续复用。
- 项目已有 `scope`、`tenantId`、`projectId`、`visibility`、`sourceScope` 字段，但本轮方案原先没有把这些字段纳入质量回归。

修改内容：

1. `queryVault()` 的默认 scope 行为必须明确：
   - 公共库查询默认 `public_only` 或现有行为需在文档中明确。
   - deer-flow 传入 `tenantId/projectId` 时，才允许混合公共与项目私有证据。
2. `EvidenceItem`、`QueryResult.evidenceSet`、`agentDecision` 必须保留 `visibility`、`sourceScope`、`tenantId`、`projectId` 信息，便于 deer-flow 决定报告中是否可引用。
3. 私有报告作为 evidence 时，应在 `authorityBoundary` 中不能被当成公共强制依据，只能作为项目上下文、历史写作口径或 draft text。
4. output save 时，如果答案使用了 tenant/project evidence，输出页必须带对应 `visibility`、`tenant_id`、`project_id`，避免私有内容被保存进公共 wiki。
5. MCP `query_vault` 对 `scope/tenantId/projectId` 的输入说明需要更明确，防止 deer-flow 调用时误把私有项目问题按公共库回答。

验证：

- 构造公共 source + tenant_private report + project_private report。
- `scope=public_only` 时不得返回私有 evidence。
- `scope=tenant_only` 时不得返回其他 tenant evidence。
- `scope=mixed_public_private` 时可以返回公共 + 指定 tenant/project evidence，但 `agentDecision.privateKnowledgeUsed=true`。
- 使用私有报告回答时，`answerBasis` 不得是 `current_effective`，除非同时有公共/现行标准 primary evidence 支撑。

### P2-1：检索索引健康检查增强和非 Vault 目录误用保护

相关文件：

- `packages/engine/src/retrieval.ts`
- `packages/engine/src/config.ts`
- `packages/cli/src/index.ts`
- `packages/engine/test/retrieval.test.ts`

背景：

- 本轮测试中曾从源码目录直接执行 query，CLI 把 `D:\Github\swarmvault` 当作 vault root，报出空索引/列缺失错误。实际公共库索引没有坏，但 CLI 对“非 vault 目录误用”的提示不够清楚。

修改内容：

1. `getRetrievalStatus()` 不只检查文件存在，还检查：
   - sqlite 文件大小 > 0
   - 必需表存在：`pages`、`chunks`、`facts`
   - 必需列存在：`standard_identity`、`fact_stable_id` 等
   - page count 与 manifest 一致
2. `doctorRetrieval --repair` 遇到空库/旧 schema 自动 rebuild。
3. CLI 查询、lint、retrieval 命令启动时检查当前目录是否有：
   - `swarmvault.schema.md`
   - `swarmvault.config.json`
   - `state/graph.json`
   若缺失，提示：
   - “当前目录不像 SwarmVault vault，请切换到 vault 根目录或指定 --vault。”
4. 评估增加全局 `--vault <path>` 参数，避免用户必须 cd。
5. `RetrievalManifest` 增加 `schemaVersion` 或 `indexSchemaHash`，由索引建表字段列表计算；代码新增字段后即使 graph hash 未变，也能识别旧索引需要重建。
6. `searchPages()` 遇到 SQLite schema error 时，不应返回空结果或抛出难懂 SQL 错误；应提示运行 `swarmvault retrieval doctor --repair`。

验证：

- 从源码目录误执行 query 时，不再出现 SQL 列错误，而是明确提示路径问题。
- 手工删除或改旧索引列后，`retrieval status` 应显示 stale 或 schema mismatch。

### P2-2：消除 build 的 Node DEP0190 警告

相关文件：

- `packages/engine/scripts/build.mjs`
- `packages/engine/scripts/test.mjs`
- 可能涉及 `scripts/release-*.mjs`

修改内容：

1. 定位 `spawn` / `spawnSync` 中 `shell: true` 且同时传 args 的调用。
2. Windows 下改为：
   - 直接调用可执行文件并传 args；或
   - 如果必须 shell，使用完整 command string，不再传 args 数组。
3. 增加测试或至少手动验证 Windows build/test。

验证：

```powershell
pnpm --filter @swarmvaultai/engine build
```

预期：不再出现 `[DEP0190]`。

### P2-3：增加质量报告和 fallback 可观测性

相关文件：

- `packages/engine/src/vault.ts`
- `packages/engine/src/analysis.ts`
- `packages/engine/src/deep-lint.ts`
- `packages/cli/src/index.ts`
- 新增文档：`docs/env-public-quality-ops.md`

新增能力：

1. `swarmvault quality report`
   - analysis mode 分布
   - fallback source 列表
   - empty extraction 列表
   - deep lint provider status
   - top lint warnings
   - query golden set summary
2. compile session 中保存：
   - provider failure count
   - fallback count
   - empty count
   - structured repair count
   - invalid citation rewrite count
3. 支持输出 JSON，便于 deer-flow 或 CI 读取。

验证：

- 构建完知识库后，一条命令能生成“是否可上线”的质量摘要。

## 5. 数据源是否需要清理

需要，但只针对 3 份 empty extraction 优先清理，不建议把 heuristic fallback 当作数据源清理问题。

### 应优先处理的数据源

1. `污染源自动监控设施现场监督检查办法_环保部19号令`
2. `2023_空气质量持续改善行动计划`
3. `《中国大气臭氧污染防治蓝皮书（2023 年）》执行摘要`

处理顺序：

1. 检查原 PDF 是否为扫描件或图片型 PDF。
2. 如能找到官方 HTML/Word/文本版，优先替换或作为补充 source。
3. 如只有扫描版，启用 OCR fallback。
4. 若 OCR 后仍不可用，在 metadata 中标记 `extraction_status: empty`，避免被当成可用证据。

### 不建议清理的数据源

5 份 heuristic fallback 不应直接删或重排目录，因为失败原因主要是：

- GLM 输出比 schema 多。
- GLM 字段类型轻微不合规。
- 长文档调用超时。

这些都是源码处理能力不足，清理数据源只能掩盖问题。

## 6. 推荐实施顺序

### 第一批：必须先做

1. 提交当前 fact stable id 去重修复。
2. 实现通用结构化输出容错层。
3. 修复 `lint --deep` provider 失败中断。
4. 修复 grounding 引用 ID 归一/阻断。
5. 修复 `answerBasis` 与 `currentBasisQuery` 脱节。
6. 保证 MCP `query_vault` 输出结构兼容旧 deer-flow 调用。

完成后验证：

```powershell
pnpm --filter @swarmvaultai/engine typecheck
pnpm --filter @swarmvaultai/engine test -- openai-provider openai-compatible-capabilities env-air-facts env-air-retrieval env-air-tool-routing
pnpm --filter @swarmvaultai/cli test
node D:\Github\swarmvault\packages\cli\dist\index.js lint --deep
```

### 第二批：业务质量提升

1. 统一 domain profile、query plan 和工具路由入口。
2. 增加时态/评价期解析。
3. 修复工具路由过宽。
4. 增加评价统计/百分位/数据有效性泛化意图。
5. 增强 structured fact 的 `validity_rule`、qualifiers 和 searchText，而不是优先新增细碎 fact kind。
6. 增加 source analysis retry 命令。
7. 增加 SaaS 多用户和项目私有知识隔离回归。

完成后验证三条核心业务查询：

```powershell
node D:\Github\swarmvault\packages\cli\dist\index.js query "现行环境空气质量标准应依据 GB 3095-2026 还是 GB 3095-2012？请说明依据和适用边界。" --no-save --json --debug-context --return-decision-contract

node D:\Github\swarmvault\packages\cli\dist\index.js query "北京市2025年PM2.5年均值评价应依据哪些现行标准？请给出标准编号。" --no-save --json --debug-context --return-decision-contract

node D:\Github\swarmvault\packages\cli\dist\index.js query "环境空气臭氧日最大8小时平均第90百分位数评价需要注意哪些数据有效性边界？" --no-save --json --debug-context --return-decision-contract
```

预期：

- 第一条：`answerBasis=current_effective`。
- 第二条：不误判必须调用数据 MCP；能区分当前现行和 2025 评价期。
- 第三条：能命中 HJ 663/GB 3095 的评价有效性证据，或明确列出缺失条款。
- 三条均不得出现 invalid evidence ids。

### 第三批：治理和运维

1. PDF OCR fallback 和 empty extraction lint。
2. draft/core、noisy promoted page 治理。
3. output stale/ungrounded 生命周期治理。
4. retrieval doctor 表结构检查和 `--vault` 支持。
5. build DEP0190 消除。
6. `quality report`。

## 7. 回归测试清单

源码测试：

```powershell
pnpm --filter @swarmvaultai/engine typecheck
pnpm --filter @swarmvaultai/cli typecheck
pnpm --filter @swarmvaultai/engine test
pnpm --filter @swarmvaultai/cli test
pnpm --filter @swarmvaultai/engine build
```

Vault 测试：

```powershell
cd D:\kb\env-public\vault
node D:\Github\swarmvault\packages\cli\dist\index.js retrieval status
node D:\Github\swarmvault\packages\cli\dist\index.js lint
node D:\Github\swarmvault\packages\cli\dist\index.js lint --deep
```

Fallback 测试：

```powershell
# 统计 state\analyses 中 analysisMode 分布
# 预期：heuristic 降低，empty 只保留真实 OCR/源文件问题
```

业务查询测试：

至少覆盖：

1. 现行执行依据。
2. 历史版本/替代关系。
3. 评价期和当前日期冲突。
4. AQI/IAQI 计算。
5. O3 MDA8 第90百分位及数据有效性。
6. 纯标准依据问题不调用数据 MCP。
7. 实际城市/站点/时段数据问题调用或建议数据 MCP。
8. 不存在标准编号的拒答和替代证据。
9. 草案/编制说明不能作为直接执法依据。
10. 地方规则不能外推到其他地区。
11. 自定义 domain profile 新增 intent rule 后，工具路由、检索扩展词、retrieval debug 三处一致生效。
12. tenant/project 私有报告不会在 `public_only` 查询中泄露。
13. OCR provenance 的 source 不会在未经复核时自动成为强制依据。
14. `lint --deep` provider 返回未知 code、超长 findings、非字符串 message 时仍能正常退出并保留 deterministic findings。

## 8. 验收标准

第二轮源码修改完成后，应满足：

1. `lint --deep` 不崩溃。
2. 结构化 schema 小偏差不再导致 heuristic fallback。
3. 真实 heuristic fallback 数量明显下降；若仍存在，必须能看到 provider failure trail。
4. empty extraction 被单独标记，不混同于 LLM fallback。
5. 核心业务查询不出现 invalid evidence ids。
6. `answerBasis`、`recommendedNextTool`、`evidenceState` 与业务问题一致。
7. O3 第90百分位/数据有效性类问题能检索到评价方法规范或明确缺口。
8. 草案/编制说明/研究报告不会被表述为强制执行依据。
9. stale output 可以被自动识别并刷新。
10. deer-flow 通过 MCP 使用时，可依赖结构化字段进行工具选择和报告写作。
11. domain profile 是环境空气业务规则的主入口；新增业务规则不需要散落修改多个默认常量。
12. SaaS 场景下公共知识、租户私有知识、项目私有报告的 visibility 和 sourceScope 不混淆。
13. 结构化 repair 有 warning/provenance，可审计；不会把不可靠 LLM 字段静默升级为现行强制依据。

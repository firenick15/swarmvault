import { z } from "zod";
import { estimateTokens } from "./token-estimation.js";
import type { ProviderAdapter, SourceAnalysis } from "./types.js";
import { normalizeWhitespace, sha256, slugifyKnowledgeLabel, truncate, uniqueBy } from "./utils.js";

export interface TopicSynthesisPage {
  topicId: string;
  title: string;
  slug: string;
  sourceIds: string[];
  body: string;
  inputTokenEstimate: number;
  promptHash: string;
}

interface TopicSeed {
  id: string;
  title: string;
  matcher: (analysis: SourceAnalysis) => boolean;
}

const TOPIC_SEEDS: TopicSeed[] = [
  {
    id: "ambient-air-quality-limits",
    title: "环境空气质量标准限值",
    matcher: (analysis) => /GB\s*3095|环境空气质量标准|限值|浓度限值/.test(topicHaystack(analysis))
  },
  {
    id: "aqi-iaqi-method",
    title: "AQI 与 IAQI 评价方法",
    matcher: (analysis) => /HJ\s*633|AQI|IAQI|空气质量指数|日报|实时报/i.test(topicHaystack(analysis))
  },
  {
    id: "ambient-air-assessment",
    title: "环境空气质量达标评价",
    matcher: (analysis) => /HJ\s*663|达标评价|评价技术规范|环境空气质量评价/i.test(topicHaystack(analysis))
  },
  {
    id: "monitoring-qaqc",
    title: "环境空气监测方法与质量控制",
    matcher: (analysis) => /监测方法|自动监测|质量控制|质控|数据有效性|点位|采样|校准/.test(topicHaystack(analysis))
  },
  {
    id: "local-adaptation",
    title: "地方适配与执行口径",
    matcher: (analysis) => analysis.domain?.authorityLayer === "local" || /地方|省|市|DB\d{2}/i.test(topicHaystack(analysis))
  },
  {
    id: "standard-evolution",
    title: "标准演化、修改单与历史版本",
    matcher: (analysis) =>
      analysis.domain?.authorityLayer === "evolution" ||
      /修改单|征求意见|编制说明|历史版本|废止|替代|superseded|draft/i.test(topicHaystack(analysis))
  }
];

const synthesisSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1)
});

function topicHaystack(analysis: SourceAnalysis): string {
  return [
    analysis.title,
    analysis.summary,
    analysis.domain?.standardCode,
    analysis.domain?.documentRole,
    analysis.domain?.authorityLayer,
    ...(analysis.tags ?? []),
    ...analysis.concepts.map((item) => item.name),
    ...analysis.entities.map((item) => item.name),
    ...analysis.claims.map((claim) => claim.text)
  ]
    .filter(Boolean)
    .join("\n");
}

function contextForTopic(title: string, analyses: SourceAnalysis[], maxChars = 120_000): string {
  const entries = analyses.map((analysis) =>
    [
      `# ${analysis.title}`,
      `source_id=${analysis.sourceId}`,
      analysis.domain?.authorityLayer ? `authority_layer=${analysis.domain.authorityLayer}` : undefined,
      analysis.domain?.legalStatus ? `legal_status=${analysis.domain.legalStatus}` : undefined,
      analysis.domain?.documentRole ? `document_role=${analysis.domain.documentRole}` : undefined,
      analysis.domain?.standardCode ? `standard_code=${analysis.domain.standardCode}` : undefined,
      analysis.domain?.reportingPeriod ? `reporting_period=${analysis.domain.reportingPeriod}` : undefined,
      "",
      `summary=${analysis.summary}`,
      "",
      ...analysis.claims.slice(0, 8).map((claim) => `- ${claim.text} [source:${claim.citation}]`)
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n")
  );
  return truncate([`Topic: ${title}`, ...entries].join("\n\n---\n\n"), maxChars);
}

function heuristicTopicBody(title: string, analyses: SourceAnalysis[]): string {
  const byRole = new Map<string, SourceAnalysis[]>();
  for (const analysis of analyses) {
    const role = analysis.domain?.documentRole ?? analysis.domain?.authorityLayer ?? "unknown";
    byRole.set(role, [...(byRole.get(role) ?? []), analysis]);
  }
  const lines = [
    `# ${title}`,
    "",
    "## 专家综合结论",
    "",
    `本页综合 ${analyses.length} 份来源材料。现行标准和方法规范可作为执行依据；统计报告、研究文献、白皮书、编制说明和历史版本只在其证据边界内使用。`,
    "",
    "## 现行执行依据",
    "",
    ...topicBullets(byRole, ["standard", "monitoring_method", "amendment", "law", "regulation"]),
    "",
    "## 解释、统计与研究背景",
    "",
    ...topicBullets(byRole, ["statistics", "official_explanation", "whitepaper", "research_literature", "technical_guide"]),
    "",
    "## 演化与适用边界",
    "",
    ...topicBullets(byRole, ["draft", "compilation_explanation", "evolution", "unknown"]),
    ""
  ];
  return lines.join("\n");
}

function topicBullets(groups: Map<string, SourceAnalysis[]>, roles: string[]): string[] {
  const selected = uniqueBy(
    roles.flatMap((role) => groups.get(role) ?? []),
    (analysis) => analysis.sourceId
  ).slice(0, 12);
  if (!selected.length) {
    return ["- 暂无直接归入该层级的来源。"];
  }
  return selected.map(
    (analysis) => `- ${analysis.title}：${truncate(normalizeWhitespace(analysis.summary), 180)} [source:${analysis.sourceId}]`
  );
}

export async function synthesizeEnvAirTopics(input: {
  analyses: SourceAnalysis[];
  provider: ProviderAdapter;
  schemaContent: string;
  maxTopics?: number;
}): Promise<TopicSynthesisPage[]> {
  const pages: TopicSynthesisPage[] = [];
  for (const seed of TOPIC_SEEDS.slice(0, input.maxTopics ?? TOPIC_SEEDS.length)) {
    const analyses = uniqueBy(input.analyses.filter(seed.matcher), (analysis) => analysis.sourceId).slice(0, 36);
    if (analyses.length < 2) {
      continue;
    }
    const context = contextForTopic(seed.title, analyses);
    const prompt = [
      "你正在为环保局环境空气污染业务构建跨文档专家知识库。",
      "请把多个来源有机综合成一个专业 wiki 页面，而不是逐条复述材料。",
      "必须区分：现行强制执行依据、现行方法规范、推荐性技术指南、统计/报告证据、研究背景、地方口径、征求意见稿/编制说明/历史版本。",
      "报告、研究、白皮书、公报不能直接写成强制执行依据；只有法律、法规、现行标准、现行规范、有效地方规则才能作为执行依据。",
      "输出 Markdown body，使用这些二级标题：专家综合结论、现行执行依据、方法与计算口径、解释统计与研究背景、演化与历史版本、地方适配、不能直接作为依据的材料、来源索引。",
      "所有关键陈述必须带 [source:<source_id>] 引用。",
      "",
      `Vault schema:\n${truncate(input.schemaContent, 6000)}`,
      "",
      context
    ].join("\n");
    let title = seed.title;
    let body = heuristicTopicBody(seed.title, analyses);
    if (input.provider.type !== "heuristic") {
      try {
        const structured = await input.provider.generateStructured(
          {
            system: "Return JSON for a durable environmental-air expert wiki topic synthesis.",
            prompt
          },
          synthesisSchema
        );
        title = structured.title;
        body = structured.body.startsWith("#") ? structured.body : `# ${structured.title}\n\n${structured.body}`;
      } catch {
        body = heuristicTopicBody(seed.title, analyses);
      }
    }
    pages.push({
      topicId: seed.id,
      title,
      slug: `topic-${slugifyKnowledgeLabel(seed.id)}`,
      sourceIds: analyses.map((analysis) => analysis.sourceId),
      body,
      inputTokenEstimate: estimateTokens(prompt),
      promptHash: sha256(prompt)
    });
  }
  return pages;
}

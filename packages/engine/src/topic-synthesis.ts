import { z } from "zod";
import { DEFAULT_ENV_AIR_PROFILE, type EnvAirTopicSeed } from "./domain/env-air-profile.js";
import type { LoadedDomainProfile } from "./domain/profile-loader.js";
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

function topicSeedMatches(seed: EnvAirTopicSeed, analysis: SourceAnalysis): boolean {
  const haystack = topicHaystack(analysis).toLowerCase().replace(/\s+/g, "");
  const textMatched = (seed.anyText ?? []).some((term) => haystack.includes(term.toLowerCase().replace(/\s+/g, "")));
  const layerMatched = Boolean(seed.domainAuthorityLayers?.includes(analysis.domain?.authorityLayer ?? ""));
  return textMatched || layerMatched;
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
  domainProfile?: LoadedDomainProfile;
  maxTopics?: number;
}): Promise<TopicSynthesisPage[]> {
  const pages: TopicSynthesisPage[] = [];
  const domainProfile = input.domainProfile ?? DEFAULT_ENV_AIR_PROFILE;
  for (const seed of domainProfile.topicSeeds.slice(0, input.maxTopics ?? domainProfile.topicSeeds.length)) {
    const analyses = uniqueBy(
      input.analyses.filter((analysis) => topicSeedMatches(seed, analysis)),
      (analysis) => analysis.sourceId
    ).slice(0, 36);
    if (analyses.length < 2) {
      continue;
    }
    const context = contextForTopic(seed.title, analyses);
    const prompt = [
      ...domainProfile.topicSynthesisPromptLines,
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

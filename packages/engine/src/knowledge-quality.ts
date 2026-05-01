import { DEFAULT_ENV_AIR_PROFILE, type EnvAirProfile } from "./domain/env-air-profile.js";

export type KnowledgeCandidateSeverity = "ok" | "candidate_only" | "index_only" | "reject";

export interface KnowledgeCandidateQualityInput {
  title: string;
  kind: "concept" | "entity";
  descriptions?: string[];
  sourceIds?: string[];
  authorityLayers?: string[];
  documentRoles?: string[];
  nodeDegree?: number;
  profile?: EnvAirProfile;
}

export interface KnowledgeCandidateQualityResult {
  score: number;
  severity: KnowledgeCandidateSeverity;
  reasons: string[];
  tags: string[];
}

function compact(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function isAllowedShortLabel(title: string, profile: EnvAirProfile): boolean {
  const normalized = compact(title).replace(/\./g, "");
  const allowed = new Set([
    ...profile.shortSlugAllowlist.map((item) => compact(item).replace(/\./g, "")),
    ...Object.keys(profile.termAliases).map((item) => compact(item).replace(/\./g, "")),
    ...Object.values(profile.termAliases)
      .flat()
      .map((item) => compact(item).replace(/\./g, ""))
  ]);
  return allowed.has(normalized) || /^(gb|hj|db[0-9]{2})(?:\/?t)?[0-9]{2,6}(?:[0-9]{4})?$/i.test(normalized);
}

function severityRank(severity: KnowledgeCandidateSeverity): number {
  switch (severity) {
    case "reject":
      return 3;
    case "index_only":
      return 2;
    case "candidate_only":
      return 1;
    default:
      return 0;
  }
}

function worst(left: KnowledgeCandidateSeverity, right: KnowledgeCandidateSeverity): KnowledgeCandidateSeverity {
  return severityRank(right) > severityRank(left) ? right : left;
}

export function evaluateKnowledgeCandidateQuality(input: KnowledgeCandidateQualityInput): KnowledgeCandidateQualityResult {
  const profile = input.profile ?? DEFAULT_ENV_AIR_PROFILE;
  const title = input.title.trim();
  const reasons: string[] = [];
  const tags: string[] = [];
  let severity: KnowledgeCandidateSeverity = "ok";
  let score = 1;

  if (!title || /^(item|untitled|unknown)$/i.test(title)) {
    reasons.push("empty_or_placeholder_title");
    tags.push("title_quality");
    return { score: 0, severity: "reject", reasons, tags };
  }

  if (/(no claims extracted|concepts|entities|analysis warnings|source excerpt)/i.test(title)) {
    reasons.push("prompt_or_generated_section_residue");
    tags.push("prompt_residue");
    return { score: 0, severity: "reject", reasons, tags };
  }

  if (/^\d{4}.*(目录|清单|公告|公报|报告|方案|通知)/u.test(title) || /\.(pdf|docx?|xlsx?)$/i.test(title)) {
    reasons.push("document_title_like_candidate");
    tags.push("document_title");
    severity = worst(severity, "index_only");
    score -= 0.35;
  }

  if (/^[a-z0-9.]{1,3}$/i.test(title) && !isAllowedShortLabel(title, profile)) {
    reasons.push("ambiguous_short_label");
    tags.push("short_label");
    severity = worst(severity, "candidate_only");
    score -= 0.45;
  }

  if (title.length > 48 && /[，。；:：、]/u.test(title)) {
    reasons.push("sentence_like_title");
    tags.push("long_title");
    severity = worst(severity, "candidate_only");
    score -= 0.25;
  }

  const sourceCount = input.sourceIds?.length ?? 0;
  const layerCount = new Set(input.authorityLayers?.filter(Boolean)).size;
  const roleCount = new Set(input.documentRoles?.filter(Boolean)).size;
  if (sourceCount > 80 || (sourceCount > 40 && layerCount > 3) || (sourceCount > 40 && roleCount > 4)) {
    reasons.push("overbroad_source_spread");
    tags.push("overbroad");
    severity = worst(severity, "index_only");
    score -= 0.45;
  }

  const descriptionText = (input.descriptions ?? []).join("\n");
  if (
    sourceCount > 8 &&
    descriptionText &&
    !compact(descriptionText).includes(compact(title).slice(0, Math.min(8, compact(title).length)))
  ) {
    reasons.push("low_description_title_coherence");
    tags.push("coherence");
    severity = worst(severity, "candidate_only");
    score -= 0.2;
  }

  if ((input.nodeDegree ?? 0) > 250 && sourceCount > 30) {
    reasons.push("high_degree_broad_node");
    tags.push("graph_spread");
    severity = worst(severity, "index_only");
    score -= 0.25;
  }

  score = Math.max(0, Math.min(1, score));
  return {
    score,
    severity,
    reasons: reasons.length ? reasons : ["quality_ok"],
    tags
  };
}

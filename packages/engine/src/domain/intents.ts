import type { EnvAirQueryPlan, StandardReference } from "./env-air.js";
import { buildEnvironmentDataToolHints, extractStandardReferences, inferCurrentBasisIntent } from "./env-air.js";
import { DEFAULT_ENV_AIR_PROFILE, type EnvAirProfile } from "./env-air-profile.js";

function normalizeQuery(query: string): string {
  return query
    .replace(/[-‐‑‒–—―]/g, "-")
    .replace(/\bpm\s*2\s*\.?\s*5\b/gi, "PM2.5")
    .replace(/\bpm\s*1\s*0\b/gi, "PM10")
    .trim();
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueCompact(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeSpace(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function includesAnyTerm(text: string, terms: string[] | undefined): boolean {
  if (!terms?.length) {
    return false;
  }
  const compact = text.toLowerCase().replace(/\s+/g, "");
  return terms.some((term) => compact.includes(term.toLowerCase().replace(/\s+/g, "")));
}

function pollutantFocus(query: string, profile: EnvAirProfile): string[] {
  const compact = query.toLowerCase().replace(/\s+/g, "");
  const pollutants: string[] = [];
  for (const [canonical, aliases] of Object.entries(profile.termAliases)) {
    if (aliases.some((alias) => compact.includes(alias.toLowerCase().replace(/\s+/g, "")))) {
      pollutants.push(canonical);
    }
  }
  return uniqueCompact(pollutants);
}

function standardIdentityKey(value: StandardReference): string {
  return `${value.family} ${value.number}`;
}

function canonicalTitleForProfileStandard(value: StandardReference, profile: EnvAirProfile): string | undefined {
  const identity = standardIdentityKey(value);
  return profile.standardCatalog.find((entry) => entry.identity === identity)?.title;
}

export function buildDomainQueryPlan(query: string, profile: EnvAirProfile = DEFAULT_ENV_AIR_PROFILE): EnvAirQueryPlan {
  const normalizedQuery = normalizeQuery(query);
  const standardRefs: StandardReference[] = extractStandardReferences(normalizedQuery);
  const pollutants = pollutantFocus(normalizedQuery, profile);
  const expandedTerms: string[] = [];
  const pinnedStandards: string[] = [];
  const rankingSignals: string[] = [];

  if (standardRefs.length) {
    pinnedStandards.push(...standardRefs.map((ref) => ref.normalized));
    expandedTerms.push(
      ...standardRefs.map((ref) => canonicalTitleForProfileStandard(ref, profile)).filter((item): item is string => Boolean(item))
    );
    rankingSignals.push("explicit_standard_reference");
  }

  for (const rule of [...profile.intentRules].sort((left, right) => right.priority - left.priority)) {
    const textMatched = !rule.anyText?.length || includesAnyTerm(normalizedQuery, rule.anyText);
    const pollutantMatched = rule.anyPollutant !== true || pollutants.length > 0;
    if (!textMatched || !pollutantMatched) {
      continue;
    }
    expandedTerms.push(...(rule.expandedTerms ?? []));
    pinnedStandards.push(...(rule.pinnedStandards ?? []));
    rankingSignals.push(...(rule.rankingSignals ?? []));
  }

  return {
    normalizedQuery,
    standardRefs,
    expandedTerms: uniqueCompact(expandedTerms),
    pinnedStandards: uniqueCompact(pinnedStandards),
    rankingSignals: uniqueCompact(rankingSignals),
    currentBasisIntent: inferCurrentBasisIntent(normalizedQuery),
    dataToolHints: buildEnvironmentDataToolHints(normalizedQuery),
    stages: []
  };
}

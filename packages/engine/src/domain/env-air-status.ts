import type { DomainMetadata, LegalForce, LegalStatus } from "../types.js";

export interface LegalStatusNormalizationInput {
  title: string;
  path?: string;
  authorityLayer?: string;
  legalForce?: string;
  documentRole?: string;
  legalStatus?: string;
  publishDate?: string;
  effectiveDate?: string;
  replaces?: string[];
  replacedBy?: string[];
  metadataSource?: string;
  verificationState?: string;
  asOfDate?: string;
}

export interface LegalStatusNormalizationResult {
  legalStatus: LegalStatus;
  legalForce?: LegalForce;
  authorityLayer?: DomainMetadata["authorityLayer"];
  documentRole?: DomainMetadata["documentRole"];
  reasons: string[];
  originalLegalStatus?: string;
  changed: boolean;
}

function dateTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : undefined;
}

function asLegalStatus(value: string | undefined): LegalStatus {
  return value === "current_effective" ||
    value === "issued_not_yet_effective" ||
    value === "draft_consultation" ||
    value === "superseded" ||
    value === "amended" ||
    value === "explanation_only" ||
    value === "time_scoped_evidence"
    ? value
    : "unknown";
}

function normalizedHaystack(input: LegalStatusNormalizationInput): string {
  return [input.title, input.path ?? "", input.documentRole ?? "", input.legalStatus ?? ""].join("\n").toLowerCase();
}

export function normalizeEnvAirLegalStatus(input: LegalStatusNormalizationInput): LegalStatusNormalizationResult {
  const originalLegalStatus = asLegalStatus(input.legalStatus);
  const reasons: string[] = [];
  const haystack = normalizedHaystack(input);
  const humanVerified = input.metadataSource === "sidecar" && input.verificationState === "human_verified";
  if (humanVerified && originalLegalStatus !== "unknown") {
    return {
      legalStatus: originalLegalStatus,
      legalForce: input.legalForce as LegalForce | undefined,
      authorityLayer: input.authorityLayer as DomainMetadata["authorityLayer"] | undefined,
      documentRole: input.documentRole as DomainMetadata["documentRole"] | undefined,
      reasons: ["human_verified_sidecar_preserved"],
      originalLegalStatus,
      changed: false
    };
  }

  let legalStatus = originalLegalStatus;
  let legalForce = input.legalForce as LegalForce | undefined;
  let authorityLayer = input.authorityLayer as DomainMetadata["authorityLayer"] | undefined;
  let documentRole = input.documentRole as DomainMetadata["documentRole"] | undefined;

  if (/征求意见稿|征求意见|草案|draft|consultation/i.test(haystack)) {
    legalStatus = "draft_consultation";
    legalForce = legalForce === "unknown" ? "draft" : legalForce;
    authorityLayer = authorityLayer === "unknown" ? "evolution" : authorityLayer;
    documentRole = documentRole === "unknown" ? "draft" : documentRole;
    reasons.push("draft_or_consultation_material");
  } else if (/编制说明|释义|解读|compilation/i.test(haystack)) {
    legalStatus = "explanation_only";
    legalForce = legalForce === "unknown" ? "explanatory" : legalForce;
    authorityLayer = authorityLayer === "unknown" ? "evidence" : authorityLayer;
    documentRole = documentRole === "unknown" ? "official_explanation" : documentRole;
    reasons.push("explanatory_or_compilation_material");
  } else if ((input.replacedBy?.length ?? 0) > 0 || /废止|历史版本|superseded|replaced/.test(haystack)) {
    legalStatus = "superseded";
    legalForce = legalForce === "unknown" ? "superseded" : legalForce;
    reasons.push("replacement_or_history_marker");
  } else if (documentRole === "statistics" || /月报|年报|公报|白皮书|蓝皮书|年度报告|statistics|whitepaper|white paper/.test(haystack)) {
    legalStatus = "time_scoped_evidence";
    legalForce = documentRole === "statistics" ? "statistical" : (legalForce ?? "explanatory");
    authorityLayer = authorityLayer === "unknown" ? "evidence" : authorityLayer;
    reasons.push("time_scoped_or_background_evidence");
  } else {
    const effectiveTime = dateTime(input.effectiveDate);
    const asOfTime = dateTime(input.asOfDate) ?? Date.now();
    if (typeof effectiveTime === "number") {
      if (effectiveTime <= asOfTime) {
        legalStatus = "current_effective";
        reasons.push("effective_date_on_or_before_as_of_date");
      } else {
        legalStatus = "issued_not_yet_effective";
        reasons.push("effective_date_after_as_of_date");
      }
    } else if (
      (authorityLayer === "core" || authorityLayer === "method" || authorityLayer === "local") &&
      (documentRole === "standard" ||
        documentRole === "monitoring_method" ||
        documentRole === "amendment" ||
        documentRole === "law" ||
        documentRole === "regulation" ||
        documentRole === "unknown" ||
        !documentRole)
    ) {
      legalStatus = originalLegalStatus === "unknown" ? "current_effective" : originalLegalStatus;
      reasons.push("authority_material_without_effective_date");
    }
  }

  return {
    legalStatus,
    legalForce,
    authorityLayer,
    documentRole,
    reasons,
    originalLegalStatus,
    changed: legalStatus !== originalLegalStatus
  };
}

export function normalizeDomainMetadataLegalStatus(
  domain: DomainMetadata,
  input: { title: string; path?: string; asOfDate?: string }
): DomainMetadata {
  const normalized = normalizeEnvAirLegalStatus({
    title: input.title,
    path: input.path,
    authorityLayer: domain.authorityLayer,
    legalForce: domain.legalForce,
    documentRole: domain.documentRole,
    legalStatus: domain.legalStatus,
    publishDate: domain.publishDate,
    effectiveDate: domain.effectiveDate,
    replaces: domain.replaces,
    replacedBy: domain.replacedBy,
    metadataSource: domain.metadataSource,
    verificationState: domain.verificationState,
    asOfDate: input.asOfDate
  });
  const notes = [...(domain.notes ?? [])];
  if (normalized.reasons.length) {
    const note = `legal_status_normalized:${normalized.reasons.join("|")}`;
    if (!notes.includes(note)) {
      notes.push(note);
    }
  }
  if (normalized.changed) {
    const note = `legal_status_changed:${normalized.originalLegalStatus}->${normalized.legalStatus}`;
    if (!notes.includes(note)) {
      notes.push(note);
    }
  }
  return {
    ...domain,
    legalStatus: normalized.legalStatus,
    legalForce: normalized.legalForce ?? domain.legalForce,
    authorityLayer: normalized.authorityLayer ?? domain.authorityLayer,
    documentRole: normalized.documentRole ?? domain.documentRole,
    notes
  };
}

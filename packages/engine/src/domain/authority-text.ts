import type { DomainMetadata, SourceAnalysis } from "../types.js";
import { normalizeWhitespace, truncate, uniqueBy } from "../utils.js";

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

export interface AuthorityUseClassification {
  useClass: AuthorityUseClass;
  statement?: string;
  useBoundary?: string;
  reasons: string[];
}

const CURRENT_BINDING_ROLES = new Set(["law", "regulation", "policy", "standard", "emission_standard", "amendment"]);
const METHOD_ROLES = new Set(["monitoring_method", "qa_qc", "technical_guide"]);
const EXPLANATORY_ROLES = new Set(["official_explanation", "compilation_explanation", "whitepaper"]);
const RESEARCH_ROLES = new Set(["research_literature"]);

function compactUseBoundary(parts: Array<string | undefined>): string | undefined {
  return normalizeWhitespace(parts.filter(Boolean).join(" "));
}

export function classifyAuthorityUse(
  domain: DomainMetadata | undefined,
  context: { title?: string; path?: string } = {}
): AuthorityUseClassification {
  if (!domain) {
    return { useClass: "unknown", reasons: ["missing_domain_metadata"] };
  }
  const reasons: string[] = [];
  const text = [context.title ?? "", context.path ?? "", domain.documentRole, domain.legalStatus, domain.legalForce, domain.authorityLayer]
    .join("\n")
    .toLowerCase();
  const role = domain.documentRole;
  const force = domain.legalForce;
  const status = domain.legalStatus;

  if (status === "draft_consultation" || role === "draft" || force === "draft" || /征求意见|草案|draft|consultation/i.test(text)) {
    reasons.push("draft_or_consultation_status");
    return {
      useClass: "draft_not_binding",
      statement: "该资料属于草案或征求意见材料，不能直接作为现行执行、执法、验收或排放限值依据。",
      useBoundary: "可用于了解拟修订方向、技术背景和意见征集内容；正式执行应以已经发布并生效的法律、法规、标准或规范为准。",
      reasons
    };
  }

  if (status === "superseded" || force === "superseded" || (domain.replacedBy?.length ?? 0) > 0 || /废止|历史版本|superseded/.test(text)) {
    reasons.push("superseded_or_replaced_status");
    return {
      useClass: "superseded_historical",
      statement: "该资料为历史版本或已被代替材料，不能直接作为当前执行依据。",
      useBoundary: compactUseBoundary([
        "可用于追溯历史口径、版本演化和当时背景。",
        domain.replacedBy?.length ? `当前适用依据应进一步核对替代文件：${domain.replacedBy.join(", ")}。` : undefined
      ]),
      reasons
    };
  }

  if (status === "issued_not_yet_effective") {
    reasons.push("issued_before_effective_date");
    return {
      useClass: "issued_not_yet_effective",
      statement: "该资料已经发布但尚未到生效日期，不能替代当前已生效依据。",
      useBoundary: compactUseBoundary([
        "可用于提前准备衔接、评估变化和制定过渡安排。",
        domain.effectiveDate ? `正式执行需以 ${domain.effectiveDate} 及后续有效状态为准。` : undefined
      ]),
      reasons
    };
  }

  if (
    status === "explanation_only" ||
    force === "explanatory" ||
    EXPLANATORY_ROLES.has(role) ||
    /编制说明|释义|解读|说明材料|compilation|explanation/i.test(text)
  ) {
    reasons.push("explanatory_material");
    return {
      useClass: "explanation_not_binding",
      statement: "该资料属于说明、解读或编制说明类材料，本身不能替代正式标准、规范或法规作为执行依据。",
      useBoundary: "可用于解释制定背景、技术路线、指标来源和条文理解；涉及强制执行、验收或处罚时应回到现行有效依据。",
      reasons
    };
  }

  if (
    status === "time_scoped_evidence" ||
    force === "statistical" ||
    role === "statistics" ||
    /月报|年报|公报|年度报告|统计|bulletin|statistics/i.test(text)
  ) {
    reasons.push("time_scoped_statistics");
    return {
      useClass: "statistics_evidence",
      statement: "该资料属于特定时期的统计或报告材料，不能直接作为排放限值、行政处罚或验收检测依据。",
      useBoundary: "可用于描述统计事实、趋势背景、城市范围和评价结果；执行限值、评价方法和执法要求应以现行有效标准规范为准。",
      reasons
    };
  }

  if (force === "research" || RESEARCH_ROLES.has(role) || /研究|论文|literature|research/i.test(text)) {
    reasons.push("research_material");
    return {
      useClass: "research_evidence",
      statement: "该资料属于研究或文献证据，不能直接替代现行有效的法规、标准或规范。",
      useBoundary: "可用于补充机理解释、方法比较和专业论证；监管执行和验收结论应由正式依据支撑。",
      reasons
    };
  }

  if (status === "current_effective" || status === "amended") {
    if (force === "mandatory" || CURRENT_BINDING_ROLES.has(role) || domain.authorityLayer === "core" || domain.authorityLayer === "local") {
      reasons.push("current_binding_material");
      return { useClass: "current_binding_basis", reasons };
    }
    if (force === "recommended" || METHOD_ROLES.has(role) || domain.authorityLayer === "method") {
      reasons.push("current_method_or_recommended_material");
      return {
        useClass: "current_recommended_method",
        statement: "该资料为当前可用的方法或推荐性技术材料，适用时仍应核对其法律效力和引用条件。",
        useBoundary: "可用于方法选择、监测评价或技术实施；若用于强制执行，应确认其是否被现行法规或标准明确引用。",
        reasons
      };
    }
  }

  return { useClass: "unknown", reasons: ["authority_use_unknown"] };
}

function isConstrainedUseClass(useClass: AuthorityUseClass): boolean {
  return !["current_binding_basis", "current_recommended_method", "unknown"].includes(useClass);
}

function replaceBindingLanguage(text: string, classification: AuthorityUseClassification): string {
  if (!isConstrainedUseClass(classification.useClass)) {
    return text;
  }
  return text
    .replace(/现行((?:国家|行业|地方|生态环境|环境保护)?(?:标准|规范|法规|方法|办法))/g, "相关$1")
    .replace(/当前((?:执行|适用|有效)的?(?:标准|规范|法规|方法|办法))/g, "该材料涉及的$1")
    .replace(/可作为(现行)?((?:行政处罚|执法|验收|排放限值|执行|监管)?依据)/g, "需结合现行有效依据使用")
    .replace(/直接作为((?:行政处罚|执法|验收|排放限值|执行|监管)?依据)/g, "直接替代现行有效依据")
    .replace(/必须按照/g, "原文涉及");
}

export function reconcileAuthorityText(text: string, classification: AuthorityUseClassification): { text: string; changed: boolean } {
  const original = text;
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return { text, changed: false };
  }
  const sanitized = replaceBindingLanguage(normalized, classification);
  const statement = classification.statement;
  if (!statement || sanitized.includes(statement)) {
    return { text: sanitized, changed: sanitized !== original };
  }
  if (!isConstrainedUseClass(classification.useClass) && classification.useClass !== "current_recommended_method") {
    return { text: sanitized, changed: sanitized !== original };
  }
  const textWithStatus = `${statement} ${sanitized}`;
  return { text: textWithStatus, changed: textWithStatus !== original };
}

export function authorityUseBoundary(
  domain: DomainMetadata | undefined,
  context: { title?: string; path?: string } = {}
): string | undefined {
  return classifyAuthorityUse(domain, context).useBoundary;
}

export function authorityStatusNotice(
  domain: DomainMetadata | undefined,
  context: { title?: string; path?: string } = {}
): string | undefined {
  return classifyAuthorityUse(domain, context).statement;
}

export function reconcileSourceAnalysisAuthority(
  analysis: SourceAnalysis,
  context: { title?: string; path?: string } = {}
): SourceAnalysis {
  const classification = classifyAuthorityUse(analysis.domain, { title: context.title ?? analysis.title, path: context.path });
  const warnings: string[] = [];
  const summary = reconcileAuthorityText(analysis.summary, classification);
  if (summary.changed) {
    warnings.push("authority_text_reconciled:summary");
  }
  const concepts = analysis.concepts.map((concept) => {
    const description = reconcileAuthorityText(concept.description, classification);
    if (description.changed) {
      warnings.push(`authority_text_reconciled:concept:${truncate(concept.name, 60)}`);
    }
    return description.changed ? { ...concept, description: description.text } : concept;
  });
  const entities = analysis.entities.map((entity) => {
    const description = reconcileAuthorityText(entity.description, classification);
    if (description.changed) {
      warnings.push(`authority_text_reconciled:entity:${truncate(entity.name, 60)}`);
    }
    return description.changed ? { ...entity, description: description.text } : entity;
  });
  const claims = analysis.claims.map((claim) => {
    const text = reconcileAuthorityText(claim.text, classification);
    if (text.changed) {
      warnings.push(`authority_text_reconciled:claim:${claim.id}`);
    }
    return text.changed
      ? {
          ...claim,
          text: text.text,
          status: isConstrainedUseClass(classification.useClass) ? ("stale" as const) : claim.status
        }
      : claim;
  });
  const questions = analysis.questions.map((question) => replaceBindingLanguage(question, classification));
  if (
    summary.text === analysis.summary &&
    concepts.every((concept, index) => concept === analysis.concepts[index]) &&
    entities.every((entity, index) => entity === analysis.entities[index]) &&
    claims.every((claim, index) => claim === analysis.claims[index]) &&
    questions.every((question, index) => question === analysis.questions[index])
  ) {
    return analysis;
  }
  return {
    ...analysis,
    summary: summary.text,
    concepts,
    entities,
    claims,
    questions,
    warnings: uniqueBy([...(analysis.warnings ?? []), ...warnings], (item) => item)
  };
}

import type {
  AuditEvent,
  EvidenceItem,
  Expert,
  ExpertQualityMetric,
  ExpertSignal,
  OutreachDraft,
  Project,
  ProjectCandidate,
  SearchResult,
  TrialTask,
} from "@prisma/client";
import { parseJson } from "@/lib/json";

type SerializableExpert = Omit<Expert, "identityKey"> & Partial<Pick<Expert, "identityKey">>;

export function serializeProject(project: Project) {
  return {
    id: project.id,
    title: project.title,
    rawDemand: project.rawDemand,
    domain: project.domain,
    taskType: project.taskType,
    quantity: project.quantity,
    budgetMin: project.budgetMin,
    budgetMax: project.budgetMax,
    riskLevel: project.riskLevel,
    status: project.status,
    supplyGoalJson: project.supplyGoalJson,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    languages: parseJson<string[]>(project.languagesJson, []),
    regions: parseJson<string[]>(project.regionsJson, []),
    persona: parseJson(project.personaJson, {}),
    searchQueries: parseJson<string[]>(project.searchQueriesJson, []),
  };
}

export function serializeProjectForGeneration(project: Project) {
  const serialized = serializeProject(project);
  const projectContext = {
    title: serialized.title,
    rawDemand: serialized.rawDemand,
    domain: serialized.domain,
    taskType: serialized.taskType,
    quantity: serialized.quantity,
    riskLevel: serialized.riskLevel,
    status: serialized.status,
    supplyGoalJson: serialized.supplyGoalJson,
    languages: serialized.languages,
    regions: serialized.regions,
    persona: serialized.persona,
    searchQueries: serialized.searchQueries,
  };
  return hasQualifiedBudget(serialized.rawDemand)
    ? { ...projectContext, budgetMin: serialized.budgetMin, budgetMax: serialized.budgetMax }
    : projectContext;
}

export function hasQualifiedBudget(rawDemand: string) {
  const hasCurrency = /(?:人民币|CNY|RMB|美元|USD|美金|欧元|EUR|港币|HKD|英镑|GBP|元|[$€£])/i.test(rawDemand);
  const hasBillingUnit = /(?:\/\s*(?:小时|时|例|条|天|周|月)|每\s*(?:小时|时|例|条|天|周|月)|per\s+(?:hour|case|item|day|week|month)|项目预算|总预算|总价|固定预算|fixed\s+budget)/i.test(
    rawDemand,
  );
  return hasCurrency && hasBillingUnit;
}

export function serializeExpert(
  expert: SerializableExpert & {
    signals?: ExpertSignal[];
    qualityMetrics?: ExpertQualityMetric[];
    evidenceItems?: EvidenceItem[];
  },
) {
  return {
    id: expert.id,
    name: expert.name,
    title: expert.title,
    affiliation: expert.affiliation,
    region: expert.region,
    sourceUrl: expert.sourceUrl,
    evidenceLevel: expert.evidenceLevel,
    consentState: expert.consentState,
    expertType: expert.expertType,
    lastActiveAt: expert.lastActiveAt,
    createdAt: expert.createdAt,
    updatedAt: expert.updatedAt,
    domainTags: parseJson<string[]>(expert.domainTagsJson, []),
    languages: parseJson<string[]>(expert.languagesJson, []),
    contact: parseJson<Record<string, unknown>>(expert.contactJson, {}),
    riskFlags: parseJson<string[]>(expert.riskFlagsJson, []),
    qualitySummary: parseJson<Record<string, unknown>>(expert.qualitySummaryJson, {}),
    signals:
      expert.signals?.map((signal) => ({
        type: signal.type,
        value: signal.value,
        source: formatExpertRecordSource(signal.source),
        evidenceLevel: signal.evidenceLevel,
        confidence: signal.confidence,
        sourceUrl: signal.sourceUrl,
      })) ?? [],
    qualityMetrics:
      expert.qualityMetrics?.map((metric) => ({
        metricType: metric.metricType,
        score: metric.score,
        source: formatExpertRecordSource(metric.source),
        notes: formatExpertRecordNotes(metric.notes),
        createdAt: metric.createdAt,
      })) ?? [],
    evidenceItems:
      expert.evidenceItems
        ?.filter((evidence) => !evidence.candidateId)
        .map((evidence) => ({
          claim: evidence.claim,
          sourceUrl: evidence.sourceUrl,
          sourceTitle: evidence.sourceTitle,
          sourceType: evidence.sourceType,
          snippet: evidence.snippet,
          evidenceLevel: evidence.evidenceLevel,
          confidence: evidence.confidence,
        })) ?? [],
  };
}

function formatExpertRecordSource(value: string) {
  if (/live[_-]?smoke|fixture/i.test(value)) return "内部待核验记录";
  if (/historical|history/i.test(value)) return "历史项目记录";
  if (/internal/i.test(value)) return "内部专家资料";
  if (/github/i.test(value)) return "GitHub 公开资料";
  if (/openalex|publication|paper/i.test(value)) return "公开论文索引";
  if (/public|web/i.test(value)) return "公开网页";
  return /[\u3400-\u9fff]/.test(value) && !value.includes("_") ? value : "业务记录";
}

function formatExpertRecordNotes(value: string | null) {
  if (!value) return null;
  if (/live[_-]?smoke|fixture/i.test(value)) return "该质量记录用于流程验证，正式使用前需人工核验。";
  return value;
}

export function serializeCandidate(
  candidate: ProjectCandidate & {
    expert?: SerializableExpert & {
      signals?: ExpertSignal[];
      qualityMetrics?: ExpertQualityMetric[];
      evidenceItems?: EvidenceItem[];
    };
    evidenceItems?: EvidenceItem[];
    outreachDrafts?: OutreachDraft[];
    trialTasks?: TrialTask[];
  },
) {
  return {
    id: candidate.id,
    projectId: candidate.projectId,
    expertId: candidate.expertId,
    stage: candidate.stage,
    fitScore: candidate.fitScore,
    nextAction: candidate.nextAction,
    humanReviewNeeded: candidate.humanReviewNeeded,
    sourceType: candidate.sourceType,
    sourceRunId: candidate.sourceRunId,
    conversionProbability: candidate.conversionProbability,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    scoring: parseJson(candidate.scoringJson, {}),
    risks: parseJson<string[]>(candidate.risksJson, []),
    missing: parseJson<string[]>(candidate.missingJson, []),
    expert: candidate.expert ? serializeExpert(candidate.expert) : undefined,
    evidenceItems: candidate.evidenceItems ?? [],
    outreachDrafts: candidate.outreachDrafts ?? [],
    trialTasks: (candidate.trialTasks ?? []).map((trial) => ({
      ...trial,
      rubric: parseJson(trial.rubricJson, {}),
    })),
  };
}

export function serializeCandidateForGeneration(
  candidate: Parameters<typeof serializeCandidate>[0],
) {
  const serialized = serializeCandidate(candidate);
  const scoring = serialized.scoring as { evidenceLevel?: string; topReasons?: string[] };
  return {
    id: serialized.id,
    stage: serialized.stage,
    fitScore: serialized.fitScore,
    nextAction: serialized.nextAction,
    humanReviewNeeded: serialized.humanReviewNeeded,
    sourceType: serialized.sourceType,
    scoring: {
      evidenceLevel: scoring.evidenceLevel,
      topReasons: Array.isArray(scoring.topReasons) ? scoring.topReasons.slice(0, 5) : [],
    },
    risks: serialized.risks.slice(0, 6),
    missing: serialized.missing.slice(0, 6),
    expert: serialized.expert
      ? {
          id: serialized.expert.id,
          name: serialized.expert.name,
          title: serialized.expert.title,
          affiliation: serialized.expert.affiliation,
          domainTags: serialized.expert.domainTags,
          languages: serialized.expert.languages,
          region: serialized.expert.region,
          sourceUrl: serialized.expert.sourceUrl,
          evidenceLevel: serialized.expert.evidenceLevel,
          consentState: serialized.expert.consentState,
          contact: {
            contactPermissionBasis: serialized.expert.contact.contactPermissionBasis,
            profileAllowsOutreach: serialized.expert.contact.profileAllowsOutreach,
            sourceAllowsOutreach: serialized.expert.contact.sourceAllowsOutreach,
          },
          signals: serialized.expert.signals.slice(0, 8),
          qualityMetrics: serialized.expert.qualityMetrics.slice(0, 5),
          evidenceItems: serialized.expert.evidenceItems.slice(0, 5),
        }
      : undefined,
    evidenceItems: serialized.evidenceItems.slice(0, 6),
  };
}

export function serializeCandidateForOutreach(candidate: Parameters<typeof serializeCandidate>[0]) {
  const serialized = serializeCandidate(candidate);
  if (!serialized.expert) return { expert: undefined };

  const verifiedHighlights = Array.from(
    new Set([
      ...serialized.expert.domainTags,
      ...serialized.expert.signals.map((signal) => signal.value),
      ...serialized.expert.evidenceItems.map((evidence) => evidence.claim),
      ...serialized.evidenceItems.map((evidence) => evidence.claim),
    ]),
  )
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    expert: {
      name: serialized.expert.name,
      title: serialized.expert.title,
      affiliation: /内部专家库|internal expert/i.test(serialized.expert.affiliation ?? "")
        ? null
        : serialized.expert.affiliation,
      domainTags: serialized.expert.domainTags.slice(0, 8),
      languages: serialized.expert.languages.slice(0, 6),
      region: serialized.expert.region,
      verifiedHighlights,
    },
  };
}

export function serializeCandidateForScoring(candidate: Parameters<typeof serializeCandidate>[0]) {
  const serialized = serializeCandidate(candidate);
  return {
    id: serialized.id,
    stage: serialized.stage,
    humanReviewNeeded: serialized.humanReviewNeeded,
    sourceType: serialized.sourceType,
    expert: serialized.expert
      ? {
          id: serialized.expert.id,
          name: serialized.expert.name,
          title: serialized.expert.title,
          affiliation: serialized.expert.affiliation,
          domainTags: serialized.expert.domainTags,
          languages: serialized.expert.languages,
          region: serialized.expert.region,
          sourceUrl: serialized.expert.sourceUrl,
          evidenceLevel: serialized.expert.evidenceLevel,
          consentState: serialized.expert.consentState,
          contact: serialized.expert.contact,
          signals: serialized.expert.signals.slice(0, 8),
          qualityMetrics: serialized.expert.qualityMetrics.slice(0, 8),
          evidenceItems: serialized.expert.evidenceItems.slice(0, 8),
        }
      : undefined,
    evidenceItems: serialized.evidenceItems.slice(0, 10),
  };
}

export function serializeSearchResult(result: SearchResult) {
  return result;
}

export function serializeAuditEvent(event: AuditEvent) {
  return {
    ...event,
    payload: parseJson(event.payloadJson, {}),
  };
}

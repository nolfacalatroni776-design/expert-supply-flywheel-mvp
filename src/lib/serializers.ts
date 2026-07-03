import type {
  AuditEvent,
  EvidenceItem,
  Expert,
  OutreachDraft,
  Project,
  ProjectCandidate,
  SearchResult,
  TrialTask,
} from "@prisma/client";
import { parseJson } from "@/lib/json";

export function serializeProject(project: Project) {
  return {
    ...project,
    languages: parseJson<string[]>(project.languagesJson, []),
    regions: parseJson<string[]>(project.regionsJson, []),
    persona: parseJson(project.personaJson, {}),
    searchQueries: parseJson<string[]>(project.searchQueriesJson, []),
  };
}

export function serializeExpert(expert: Expert) {
  return {
    ...expert,
    domainTags: parseJson<string[]>(expert.domainTagsJson, []),
    languages: parseJson<string[]>(expert.languagesJson, []),
    contact: parseJson<Record<string, unknown>>(expert.contactJson, {}),
    riskFlags: parseJson<string[]>(expert.riskFlagsJson, []),
  };
}

export function serializeCandidate(
  candidate: ProjectCandidate & {
    expert?: Expert;
    evidenceItems?: EvidenceItem[];
    outreachDrafts?: OutreachDraft[];
    trialTasks?: TrialTask[];
  },
) {
  return {
    ...candidate,
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

export function serializeSearchResult(result: SearchResult) {
  return result;
}

export function serializeAuditEvent(event: AuditEvent) {
  return {
    ...event,
    payload: parseJson(event.payloadJson, {}),
  };
}

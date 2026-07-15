import type { AgentToolExecutionContext } from "@/lib/agent-tools";
import { writeAuditEvent } from "@/lib/audit";
import { parseJson, stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import { serializeCandidate } from "@/lib/serializers";
import { sourceProjectCandidates } from "@/lib/sourcing";
import { detectMergeCandidates } from "@/lib/supply-flywheel";

type EvidenceCandidate = {
  expert: {
    name: string;
    affiliation?: string | null;
    evidenceLevel: string;
  };
  evidenceItems: Array<{
    sourceType?: string | null;
    sourceUrl?: string | null;
    claim?: string | null;
  }>;
};

const evidenceRank: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };

export function buildCandidateEvidenceQueries(candidates: EvidenceCandidate[], maxQueries = 4) {
  const selected: string[] = [];
  const seenNames = new Set<string>();

  for (const candidate of candidates) {
    if (selected.length >= Math.max(1, Math.min(maxQueries, 4))) break;
    if ((evidenceRank[candidate.expert.evidenceLevel] ?? 0) < 2) continue;
    if (candidate.evidenceItems.some(isInstitutionProfileEvidence)) continue;

    const name = cleanQueryPhrase(candidate.expert.name);
    const normalizedName = name.toLowerCase();
    if (!name || seenNames.has(normalizedName)) continue;
    seenNames.add(normalizedName);

    const affiliation = cleanAffiliation(candidate.expert.affiliation);
    selected.push(`${quoteQueryPhrase(name)}${affiliation ? ` ${quoteQueryPhrase(affiliation)}` : ""} institution profile`);
  }

  return selected;
}

export function filterEvidenceEnrichmentCandidates<
  T extends {
    name: string;
    sourceUrl: string;
    claims: Array<{ sourceType?: string | null; sourceUrl?: string | null }>;
  },
>({
  candidates,
  searchResults,
  approvedNames,
}: {
  candidates: T[];
  searchResults: Array<{ title: string; url: string; snippet: string; domain?: string | null }>;
  approvedNames: string[];
}) {
  const approved = new Set(approvedNames.map(normalizePersonName).filter(Boolean));
  const resultsByUrl = new Map(searchResults.map((result) => [normalizeSourceUrl(result.url), result]));
  return candidates.filter((candidate) => {
    if (!approved.has(normalizePersonName(candidate.name))) return false;
    const result = resultsByUrl.get(normalizeSourceUrl(candidate.sourceUrl));
    if (!result || !isInstitutionPersonnelPage(result, candidate.name)) return false;
    return candidate.claims.some(
      (claim) =>
        claim.sourceType === "institution_profile" &&
        normalizeSourceUrl(claim.sourceUrl ?? "") === normalizeSourceUrl(candidate.sourceUrl),
    );
  });
}

export async function getCandidateEvidenceEnrichmentQueries(projectId: string) {
  const candidates = await prisma.projectCandidate.findMany({
    where: { projectId, sourceType: "external" },
    include: { expert: true, evidenceItems: true },
    orderBy: [{ updatedAt: "desc" }],
    take: 40,
  });
  return buildCandidateEvidenceQueries(candidates);
}

export async function runCandidateEvidenceEnrichment({
  projectId,
  queries,
  toolContext,
}: {
  projectId: string;
  queries: string[];
  toolContext: AgentToolExecutionContext;
}) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return null;
  const approvedQueries = Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean))).slice(0, 4);
  if (!approvedQueries.length) {
    return { ok: false as const, status: 422, error: "当前没有需要补齐机构主页的高证据候选。" };
  }

  const run = await prisma.supplySearchRun.create({
    data: {
      projectId,
      runType: "evidence_enrichment",
      status: "running",
      goalJson: stringifyJson({ objective: "为已有候选补齐机构主页证据" }),
      queriesJson: stringifyJson(approvedQueries),
      summaryJson: stringifyJson({ startedAt: new Date().toISOString() }),
    },
  });
  const approvedNames = approvedQueries.map(readCandidateNameFromQuery).filter(Boolean);
  const result = await sourceProjectCandidates({
    project,
    queries: approvedQueries,
    maxQueries: approvedQueries.length,
    searchRunId: run.id,
    sourceType: "external",
    toolContext,
    candidateFilter: ({ candidates, searchResults }) =>
      filterEvidenceEnrichmentCandidates({ candidates, searchResults, approvedNames }),
  });
  if (!result.ok) {
    await prisma.supplySearchRun.update({
      where: { id: run.id },
      data: { status: "failed", summaryJson: stringifyJson({ error: result.error }) },
    });
    await writeAuditEvent({
      projectId,
      entityType: "project",
      entityId: projectId,
      action: "candidate.evidence_enrichment.failed",
      payload: { runId: run.id, error: result.error },
    });
    return { ...result, runId: run.id };
  }

  await detectMergeCandidates(projectId);
  const projectCandidates = await prisma.projectCandidate.findMany({
    where: { projectId },
    include: { expert: true, evidenceItems: true },
  });
  const expertIds = projectCandidates.map((candidate) => candidate.expertId);
  const resultExpertIds = result.candidates.map((candidate) => candidate.expertId);
  const suggestions = expertIds.length && resultExpertIds.length
    ? await prisma.expertMergeCandidate.findMany({
        where: {
          status: "pending",
          AND: [
            { OR: [{ primaryExpertId: { in: expertIds } }, { duplicateExpertId: { in: expertIds } }] },
            { OR: [{ primaryExpertId: { in: resultExpertIds } }, { duplicateExpertId: { in: resultExpertIds } }] },
          ],
        },
        include: { primaryExpert: true, duplicateExpert: true },
        orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
        take: 20,
      })
    : [];
  const readyCandidates = projectCandidates.filter(
    (candidate) =>
      approvedNames.some((name) => normalizePersonName(name) === normalizePersonName(candidate.expert.name)) &&
      (evidenceRank[candidate.expert.evidenceLevel] ?? 0) >= 2 &&
      candidate.evidenceItems.some(isInstitutionProfileEvidence),
  );
  const passed = suggestions.length > 0 || readyCandidates.length > 0;

  await prisma.supplySearchRun.update({
    where: { id: run.id },
    data: {
      status: passed ? "completed" : "quality_failed",
      summaryJson: stringifyJson({
        queries: approvedQueries.length,
        searchResults: result.searchResults.length,
        candidates: result.candidates.length,
        mergeSuggestions: suggestions.length,
        readyCandidates: readyCandidates.length,
        providerStats: result.providerStats,
        cacheHits: result.cacheHits.length,
      }),
    },
  });
  await writeAuditEvent({
    projectId,
    entityType: "project",
    entityId: projectId,
    action: "candidate.evidence_enrichment.completed",
    payload: {
      runId: run.id,
      queries: approvedQueries.length,
      searchResults: result.searchResults.length,
      candidates: result.candidates.length,
      mergeSuggestions: suggestions.length,
      readyCandidates: readyCandidates.length,
      passed,
    },
  });

  return {
    ok: true as const,
    runId: run.id,
    searchResults: result.searchResults,
    candidates: result.candidates,
    providerStats: result.providerStats,
    cacheHits: result.cacheHits,
    usedFallback: result.usedFallback,
    extractionIssue: result.extractionIssue,
    readyCandidates: readyCandidates.map(serializeCandidate),
    mergeSuggestions: suggestions.map((suggestion) => ({
      id: suggestion.id,
      primaryExpertId: suggestion.primaryExpertId,
      duplicateExpertId: suggestion.duplicateExpertId,
      primaryName: suggestion.primaryExpert.name,
      duplicateName: suggestion.duplicateExpert.name,
      primaryAffiliation: suggestion.primaryExpert.affiliation,
      duplicateAffiliation: suggestion.duplicateExpert.affiliation,
      confidence: suggestion.confidence,
      reason: parseJson<Record<string, unknown>>(suggestion.reasonJson, {}),
    })),
    passed,
  };
}

function isInstitutionProfileEvidence(evidence: EvidenceCandidate["evidenceItems"][number]) {
  const text = `${evidence.sourceType ?? ""} ${evidence.sourceUrl ?? ""} ${evidence.claim ?? ""}`;
  return /institution_profile|机构公开人员页面|机构主页|团队主页|\/faculty\/|\/people\/|\/researcher\//i.test(text);
}

function cleanAffiliation(value?: string | null) {
  const cleaned = cleanQueryPhrase(value ?? "");
  if (!cleaned || /^(论文作者|会议讲者|公开来源|unknown|n\/a)$/i.test(cleaned)) return "";
  return cleaned.slice(0, 80);
}

function cleanQueryPhrase(value: string) {
  return value.replace(/["“”]/g, " ").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function readCandidateNameFromQuery(query: string) {
  return query.match(/^"([^"]+)"/)?.[1]?.trim() ?? "";
}

function isInstitutionPersonnelPage(
  result: { title: string; url: string; snippet: string; domain?: string | null },
  candidateName: string,
) {
  let url: URL;
  try {
    url = new URL(result.url);
  } catch {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    /(?:^|\.)(?:pmc\.ncbi\.nlm\.nih\.gov|pubmed\.ncbi\.nlm\.nih\.gov|openalex\.org|orcid\.org|researchgate\.net|linkedin\.com|sciprofiles\.com|instagram\.com|facebook\.com|x\.com)$/.test(
      hostname,
    )
  ) {
    return false;
  }

  const corpus = `${hostname} ${url.pathname} ${result.title} ${result.snippet}`;
  const normalizedCorpus = normalizePersonName(corpus);
  const hasName = normalizedCorpus.includes(normalizePersonName(candidateName));
  const hasInstitutionSignal =
    /\.edu(?:\.|$)|\.ac\.|university|hospital|institute|research centre|research center|school of|department|faculty|laboratory|a-star|nccs|bgi|大学|医院|研究所|研究院|学院|实验室/i.test(
      corpus,
    );
  const hasPersonnelPageSignal =
    /\/(?:faculty|people|person|researcher|profile|staff|team|member|doctor|expert|pi|lab|bio)(?:\/|[-_])/i.test(
      url.pathname,
    ) || /faculty|professor|principal investigator|team member|researcher profile|教师|研究员|团队成员/i.test(result.title);
  return hasName && hasInstitutionSignal && hasPersonnelPageSignal;
}

function normalizePersonName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function normalizeSourceUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return value.trim().replace(/\/$/, "").toLowerCase();
  }
}

function quoteQueryPhrase(value: string) {
  return `"${value}"`;
}

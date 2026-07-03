import type { Project } from "@prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import { parseJson, stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import {
  searchGitHubUsers,
  searchOpenAlex,
  searchSerper,
  MissingSerperKeyError,
  type NormalizedSearchResult,
  type SearchProviderResult,
} from "@/lib/search/serper";
import { serializeCandidate, serializeProject, serializeSearchResult } from "@/lib/serializers";
import type { ExtractCandidatesOutput } from "@/lib/schemas";
import { extractCandidatesFromSearch } from "@/lib/workflows";
import { publicErrorMessage } from "@/lib/redaction";
import { requiresProjectReview } from "@/lib/gates";

type SourcingResult =
  | {
      ok: true;
      queries: string[];
      searchResults: Awaited<ReturnType<typeof prisma.searchResult.findMany>>;
      candidates: Array<ReturnType<typeof serializeCandidate>>;
      providerStats: Record<string, number>;
      cacheHits: string[];
    }
  | {
      ok: false;
      error: string;
      status: number;
      storedResults?: number;
      provider?: string;
    };

function toSourcingError(error: unknown): Pick<Extract<SourcingResult, { ok: false }>, "error" | "status"> {
  if (error instanceof MissingSerperKeyError) {
    return { error: "SERPER_API_KEY is not configured.", status: 412 };
  }
  if (error instanceof Error) {
    return { error: publicErrorMessage(error.message), status: 502 };
  }
  return { error: "Unknown sourcing error.", status: 500 };
}

function dedupeResults(results: Array<NormalizedSearchResult & { query: string }>) {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = result.url.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function searchCacheTtlHours() {
  const parsed = Number(process.env.SEARCH_CACHE_TTL_HOURS ?? 168);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 168;
}

function fallbackProviders() {
  return (process.env.SEARCH_FALLBACK_PROVIDERS ?? "openalex,github")
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
}

async function searchWithCacheAndFallback(query: string): Promise<SearchProviderResult> {
  const cached = await prisma.searchCache.findUnique({ where: { query } });
  if (cached && cached.expiresAt > new Date()) {
    return {
      provider: "cache",
      cacheHit: true,
      results: parseJson<NormalizedSearchResult[]>(cached.resultsJson, []),
    };
  }

  try {
    const results = await searchSerper(query);
    await writeSearchCache(query, "serper", results);
    return { provider: "serper", cacheHit: false, results };
  } catch (error) {
    const serperError = error instanceof Error ? error.message : "Unknown Serper error.";

    for (const provider of fallbackProviders()) {
      try {
        const results =
          provider === "openalex"
            ? await searchOpenAlex(query)
            : provider === "github"
              ? await searchGitHubUsers(query)
              : [];
        if (!results.length) continue;
        await writeSearchCache(query, provider, results);
        return { provider: provider as "openalex" | "github", cacheHit: false, results, error: serperError };
      } catch {
        continue;
      }
    }

    throw error;
  }
}

async function writeSearchCache(query: string, provider: string, results: NormalizedSearchResult[]) {
  const ttlMs = searchCacheTtlHours() * 60 * 60 * 1000;
  await prisma.searchCache.upsert({
    where: { query },
    update: {
      provider,
      resultsJson: stringifyJson(results),
      expiresAt: new Date(Date.now() + ttlMs),
    },
    create: {
      query,
      provider,
      resultsJson: stringifyJson(results),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
}

async function persistExtractedCandidates(
  project: Project,
  candidates: ExtractCandidatesOutput["candidates"],
  options?: { searchRunId?: string; sourceType?: string },
) {
  const candidateIds: string[] = [];

  for (const candidate of candidates) {
    const needsHumanReview = candidate.evidenceLevel === "E0" || candidate.evidenceLevel === "E1" || requiresProjectReview(project);
    const expert = await prisma.expert.upsert({
      where: { sourceUrl: candidate.sourceUrl },
      update: {
        name: candidate.name,
        title: candidate.title,
        affiliation: candidate.affiliation,
        domainTagsJson: stringifyJson(candidate.domainTags),
        languagesJson: stringifyJson(candidate.languages),
        region: candidate.region,
        evidenceLevel: candidate.evidenceLevel,
        riskFlagsJson: stringifyJson(candidate.risks),
        expertType: options?.sourceType === "internal" ? "internal" : "external",
      },
      create: {
        name: candidate.name,
        title: candidate.title,
        affiliation: candidate.affiliation,
        sourceUrl: candidate.sourceUrl,
        domainTagsJson: stringifyJson(candidate.domainTags),
        languagesJson: stringifyJson(candidate.languages),
        region: candidate.region,
        evidenceLevel: candidate.evidenceLevel,
        riskFlagsJson: stringifyJson(candidate.risks),
        contactJson: stringifyJson({ profileUrl: candidate.sourceUrl }),
        expertType: options?.sourceType === "internal" ? "internal" : "external",
      },
    });

    const relation = await prisma.projectCandidate.upsert({
      where: { projectId_expertId: { projectId: project.id, expertId: expert.id } },
      update: {
        risksJson: stringifyJson(candidate.risks),
        humanReviewNeeded: needsHumanReview,
        sourceType: options?.sourceType ?? "external",
        sourceRunId: options?.searchRunId ?? undefined,
      },
      create: {
        projectId: project.id,
        expertId: expert.id,
        stage: "sourced",
        risksJson: stringifyJson(candidate.risks),
        humanReviewNeeded: needsHumanReview,
        sourceType: options?.sourceType ?? "external",
        sourceRunId: options?.searchRunId,
      },
    });
    candidateIds.push(relation.id);

    for (const claim of candidate.claims) {
      const existing = await prisma.evidenceItem.findFirst({
        where: {
          candidateId: relation.id,
          sourceUrl: claim.sourceUrl,
          claim: claim.claim,
        },
      });

      if (!existing) {
        await prisma.evidenceItem.create({
          data: {
            projectId: project.id,
            expertId: expert.id,
            candidateId: relation.id,
            claim: claim.claim,
            sourceUrl: claim.sourceUrl,
            sourceTitle: claim.sourceTitle,
            sourceType: claim.sourceType,
            snippet: claim.snippet,
            evidenceLevel: claim.evidenceLevel,
            confidence: claim.confidence,
          },
        });
      }
    }
  }

  return candidateIds;
}

export async function sourceProjectCandidates({
  project,
  queries,
  maxQueries = 4,
  searchRunId,
  sourceType = "external",
}: {
  project: Project;
  queries: string[];
  maxQueries?: number;
  searchRunId?: string;
  sourceType?: string;
}): Promise<SourcingResult> {
  const selectedQueries = queries.map((query) => query.trim()).filter(Boolean).slice(0, maxQueries);
  if (!selectedQueries.length) {
    return { ok: false, error: "No search queries found. Run project analysis first or provide queries.", status: 422 };
  }

  try {
    const rawResults: Array<NormalizedSearchResult & { query: string; provider: string }> = [];
    const providerStats: Record<string, number> = {};
    const cacheHits: string[] = [];
    for (const query of selectedQueries) {
      const search = await searchWithCacheAndFallback(query);
      providerStats[search.provider] = (providerStats[search.provider] ?? 0) + search.results.length;
      if (search.cacheHit) cacheHits.push(query);
      rawResults.push(...search.results.map((result) => ({ ...result, query, provider: search.provider })));
    }

    const dedupedResults = dedupeResults(rawResults);
    const storedResults = dedupedResults.length
      ? await prisma.$transaction(
          dedupedResults.map((result) =>
            prisma.searchResult.upsert({
              where: {
                projectId_url: {
                  projectId: project.id,
                  url: result.url,
                },
              },
              update: {
                searchRunId,
                query: result.query,
                title: result.title,
                snippet: result.snippet,
                domain: result.domain,
                position: result.position,
                sourceType,
              },
              create: {
                projectId: project.id,
                searchRunId,
                query: result.query,
                title: result.title,
                url: result.url,
                snippet: result.snippet,
                domain: result.domain,
                position: result.position,
                sourceType,
              },
            }),
          ),
        )
      : [];

    const extraction = await extractCandidatesFromSearch({
      project: serializeProject(project),
      searchResults: storedResults.map(serializeSearchResult),
    });

    if (!extraction.ok) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "ai.extract_candidates.failed",
        payload: { error: extraction.error, storedResults: storedResults.length },
      });
      return {
        ok: false,
        error: extraction.error,
        status: extraction.error.includes("DASHSCOPE_API_KEY") ? 412 : 502,
        storedResults: storedResults.length,
      };
    }

    const candidateIds = await persistExtractedCandidates(project, extraction.data.candidates, { searchRunId, sourceType });
    const candidates = await prisma.projectCandidate.findMany({
      where: { id: { in: candidateIds } },
      include: { expert: true, evidenceItems: true, outreachDrafts: true, trialTasks: true },
    });

    return {
      ok: true,
      queries: selectedQueries,
      searchResults: storedResults,
      candidates: candidates.map(serializeCandidate),
      providerStats,
      cacheHits,
    };
  } catch (error) {
    const normalized = toSourcingError(error);
    return { ok: false, ...normalized };
  }
}

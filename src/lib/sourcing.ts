import type { Project } from "@prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import { parseJson, stringifyJson } from "@/lib/json";
import { prisma } from "@/lib/prisma";
import {
  searchGitHubUsers,
  searchGitHubMaintainers,
  searchOpenAlex,
  searchSerper,
  MissingSerperKeyError,
  type NormalizedSearchResult,
  type SearchProviderResult,
} from "@/lib/search/serper";
import { serializeCandidate, serializeProjectForGeneration, serializeSearchResult } from "@/lib/serializers";
import type { ExtractCandidatesOutput } from "@/lib/schemas";
import { extractCandidatesFromSearch } from "@/lib/workflows";
import { publicErrorMessage, redactSensitiveText } from "@/lib/redaction";
import { requiresProjectReview } from "@/lib/gates";
import { preserveManualScreeningDecision } from "@/lib/candidate-status";
import {
  beginApprovedAgentToolCall,
  completeAgentToolCall,
  failAgentToolCall,
  type AgentToolExecutionContext,
} from "@/lib/agent-tools";

type SourcingResult =
  | {
      ok: true;
      queries: string[];
      searchResults: Awaited<ReturnType<typeof prisma.searchResult.findMany>>;
      candidates: Array<ReturnType<typeof serializeCandidate>>;
      providerStats: Record<string, number>;
      cacheHits: string[];
      usedFallback: boolean;
      autoScreenedOut: number;
      extractionIssue?: string;
    }
  | {
      ok: false;
      error: string;
      status: number;
      storedResults?: number;
      provider?: string;
    };

export const SEARCH_CACHE_PROVIDERS = {
  githubMaintainers: "github_maintainers_v7",
  githubUsers: "github_users_v1",
  openAlexWorks: "openalex_works_v3",
} as const;

const GITHUB_MAINTAINER_CACHE_PROVIDER = SEARCH_CACHE_PROVIDERS.githubMaintainers;
const GITHUB_USER_CACHE_PROVIDER = SEARCH_CACHE_PROVIDERS.githubUsers;
const OPENALEX_WORK_CACHE_PROVIDER = SEARCH_CACHE_PROVIDERS.openAlexWorks;

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
  if (cached && cached.expiresAt > new Date() && shouldUseCachedSearch(query, cached.provider)) {
    return {
      provider: "cache",
      cacheHit: true,
      results: parseJson<NormalizedSearchResult[]>(cached.resultsJson, []),
    };
  }

  if (isPublicationAuthorIntent(query)) {
    try {
      const results = await searchOpenAlex(query);
      if (results.length) {
        await writeSearchCache(query, OPENALEX_WORK_CACHE_PROVIDER, results);
        return { provider: "openalex", cacheHit: false, results };
      }
    } catch {
      // A publication-index miss falls through to public web search.
    }
  }

  if (isGitHubUserIntent(query)) {
    try {
      const maintainerIntent = isGitHubMaintainerIntent(query);
      const results = maintainerIntent
        ? await searchGitHubMaintainers(query)
        : await searchGitHubUsers(stripProviderHint(query));
      if (results.length) {
        await writeSearchCache(query, maintainerIntent ? GITHUB_MAINTAINER_CACHE_PROVIDER : GITHUB_USER_CACHE_PROVIDER, results);
        return { provider: "github", cacheHit: false, results };
      }
    } catch {
      // Fall through to Serper and configured fallbacks. A GitHub miss should not block public search.
    }
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

export function shouldUseCachedSearch(query: string, provider: string) {
  if (isPublicationAuthorIntent(query)) return provider === OPENALEX_WORK_CACHE_PROVIDER;
  if (!isGitHubUserIntent(query)) return true;
  return isGitHubMaintainerIntent(query)
    ? provider === GITHUB_MAINTAINER_CACHE_PROVIDER
    : provider === GITHUB_USER_CACHE_PROVIDER;
}

function isPublicationAuthorIntent(query: string) {
  return /paper\s*author|publication\s*author|论文\s*作者|论文作者|scholar\s*author|orcid/i.test(query);
}

export function getCompatibleCachedQueries(rows: Array<{ query: string; provider: string }>) {
  return rows.filter((row) => shouldUseCachedSearch(row.query, row.provider)).map((row) => row.query);
}

function isGitHubMaintainerIntent(query: string) {
  return /maintainer|contributor|维护者|维护人|贡献者/i.test(query);
}

function isGitHubUserIntent(query: string) {
  return /github/i.test(query) && /(user|profile|maintainer|contributor|developer|expert|用户|主页|维护者|贡献者)/i.test(query);
}

function stripProviderHint(query: string) {
  return query.replace(/\bgithub\b/gi, "").replace(/\b(user|profile)\b/gi, "").replace(/\s+/g, " ").trim();
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
    const sourceType = options?.sourceType ?? "external";
    const identityKey = buildExpertIdentityKey(candidate);
    const observedLastActiveAt = chooseLatestActivityDate(null, candidate.lastActiveAt);
    const review =
      sourceType === "external"
        ? buildExternalCandidateReviewFields(candidate)
        : { risks: candidate.risks, missing: [] as string[], nextAction: "核验当前可参与状态后推进试标或触达。" };
    const needsHumanReview = requiresSourcedCandidateReview({
      sourceType,
      evidenceLevel: candidate.evidenceLevel,
      regulated: requiresProjectReview(project),
    });
    const expert = await prisma.expert.upsert({
      where: { identityKey },
      update: {
        name: candidate.name,
        title: candidate.title,
        affiliation: candidate.affiliation,
        domainTagsJson: stringifyJson(candidate.domainTags),
        languagesJson: stringifyJson(candidate.languages),
        region: candidate.region,
        evidenceLevel: candidate.evidenceLevel,
        riskFlagsJson: stringifyJson(review.risks),
        sourceUrl: candidate.sourceUrl,
        expertType: sourceType === "internal" ? "internal" : "external",
      },
      create: {
        identityKey,
        name: candidate.name,
        title: candidate.title,
        affiliation: candidate.affiliation,
        sourceUrl: candidate.sourceUrl,
        domainTagsJson: stringifyJson(candidate.domainTags),
        languagesJson: stringifyJson(candidate.languages),
        region: candidate.region,
        evidenceLevel: candidate.evidenceLevel,
        riskFlagsJson: stringifyJson(review.risks),
        contactJson: stringifyJson({ profileUrl: candidate.sourceUrl }),
        expertType: sourceType === "internal" ? "internal" : "external",
        lastActiveAt: observedLastActiveAt,
      },
    });
    if (observedLastActiveAt) {
      await prisma.expert.updateMany({
        where: {
          id: expert.id,
          OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: observedLastActiveAt } }],
        },
        data: { lastActiveAt: observedLastActiveAt },
      });
    }

    const existingRelation = await prisma.projectCandidate.findUnique({
      where: { projectId_expertId: { projectId: project.id, expertId: expert.id } },
      select: { stage: true, humanReviewNeeded: true, nextAction: true },
    });
    const reviewUpdate = preserveManualScreeningDecision(existingRelation, {
      humanReviewNeeded: needsHumanReview,
      nextAction: review.nextAction,
    });
    const relation = await prisma.projectCandidate.upsert({
      where: { projectId_expertId: { projectId: project.id, expertId: expert.id } },
      update: {
        risksJson: stringifyJson(review.risks),
        missingJson: stringifyJson(review.missing),
        nextAction: reviewUpdate.nextAction,
        humanReviewNeeded: reviewUpdate.humanReviewNeeded,
        sourceType,
        sourceRunId: options?.searchRunId ?? undefined,
      },
      create: {
        projectId: project.id,
        expertId: expert.id,
        stage: "sourced",
        risksJson: stringifyJson(review.risks),
        missingJson: stringifyJson(review.missing),
        nextAction: review.nextAction,
        humanReviewNeeded: needsHumanReview,
        sourceType,
        sourceRunId: options?.searchRunId,
      },
    });
    candidateIds.push(relation.id);

    if (options?.searchRunId) {
      await prisma.candidateDiscovery.upsert({
        where: {
          searchRunId_candidateId: {
            searchRunId: options.searchRunId,
            candidateId: relation.id,
          },
        },
        update: {
          sourceUrl: candidate.sourceUrl,
          evidenceLevel: candidate.evidenceLevel,
        },
        create: {
          searchRunId: options.searchRunId,
          candidateId: relation.id,
          sourceUrl: candidate.sourceUrl,
          evidenceLevel: candidate.evidenceLevel,
        },
      });
    }

    for (const claim of candidate.claims) {
      const authoritativeGitHubEvidence = claim.sourceType === "github_api";
      const existingMatches = await prisma.evidenceItem.findMany({
        where: {
          candidateId: relation.id,
          sourceUrl: claim.sourceUrl,
          ...(authoritativeGitHubEvidence ? { sourceType: "github_api" } : { claim: claim.claim }),
        },
        orderBy: { createdAt: "asc" },
      });
      const existing = existingMatches[0];

      if (existing) {
        await prisma.evidenceItem.update({
          where: { id: existing.id },
          data: {
            claim: claim.claim,
            sourceTitle: claim.sourceTitle,
            sourceType: claim.sourceType,
            snippet: claim.snippet,
            evidenceLevel: claim.evidenceLevel,
            confidence: claim.confidence,
          },
        });
        if (authoritativeGitHubEvidence && existingMatches.length > 1) {
          await prisma.evidenceItem.deleteMany({
            where: { id: { in: existingMatches.slice(1).map((item) => item.id) } },
          });
        }
      } else {
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

export function buildExpertIdentityKey(candidate: { name: string; sourceUrl: string }) {
  const sourceUrl = normalizeUrl(candidate.sourceUrl);
  if (isLikelyGitHubUserUrl(sourceUrl) || isLikelyLinkedInProfileUrl(sourceUrl)) return sourceUrl;
  return `${sourceUrl}#person=${normalizedIdentityText(candidate.name)}`;
}

export function requiresSourcedCandidateReview({
  sourceType,
  evidenceLevel,
  regulated,
}: {
  sourceType: string;
  evidenceLevel: string;
  regulated: boolean;
}) {
  return sourceType !== "internal" || evidenceLevel === "E0" || evidenceLevel === "E1" || regulated;
}

export function getRediscoveredCandidateScreenOutUpdate({
  candidate,
  currentResultUrls,
  acceptedSourceUrls,
}: {
  candidate: {
    stage: string;
    sourceType: string;
    humanReviewNeeded: boolean;
    sourceUrl: string | null;
  };
  currentResultUrls: string[];
  acceptedSourceUrls: string[];
}) {
  if (
    candidate.sourceType !== "external" ||
    !candidate.humanReviewNeeded ||
    !["sourced", "enriched"].includes(candidate.stage) ||
    !candidate.sourceUrl
  ) {
    return null;
  }
  const sourceUrl = normalizeUrl(candidate.sourceUrl);
  const currentUrls = new Set(currentResultUrls.map(normalizeUrl));
  const acceptedUrls = new Set(acceptedSourceUrls.map(normalizeUrl));
  if (!currentUrls.has(sourceUrl) || acceptedUrls.has(sourceUrl)) return null;
  return {
    stage: "screened_out",
    humanReviewNeeded: false,
    nextAction:
      "本项目暂不推进：最新公开资料未通过当前身份、相关性或近期活跃度校验。如有新证据，可重新复核。",
  } as const;
}

export async function sourceProjectCandidates({
  project,
  queries,
  maxQueries = 4,
  searchRunId,
  sourceType = "external",
  toolContext,
  candidateFilter,
}: {
  project: Project;
  queries: string[];
  maxQueries?: number;
  searchRunId?: string;
  sourceType?: string;
  toolContext?: AgentToolExecutionContext;
  candidateFilter?: (input: {
    candidates: ExtractCandidatesOutput["candidates"];
    searchResults: Array<{ title: string; url: string; snippet: string; domain?: string | null }>;
  }) => ExtractCandidatesOutput["candidates"];
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
      let toolCall: Awaited<ReturnType<typeof beginApprovedAgentToolCall>> | null = null;
      try {
        if (toolContext) {
          toolCall = await beginApprovedAgentToolCall({
            context: toolContext,
            toolName: "public_search",
            arguments: { query },
          });
        }
        const search = await searchWithCacheAndFallback(query);
        providerStats[search.provider] = (providerStats[search.provider] ?? 0) + search.results.length;
        if (search.cacheHit) cacheHits.push(query);
        rawResults.push(...search.results.map((result) => ({ ...result, query, provider: search.provider })));
        if (toolCall) {
          await completeAgentToolCall({
            toolCallId: toolCall.toolCallId,
            startedAt: toolCall.startedAt,
            provider: search.provider,
            resultSummary: {
              query: redactSensitiveText(query),
              resultCount: search.results.length,
              cacheHit: search.cacheHit,
              fallbackUsed: Boolean(search.error),
            },
          });
        }
      } catch (error) {
        if (toolCall) {
          await failAgentToolCall({
            toolCallId: toolCall.toolCallId,
            startedAt: toolCall.startedAt,
            error,
          });
        }
        throw error;
      }
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

    if (searchRunId && storedResults.length) {
      const storedByUrl = new Map(storedResults.map((result) => [normalizeUrl(result.url), result]));
      const occurrences = new Map<
        string,
        { searchResultId: string; query: string; provider: string; position: number | null }
      >();
      for (const result of rawResults) {
        const stored = storedByUrl.get(normalizeUrl(result.url));
        if (!stored) continue;
        const key = `${stored.id}\n${result.query}`;
        if (!occurrences.has(key)) {
          occurrences.set(key, {
            searchResultId: stored.id,
            query: result.query,
            provider: result.provider,
            position: result.position,
          });
        }
      }
      await prisma.$transaction(
        Array.from(occurrences.values()).map((occurrence) =>
          prisma.searchResultOccurrence.upsert({
            where: {
              searchRunId_searchResultId_query: {
                searchRunId,
                searchResultId: occurrence.searchResultId,
                query: occurrence.query,
              },
            },
            update: {
              provider: occurrence.provider,
              position: occurrence.position,
            },
            create: {
              searchRunId,
              searchResultId: occurrence.searchResultId,
              query: occurrence.query,
              provider: occurrence.provider,
              position: occurrence.position,
            },
          }),
        ),
      );
    }

    const extractionResults = selectResultsForCandidateExtraction(storedResults, 8);
    const extraction = await extractCandidatesFromSearch({
      project: serializeProjectForGeneration(project),
      searchResults: extractionResults.map(serializeSearchResult),
    });
    const resolved = resolveCandidateExtraction({
      project,
      searchResults: storedResults,
      extraction: extraction.ok
        ? { ok: true, candidates: extraction.data.candidates }
        : { ok: false, error: extraction.error },
    });
    const acceptedCandidates = candidateFilter
      ? candidateFilter({ candidates: resolved.candidates, searchResults: storedResults })
      : resolved.candidates;
    const autoScreenedOut =
      sourceType === "external" && !candidateFilter
        ? await screenOutRejectedRediscoveries({
            projectId: project.id,
            searchRunId,
            searchResults: storedResults,
            acceptedCandidates,
          })
        : 0;
    const acceptanceRejectedCandidates = resolved.candidates.length - acceptedCandidates.length;
    if (acceptanceRejectedCandidates > 0) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "candidate.acceptance_filter.rejected",
        payload: {
          rejectedCandidates: acceptanceRejectedCandidates,
          acceptedCandidates: acceptedCandidates.length,
          searchRunId,
        },
      });
    }
    if (resolved.rejectedCandidates > 0) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "ai.extract_candidates.rejected",
        payload: {
          rejectedCandidates: resolved.rejectedCandidates,
          storedResults: storedResults.length,
        },
      });
    }
    if (resolved.usedFallback) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "ai.extract_candidates.fallback",
        payload: {
          error: extraction.ok ? "Model returned no candidates." : extraction.error,
          storedResults: storedResults.length,
          candidates: resolved.candidates.length,
        },
      });
    } else if (resolved.failureReason) {
      await writeAuditEvent({
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "ai.extract_candidates.failed",
        payload: {
          error: extraction.ok ? resolved.failureReason : extraction.error,
          storedResults: storedResults.length,
        },
      });
    }

    const candidateIds = await persistExtractedCandidates(project, acceptedCandidates, { searchRunId, sourceType });
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
      usedFallback: resolved.usedFallback,
      autoScreenedOut,
      extractionIssue:
        resolved.failureReason ??
        (resolved.candidates.length > 0 && acceptedCandidates.length === 0
          ? "搜索结果未通过本次候选身份与来源要求。"
          : undefined),
    };
  } catch (error) {
    const normalized = toSourcingError(error);
    return { ok: false, ...normalized };
  }
}

async function screenOutRejectedRediscoveries({
  projectId,
  searchRunId,
  searchResults,
  acceptedCandidates,
}: {
  projectId: string;
  searchRunId?: string;
  searchResults: Array<{ url: string }>;
  acceptedCandidates: ExtractCandidatesOutput["candidates"];
}) {
  const currentResultUrls = Array.from(new Set(searchResults.map((result) => result.url).filter(Boolean)));
  if (!currentResultUrls.length) return 0;
  const existing = await prisma.projectCandidate.findMany({
    where: {
      projectId,
      sourceType: "external",
      stage: { in: ["sourced", "enriched"] },
      humanReviewNeeded: true,
    },
    include: { expert: true },
  });
  const acceptedSourceUrls = acceptedCandidates.map((candidate) => candidate.sourceUrl);
  const screenedOutIds: string[] = [];
  for (const candidate of existing) {
    const update = getRediscoveredCandidateScreenOutUpdate({
      candidate: {
        stage: candidate.stage,
        sourceType: candidate.sourceType,
        humanReviewNeeded: candidate.humanReviewNeeded,
        sourceUrl: candidate.expert.sourceUrl,
      },
      currentResultUrls,
      acceptedSourceUrls,
    });
    if (!update) continue;
    const updated = await prisma.projectCandidate.updateMany({
      where: {
        id: candidate.id,
        stage: { in: ["sourced", "enriched"] },
        humanReviewNeeded: true,
      },
      data: update,
    });
    if (updated.count) screenedOutIds.push(candidate.id);
  }
  if (screenedOutIds.length) {
    await writeAuditEvent({
      projectId,
      entityType: "project",
      entityId: projectId,
      action: "candidate.rediscovery.screened_out",
      payload: {
        candidateIds: screenedOutIds,
        count: screenedOutIds.length,
        searchRunId,
        reason: "current_quality_gate_rejected",
      },
    });
  }
  return screenedOutIds.length;
}

export function selectResultsForCandidateExtraction<
  T extends { query?: string | null; title: string; url: string; snippet: string },
>(results: T[], maxResults = 8) {
  const limit = Math.max(1, Math.min(16, Math.round(maxResults)));
  const ranked = results.map((result, index) => ({ result, index, score: candidateExtractionScore(result) }));
  const selected: typeof ranked = [];
  const selectedIndexes = new Set<number>();
  const queryGroups = new Map<string, typeof ranked>();

  for (const item of ranked) {
    const query = item.result.query?.trim() || "__unknown__";
    const group = queryGroups.get(query) ?? [];
    group.push(item);
    queryGroups.set(query, group);
  }

  for (const group of queryGroups.values()) {
    if (selected.length >= limit) break;
    const best = [...group].sort((a, b) => b.score - a.score || a.index - b.index)[0];
    if (!best) continue;
    selected.push(best);
    selectedIndexes.add(best.index);
  }

  for (const item of [...ranked].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (selected.length >= limit) break;
    if (selectedIndexes.has(item.index)) continue;
    selected.push(item);
    selectedIndexes.add(item.index);
  }

  return selected.map((item) => item.result);
}

function candidateExtractionScore(result: { title: string; url: string; snippet: string }) {
  const text = `${result.title} ${result.snippet}`;
  let score = 0;
  if (isLikelyGitHubUserUrl(result.url) || isLikelyLinkedInProfileUrl(result.url)) score += 8;
  if (hasAuthoritativeGitHubContributionEvidence(result)) score += 6;
  if (/profile|speaker|author|maintainer|contributor|个人主页|专家简介|讲者|作者|团队成员/i.test(text)) score += 4;
  if (/report|whitepaper|release notes|documentation|指南|报告|文档/i.test(text)) score -= 2;
  return score;
}

export function resolveCandidateExtraction({
  project,
  searchResults,
  extraction,
}: {
  project: CandidateProjectContext;
  searchResults: Array<{ title: string; url: string; snippet: string; domain?: string | null }>;
  extraction:
    | { ok: true; candidates: ExtractCandidatesOutput["candidates"] }
    | { ok: false; error: string };
}) {
  const modelCandidates = extraction.ok
      ? extraction.candidates
        .filter(isPlausibleExtractedCandidate)
        .filter((candidate) => isSourceBackedCandidate(candidate, searchResults))
        .filter((candidate) => isCandidateSourceAdmissible(candidate, searchResults))
        .filter((candidate) => isCandidateIdentityBacked(candidate, searchResults))
        .filter((candidate) => isCandidateRelevantToProject(project, candidate, searchResults))
        .map((candidate) => upgradeCandidateEvidence(candidate, searchResults))
    : [];
  const rejectedCandidates = extraction.ok ? extraction.candidates.length - modelCandidates.length : 0;
  const providerCandidates = buildAuthoritativeProviderCandidates(project, searchResults).filter((candidate) =>
    isCandidateRelevantToProject(project, candidate, searchResults),
  );
  const resolvedCandidates = mergeCandidateLeads(modelCandidates, providerCandidates);
  if (resolvedCandidates.length) {
    return {
      candidates: resolvedCandidates,
      usedFallback: modelCandidates.length === 0,
      failureReason: null,
      rejectedCandidates,
    };
  }

  const fallbackCandidates = buildFallbackCandidatesFromSearchResults(project, searchResults);
  if (fallbackCandidates.length) {
    return {
      candidates: fallbackCandidates,
      usedFallback: true,
      failureReason: null,
      rejectedCandidates,
    };
  }

  return {
    candidates: [] as ExtractCandidatesOutput["candidates"],
    usedFallback: false,
    failureReason: extraction.ok
      ? "搜索结果中没有识别出明确的个人主页、作者或讲者。"
      : extraction.error,
    rejectedCandidates,
  };
}

function buildAuthoritativeProviderCandidates(
  project: CandidateProjectContext,
  searchResults: Array<{ title: string; url: string; snippet: string; domain?: string | null }>,
): ExtractCandidatesOutput["candidates"] {
  const languages = parseJson<string[]>(project.languagesJson, []);
  const regions = parseJson<string[]>(project.regionsJson, []);
  const publicationAuthors = searchResults
    .filter((result) => isOpenAlexWorkResult(result) && isPublicationEvidenceRelevantToProject(project, result))
    .slice(0, 2)
    .flatMap((result) =>
      parseOpenAlexAuthors(result.snippet)
        .slice(0, 2)
        .map(({ name, affiliation }) => ({
          name,
          title: "论文作者",
          affiliation,
          sourceUrl: result.url,
          domainTags: [project.domain, "论文作者"].filter(Boolean).map(String),
          languages,
          region: regions[0] ?? null,
          evidenceLevel: "E2" as const,
          risks: ["论文作者身份由公开学术索引确认，仍需人工核验当前任职、任务适配和触达许可。"],
          claims: [
            {
              claim: `${name}列于该公开论文记录的作者名单中`,
              sourceUrl: result.url,
              sourceTitle: result.title,
              sourceType: "openalex_api",
              snippet: result.snippet,
              evidenceLevel: "E2" as const,
              confidence: 0.9,
            },
          ],
        })),
    );
  const directPublicPeople = searchResults
    .map((result) => ({ result, person: inferDedicatedPublicPerson(result) }))
    .filter(
      (item): item is {
        result: (typeof searchResults)[number];
        person: { name: string; kind: "conference" | "institution"; affiliation: string | null };
      } => Boolean(item.person),
    )
    .slice(0, 6)
    .map(({ result, person }) => ({
      name: person.name,
      title: person.kind === "conference" ? "会议讲者" : "机构团队成员",
      affiliation: person.affiliation,
      sourceUrl: result.url,
      domainTags: [project.domain, person.kind === "conference" ? "会议讲者" : "机构团队"].filter(Boolean).map(String),
      languages,
      region: regions[0] ?? null,
      evidenceLevel: "E1" as const,
      risks: ["公开页面提供了候选线索，仍需人工复核身份、任务适配、资质和触达许可。"],
      claims: [
        {
          claim:
            person.kind === "conference"
              ? `${person.name}列于专属公开会议讲者页面`
              : `${person.name}列于机构公开人员页面`,
          sourceUrl: result.url,
          sourceTitle: result.title,
          sourceType: person.kind === "conference" ? "public_event_page" : "institution_profile",
          snippet: result.snippet,
          evidenceLevel: "E1" as const,
          confidence: person.kind === "conference" ? 0.72 : 0.75,
        },
      ],
    }));
  return mergeCandidateLeads(publicationAuthors, directPublicPeople);
}

function parseOpenAlexAuthors(snippet: string) {
  const match = snippet.match(/Authors?:\s*(.+?)(?=\.\s+(?:DOI|Source):|$)/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(";")
    .map((entry) => entry.trim())
    .map((entry) => {
      const parsed = entry.match(/^(.+?)(?:\s+\((.+)\))?$/);
      return {
        name: parsed?.[1]?.trim() ?? "",
        affiliation: parsed?.[2]?.trim() || null,
      };
    })
    .filter(({ name }) => name.length >= 2 && name.length <= 80);
}

function isOpenAlexWorkResult(result: { url: string; snippet: string; domain?: string | null }) {
  return /openalex\.org/i.test(`${result.domain ?? ""} ${result.url}`) && /Authors?:/i.test(result.snippet);
}

function inferDedicatedPublicPerson(result: { title: string; url: string; snippet: string; domain?: string | null }) {
  if (isOpenAlexWorkResult(result)) return null;
  const sourceText = `${result.title} ${result.url} ${result.domain ?? ""}`;
  const speakerMatch = result.snippet.match(
    /(?:^|[.;。；]\s*)Speaker\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})(?=\s*[,;]|\s+is\b)/,
  );
  if (speakerMatch?.[1] && /speaker|symposi|conference|meeting|bio[-_/]/i.test(sourceText)) {
    const name = speakerMatch[1].trim();
    const affiliation = result.snippet
      .slice((speakerMatch.index ?? 0) + speakerMatch[0].length)
      .match(/^\s*[,;]\s*([^.;·•・]+)/)?.[1]
      ?.trim();
    return { name, kind: "conference" as const, affiliation: affiliation || result.domain || null };
  }

  const institutionPage =
    /\/researcher\/|\/faculty\/|\/people\/|\/team\/|\/member\/|\/staff\/|\/list\b/i.test(result.url) &&
    /\.edu(?:\.|\/)|\.ac\.|hospital|university|institute|research|nccs/i.test(sourceText);
  if (!institutionPage) return null;
  const prefixedName = result.title.match(
    /^(?:(?:Assoc(?:iate)?\s+)?Prof(?:essor)?\.?|Dr\.?)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})$/,
  )?.[1];
  const plainName = result.title.match(
    /^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})(?:,\s*(?:Ph\.?D\.?|M\.?D\.?))?$/,
  )?.[1];
  const name = (prefixedName || plainName || "").trim();
  if (!name) {
    return null;
  }
  const normalizedName = normalizedIdentityText(name);
  const snippetSupportsIdentity = normalizedIdentityText(result.snippet).includes(normalizedName);
  const urlSupportsIdentity = normalizedIdentityText(result.url).includes(normalizedName);
  const namedPeopleInSnippet = Array.from(
    result.snippet.matchAll(/\b(?:Assoc(?:iate)?\s+Prof(?:essor)?|Prof(?:essor)?|Dr)\.?\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4})/g),
  ).map((match) => normalizedIdentityText(match[1] ?? ""));
  const snippetNamesAnotherPerson = namedPeopleInSnippet.some((person) => person && !person.startsWith(normalizedName));
  if ((!snippetSupportsIdentity && !urlSupportsIdentity) || (!snippetSupportsIdentity && snippetNamesAnotherPerson)) {
    return null;
  }
  return { name, kind: "institution" as const, affiliation: inferAffiliation(result) };
}

function mergeCandidateLeads(
  primary: ExtractCandidatesOutput["candidates"],
  authoritative: ExtractCandidatesOutput["candidates"],
) {
  const merged = new Map<string, ExtractCandidatesOutput["candidates"][number]>();
  for (const candidate of [...primary, ...authoritative]) {
    const key = buildExpertIdentityKey(candidate);
    const current = merged.get(key);
    if (!current || evidenceLevelRank(candidate.evidenceLevel) > evidenceLevelRank(current.evidenceLevel)) {
      merged.set(key, candidate);
    }
  }
  return Array.from(merged.values());
}

function isSourceBackedCandidate(
  candidate: ExtractCandidatesOutput["candidates"][number],
  searchResults: Array<{ url: string }>,
) {
  const savedUrls = new Set(searchResults.map((result) => normalizeUrl(result.url)));
  return savedUrls.has(normalizeUrl(candidate.sourceUrl));
}

function isCandidateSourceAdmissible(
  candidate: ExtractCandidatesOutput["candidates"][number],
  searchResults: Array<{ title: string; url: string; snippet: string; domain?: string | null }>,
) {
  const result = searchResults.find((item) => normalizeUrl(item.url) === normalizeUrl(candidate.sourceUrl));
  return result ? isCandidateSourceAdmissibleForName(candidate.name, result) : false;
}

function isCandidateSourceAdmissibleForName(
  name: string,
  result: { title: string; url: string; snippet: string; domain?: string | null },
) {
  if (isLikelyGitHubUserUrl(result.url)) return hasCurrentGitHubProfileSignal(result.snippet);
  if (isLikelyLinkedInProfileUrl(result.url)) return true;
  if (isOpenAlexWorkResult(result)) {
    return normalizedIdentityText(result.snippet).includes(normalizedIdentityText(name));
  }

  const dedicatedPerson = inferDedicatedPublicPerson(result);
  if (dedicatedPerson) {
    return normalizedIdentityText(dedicatedPerson.name) === normalizedIdentityText(name);
  }
  if (
    isSharedPeopleSource(result) &&
    normalizedIdentityText(`${result.title} ${result.snippet}`).includes(normalizedIdentityText(name))
  ) {
    return true;
  }

  try {
    const url = new URL(result.url);
    const identityText = normalizedIdentityText(`${result.title} ${result.snippet}`);
    const namedProfilePath = /\/(?:profile|profiles|expert|experts)(?:\/|$)/i.test(url.pathname);
    const dedicatedProfilePath =
      /(^|\.)orcid\.org$/i.test(url.hostname) ||
      (/(^|\.)scholar\.google\./i.test(url.hostname) && url.pathname.includes("citations")) ||
      (/(^|\.)researchgate\.net$/i.test(url.hostname) && /^\/profile\//i.test(url.pathname)) ||
      (/(^|\.)codementor\.io$/i.test(url.hostname) && /^\/@/i.test(url.pathname)) ||
      namedProfilePath;
    return dedicatedProfilePath && identityText.includes(normalizedIdentityText(name));
  } catch {
    return false;
  }
}

function upgradeCandidateEvidence(
  candidate: ExtractCandidatesOutput["candidates"][number],
  searchResults: Array<{ title: string; url: string; snippet: string; domain?: string | null }>,
) {
  const savedUrls = new Set(searchResults.map((result) => normalizeUrl(result.url)));
  const supportedClaims = candidate.claims
    .filter((claim) => savedUrls.has(normalizeUrl(claim.sourceUrl)))
    .map((claim) => {
      const source = searchResults.find((result) => normalizeUrl(result.url) === normalizeUrl(claim.sourceUrl));
      return {
        ...claim,
        sourceTitle: claim.sourceTitle?.trim() || source?.title || null,
        snippet: claim.snippet.trim() || source?.snippet || "",
        evidenceLevel: capPublicEvidenceLevel(claim.evidenceLevel),
      };
    });
  const matchingResult = searchResults.find((result) => normalizeUrl(result.url) === normalizeUrl(candidate.sourceUrl));
  if (matchingResult && isSharedPeopleSource(matchingResult)) {
    const openAlexEvidence = isOpenAlexAuthorEvidence(candidate, matchingResult);
    const evidenceLevel = openAlexEvidence ? ("E2" as const) : ("E1" as const);
    const sourceType = openAlexEvidence ? "openalex_api" : "public_event_page";
    return {
      ...candidate,
      lastActiveAt: null,
      evidenceLevel,
      claims: [
        {
          claim: openAlexEvidence
            ? `${candidate.name}列于该公开论文记录的作者名单中`
            : `${candidate.name}列于该公开会议页面的讲者或嘉宾名单中`,
          sourceUrl: matchingResult.url,
          sourceTitle: matchingResult.title,
          sourceType,
          snippet: matchingResult.snippet,
          evidenceLevel,
          confidence: openAlexEvidence ? 0.9 : 0.65,
        },
      ],
    };
  }
  if (!matchingResult || !hasAuthoritativeGitHubContributionEvidence(matchingResult)) {
    const supportedRank = supportedClaims.length
      ? Math.min(2, Math.max(...supportedClaims.map((claim) => evidenceLevelRank(claim.evidenceLevel))))
      : 1;
    return {
      ...candidate,
      lastActiveAt: null,
      evidenceLevel: evidenceLevelFromRank(Math.min(evidenceLevelRank(candidate.evidenceLevel), supportedRank)),
      claims: supportedClaims,
    };
  }
  const evidenceLevel = "E2" as const;
  const lastActiveAt = extractGitHubRecentActivity(matchingResult.snippet);
  const risks = candidate.risks.filter((risk) => !/近期.*活跃|活跃.*近期/.test(risk));
  if (!lastActiveAt) {
    risks.push("GitHub 公开贡献记录未提供近期活跃证据，需人工确认当前活跃度。");
  }
  const hasMatchingClaim = supportedClaims.some((claim) => normalizeUrl(claim.sourceUrl) === normalizeUrl(matchingResult.url));
  return {
    ...candidate,
    lastActiveAt,
    risks,
    evidenceLevel,
    claims: hasMatchingClaim
      ? supportedClaims.map((claim) =>
          normalizeUrl(claim.sourceUrl) === normalizeUrl(matchingResult.url)
            ? {
                ...claim,
                claim: "GitHub 公开贡献记录与目标技术相关",
                sourceTitle: matchingResult.title,
                sourceType: "github_api",
                snippet: matchingResult.snippet,
                evidenceLevel,
                confidence: Math.max(claim.confidence, 0.9),
              }
            : claim,
        )
      : [
          ...supportedClaims,
          {
            claim: "GitHub 公开贡献记录与目标技术相关",
            sourceUrl: matchingResult.url,
            sourceTitle: matchingResult.title,
            sourceType: "github_api",
            snippet: matchingResult.snippet,
            evidenceLevel: "E2" as const,
            confidence: 0.9,
          },
        ],
  };
}

function isCandidateIdentityBacked(
  candidate: ExtractCandidatesOutput["candidates"][number],
  searchResults: Array<{ title: string; url: string; snippet: string; domain?: string | null }>,
) {
  const result = searchResults.find((item) => normalizeUrl(item.url) === normalizeUrl(candidate.sourceUrl));
  if (!result || !isSharedPeopleSource(result)) return true;
  return normalizedIdentityText(`${result.title} ${result.snippet}`).includes(normalizedIdentityText(candidate.name));
}

function isSharedPeopleSource(result: { title: string; url: string; snippet: string; domain?: string | null }) {
  const text = `${result.title} ${result.url} ${result.snippet}`;
  return (
    /conference|meeting|summit|symposium|workshop|speakers?|agenda|talk\s+by|pycon|djangocon|kubecon|reactconf|europython|会议|论坛|研讨会|峰会|嘉宾|日程/i.test(text) ||
    /Authors?:\s*[^.;]+[;,][^.;]+/i.test(result.snippet) ||
    /openalex\.org/i.test(`${result.domain ?? ""} ${result.url}`)
  );
}

function isOpenAlexAuthorEvidence(
  candidate: ExtractCandidatesOutput["candidates"][number],
  result: { url: string; snippet: string; domain?: string | null },
) {
  return (
    /openalex\.org/i.test(`${result.domain ?? ""} ${result.url}`) &&
    normalizedIdentityText(result.snippet).includes(normalizedIdentityText(candidate.name))
  );
}

function normalizedIdentityText(value: string) {
  return value.toLowerCase().replace(/[\s·•._-]+/g, "");
}

function isPlausibleExtractedCandidate(candidate: ExtractCandidatesOutput["candidates"][number]) {
  const name = candidate.name.trim();
  if (name.length < 2 || name.length > 80) return false;
  if (/^#|(?:^|\s)#[^\s]+.*(?:^|\s)#[^\s]+/i.test(name)) return false;
  if (/^https?:\/\/|@[^\s]+\.[^\s]+$/.test(name)) return false;
  if (/^(unknown|anonymous|expert|speaker|author|待复核|专家|讲者|作者)$/i.test(name)) return false;

  const sourceUrl = candidate.sourceUrl.trim();
  try {
    const url = new URL(sourceUrl);
    if (/(^|\.)github\.com$/i.test(url.hostname)) return isLikelyGitHubUserUrl(sourceUrl);
    if (/(^|\.)linkedin\.com$/i.test(url.hostname)) return isLikelyLinkedInProfileUrl(sourceUrl);
  } catch {
    return false;
  }
  return true;
}

export function buildFallbackCandidatesFromSearchResults(
  project: CandidateProjectContext,
  results: Array<{ title: string; url: string; snippet: string; domain?: string | null }>,
): ExtractCandidatesOutput["candidates"] {
  const languages = parseJson<string[]>(project.languagesJson, []);
  const regions = parseJson<string[]>(project.regionsJson, []);
  return results
    .filter((result) => result.title.trim() && result.url.trim())
    .filter((result) => !isOpenAlexWorkResult(result) || isPublicationEvidenceRelevantToProject(project, result))
    .slice(0, 12)
    .map((result) => ({ result, name: inferCandidateName(result) }))
    .filter(({ result, name }) => isLikelyCandidateLead(result, name))
    .filter(({ result, name }) => isCandidateSourceAdmissibleForName(name, result))
    .filter(({ result }) => !hasAuthoritativeGitHubContributionEvidence(result) || isGitHubEvidenceRelevantToProject(project, result))
    .map(({ result, name }) => {
      const authoritativeGitHubEvidence = hasAuthoritativeGitHubContributionEvidence(result);
      const evidenceLevel = authoritativeGitHubEvidence ? ("E2" as const) : ("E1" as const);
      const lastActiveAt = isLikelyGitHubUserUrl(result.url) ? extractGitHubRecentActivity(result.snippet) : null;
      return {
        name,
        title: inferCandidateTitle(result),
        affiliation: inferAffiliation(result),
        sourceUrl: result.url,
        domainTags: [project.domain, result.domain].filter(Boolean).map(String).slice(0, 4),
        languages,
        region: regions[0] ?? null,
        lastActiveAt,
        evidenceLevel,
        risks: [
          authoritativeGitHubEvidence
            ? "公开贡献记录已核验，仍需人工确认身份、能力边界和触达许可。"
            : "AI 抽取不可用，需人工复核公开结果是否为真实专家。",
          ...(authoritativeGitHubEvidence && !lastActiveAt
            ? ["GitHub 公开贡献记录未提供近期活跃证据，需人工确认当前活跃度。"]
            : []),
        ],
        claims: [
          {
            claim: authoritativeGitHubEvidence
              ? "GitHub 公开贡献记录与项目要求的技术仓库相关"
              : "公开搜索结果显示该候选可能与项目需求相关",
            sourceUrl: result.url,
            sourceTitle: result.title,
            sourceType: authoritativeGitHubEvidence ? "github_api" : "public_web_fallback",
            snippet: result.snippet,
            evidenceLevel,
            confidence: authoritativeGitHubEvidence ? 0.9 : 0.35,
          },
        ],
      };
    });
}

type CandidateProjectContext = Pick<Project, "domain" | "languagesJson" | "regionsJson"> &
  Partial<Pick<Project, "title" | "rawDemand" | "taskType">>;

function isCandidateRelevantToProject(
  project: CandidateProjectContext,
  candidate: ExtractCandidatesOutput["candidates"][number],
  searchResults: Array<{ title: string; url: string; snippet: string; domain?: string | null }>,
) {
  const matchingResult = searchResults.find((result) => normalizeUrl(result.url) === normalizeUrl(candidate.sourceUrl));
  if (!matchingResult) return false;
  if (isOpenAlexWorkResult(matchingResult)) return isPublicationEvidenceRelevantToProject(project, matchingResult);
  if (hasAuthoritativeGitHubContributionEvidence(matchingResult)) {
    return isGitHubEvidenceRelevantToProject(project, matchingResult);
  }
  return true;
}

function isPublicationEvidenceRelevantToProject(
  project: CandidateProjectContext,
  result: { title: string; snippet: string },
) {
  const projectText = [project.title, project.domain, project.taskType, project.rawDemand].filter(Boolean).join(" ").toLowerCase();
  const resultText = `${result.title} ${result.snippet}`.toLowerCase();
  const acceptsAcademicEvidence =
    /论文|作者|科研|研究|学术|具身智能|机器人|人工智能|paper\s+author|publication\s+author|research|academic|scholar|robotics|embodied\s+intelligence/i.test(
      projectText,
    );
  if (!acceptsAcademicEvidence) return false;

  const topicGroups: Array<[RegExp, RegExp]> = [
    [/肿瘤|癌症|单细胞|免疫|oncology|cancer|tumou?r|single[-\s]?cell|immun/, /oncology|cancer|tumou?r|single[-\s]?cell|rna|immun/],
    [/医学影像|放射|肺结节|medical imaging|radiology|lung nodule/, /medical imaging|radiology|lung nodule|ct\b/],
    [/python|fastapi|django|sqlalchemy/, /python|fastapi|django|sqlalchemy/],
    [/kubernetes|ebpf|cilium|hubble/, /kubernetes|ebpf|cilium|hubble/],
    [/自然语言|文本|nlp|language/, /natural language|nlp|language|text/],
  ];
  const activeGroups = topicGroups.filter(([projectPattern]) => projectPattern.test(projectText));
  return activeGroups.length === 0 || activeGroups.some(([, resultPattern]) => resultPattern.test(resultText));
}

function isGitHubEvidenceRelevantToProject(
  project: CandidateProjectContext,
  result: { url: string; snippet: string },
) {
  const repositories = extractGitHubEvidenceRepositories(result.snippet);
  if (!repositories.length) return false;
  if (!hasCurrentGitHubProfileSignal(result.snippet)) return false;
  const repositoryText = repositories.join(" ").toLowerCase();
  const projectText = [project.title, project.domain, project.taskType, project.rawDemand].filter(Boolean).join(" ").toLowerCase();
  const specificTerms = [
    "pydantic-core",
    "pydantic",
    "sqlmodel",
    "fastapi",
    "django",
    "flask",
    "cilium",
    "hubble",
    "sqlalchemy",
  ].filter((term) => projectText.includes(term));
  if (specificTerms.length) return specificTerms.some((term) => repositoryText.includes(term));

  const technologyGroups = [
    {
      project: /python|后端|代码评审|code review|backend/,
      repository: /python|fastapi|django|flask|pydantic|sqlmodel|sqlalchemy|pytest|ruff|mypy/,
    },
    {
      project: /kubernetes|\bebpf\b|cilium|hubble|云原生网络|网络可观测/,
      repository: /kubernetes|\bebpf\b|cilium|hubble|isovalent/,
    },
    { project: /typescript|javascript|react|next\.js|前端/, repository: /typescript|javascript|react|nextjs|next\.js/ },
    { project: /\brust\b/, repository: /\brust\b|tokio|serde/ },
    { project: /具身智能|机器人|robotics|embodied/, repository: /robot|robotics|embodied|ros/ },
    { project: /中文\s*nlp|自然语言|文本标注/, repository: /nlp|language|annotation|text/ },
  ];
  const activeGroups = technologyGroups.filter((group) => group.project.test(projectText));
  return activeGroups.some((group) => group.repository.test(repositoryText));
}

function hasCurrentGitHubProfileSignal(snippet: string, now = new Date()) {
  const timestamps = Array.from(
    snippet.matchAll(/(?:Recent public activity|Profile updated):\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/gi),
  )
    .map((match) => new Date(match[1]))
    .filter((date) => !Number.isNaN(date.getTime()));
  if (!timestamps.length) return false;

  const futureToleranceMs = 24 * 60 * 60 * 1000;
  const maxAgeMs = 3 * 365 * 24 * 60 * 60 * 1000;
  return timestamps.some((date) => {
    const ageMs = now.getTime() - date.getTime();
    return ageMs >= -futureToleranceMs && ageMs <= maxAgeMs;
  });
}

function extractGitHubEvidenceRepositories(snippet: string) {
  return Array.from(snippet.matchAll(/Repository evidence:\s*(?:owner of|\d+ contributions to)\s+([^\s(,.]+)/gi))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function hasAuthoritativeGitHubContributionEvidence(result: { url: string; snippet: string }) {
  return (
    isLikelyGitHubUserUrl(result.url) &&
    /Repository evidence:\s*(?:owner of|\d+ contributions to)\s+[^.]+/i.test(result.snippet)
  );
}

function extractGitHubRecentActivity(snippet: string) {
  const match = snippet.match(
    /(?:Recent public activity|Profile updated):\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i,
  );
  if (!match?.[1]) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function chooseLatestActivityDate(existing: Date | null, observed: string | null | undefined) {
  if (!observed) return existing;
  const observedDate = new Date(observed);
  if (Number.isNaN(observedDate.getTime())) return existing;
  if (!existing || observedDate.getTime() > existing.getTime()) return observedDate;
  return existing;
}

export function buildExternalCandidateReviewFields(candidate: {
  evidenceLevel: string;
  lastActiveAt?: string | null;
  risks: string[];
}) {
  const risks = Array.from(new Set(candidate.risks.map(normalizeExternalCandidateRisk).filter(Boolean)));
  if (!candidate.lastActiveAt && !risks.some((risk) => /近期活跃/.test(risk))) {
    risks.push("近期活跃度暂无可核验证据，需人工确认当前可参与状态。");
  }
  const missing = risks.filter((risk) => /缺少|暂无|未知|未确认|无法核验|无直接证据/.test(risk));
  const nextAction =
    evidenceLevelRank(candidate.evidenceLevel) >= 2
      ? "完成人工复核，核验项目硬条件、当前可参与性和触达许可后再推进。"
      : "先补齐可核验的公开证据，再完成人工复核并确认触达许可。";
  return { risks, missing, nextAction };
}

function normalizeExternalCandidateRisk(value: string) {
  const risk = value.trim();
  if (!risk) return "";
  if (/[\u3400-\u9fff]/.test(risk)) return risk;
  if (/region|timezone|time\s*zone|utc[+-]?\d/i.test(risk)) return "公开地区或时区与项目偏好可能不一致，需确认可协作时间。";
  if (/language|chinese|mandarin|english/i.test(risk)) return "中文能力暂无公开证据，需确认是否满足项目语言要求。";
  if (/over[- ]qualified|availability|cost|rate|budget/i.test(risk)) return "当前可参与时间和合作条件尚未确认。";
  if (/no direct evidence|missing evidence|code review|review experience/i.test(risk)) return "缺少企业级代码评审经历的直接证据。";
  if (/identity|same name|namesake/i.test(risk)) return "候选身份仍需人工核验，避免同名信息串联。";
  return "公开信息存在待确认项，需人工复核。";
}

function normalizeUrl(value: string) {
  return value.trim().replace(/\/$/, "").toLowerCase();
}

export function buildEvidenceDedupeKey(input: {
  candidateId: string;
  sourceUrl: string;
  sourceType: string;
  claim: string;
}) {
  const sourceKey = `${input.candidateId}|${normalizeUrl(input.sourceUrl)}|${input.sourceType}`;
  return input.sourceType === "github_api" ? sourceKey : `${sourceKey}|${input.claim.trim().toLowerCase()}`;
}

function evidenceLevelRank(level: string) {
  return ({ E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 } as Record<string, number>)[level.toUpperCase()] ?? 0;
}

function capPublicEvidenceLevel(level: string) {
  return evidenceLevelFromRank(Math.min(2, evidenceLevelRank(level)));
}

function evidenceLevelFromRank(rank: number): "E0" | "E1" | "E2" {
  if (rank >= 2) return "E2";
  if (rank >= 1) return "E1";
  return "E0";
}

function inferCandidateName(result: { title: string; snippet: string; domain?: string | null }) {
  const authorMatch = result.snippet.match(/Authors?:\s*([^.;]+)/i);
  if (authorMatch?.[1]) {
    return cleanCandidateName(authorMatch[1].split(";")[0].replace(/\([^)]*\)/g, ""));
  }
  const chineseProfileIntro = result.snippet.match(/(?:简介|作者|讲者|嘉宾|专家)[:：]\s*([\u4e00-\u9fff]{2,4})(?=[，,。；;\s])/);
  if (chineseProfileIntro?.[1]) return chineseProfileIntro[1];
  const chineseExpertList = result.title.match(/^([\u4e00-\u9fff]{2,4})(?:、|，|,).*(?:院士|教授|博士|专家|讲者|学者)/);
  if (chineseExpertList?.[1]) return chineseExpertList[1];
  const chineseNamedLead = result.title.match(/^([\u4e00-\u9fff]{2,4})(?=(?:院士|教授|博士|专家|讲者|学者|团队|首个|，|,|、))/);
  if (chineseNamedLead?.[1]) return chineseNamedLead[1];
  const githubTitle = result.title.replace(/\s+GitHub profile\b/i, "");
  return cleanCandidateName(githubTitle);
}

function isLikelyCandidateLead(result: { title: string; url: string; snippet: string; domain?: string | null }, name: string) {
  if (isLikelyGitHubUserUrl(result.url)) return true;
  if (isLinkedInUrl(result.url)) return isLikelyLinkedInProfileUrl(result.url);
  const profileText = `${result.title} ${result.snippet}`;
  const dedicatedProfileUrl = /\/(?:profile|profiles|people|person|member|staff|faculty|bio)(?:\/|[-_])/i.test(result.url);
  const titledProfile = /(?:^|[-|:：]\s*|\s)(?:expert\s+|professional\s+)?profile\s*$/i.test(result.title.trim());
  if (/github profile|linkedin profile|领英个人主页|个人主页|专家简介|homepage/i.test(profileText) || dedicatedProfileUrl || titledProfile) {
    return true;
  }
  if (/Authors?:/i.test(result.snippet)) return true;
  if (
    /^[\u4e00-\u9fff]{2,4}$/.test(name) &&
    !["漫画", "报告", "指南", "趋势", "研究"].includes(name) &&
    !/医院|大学|学院|研究|肿瘤|医学|中心|协会|团队|实验室/.test(name)
  ) {
    return true;
  }
  return false;
}

function isLinkedInUrl(value: string) {
  try {
    return /(^|\.)linkedin\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function isLikelyLinkedInProfileUrl(value: string) {
  try {
    const url = new URL(value);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return false;
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length >= 2 && ["in", "pub"].includes(segments[0].toLowerCase());
  } catch {
    return false;
  }
}

function isLikelyGitHubUserUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return false;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 1) return false;
    const reserved = new Set([
      "about",
      "apps",
      "collections",
      "customer-stories",
      "enterprise",
      "events",
      "explore",
      "features",
      "issues",
      "login",
      "marketplace",
      "new",
      "notifications",
      "orgs",
      "pricing",
      "pulls",
      "search",
      "settings",
      "sponsors",
      "topics",
    ]);
    return !reserved.has(segments[0].toLowerCase());
  } catch {
    return false;
  }
}

function cleanCandidateName(value: string) {
  return (
    value
      .split(/\s[-|–—]\s/)
      [0]?.replace(/\b(profile|homepage|official|GitHub|LinkedIn)\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "待复核公开线索"
  );
}

function inferCandidateTitle(result: { title: string; domain?: string | null }) {
  if (result.domain?.includes("github.com")) return "公开代码社区资料";
  if (result.domain?.includes("openalex.org") || result.title.toLowerCase().includes("doi")) return "论文/作者公开线索";
  return "公开来源待复核线索";
}

function inferAffiliation(result: { snippet: string; domain?: string | null }) {
  const institutionMatch = result.snippet.match(/\(([^)]+(?:University|Institute|Hospital|大学|医院|研究所)[^)]*)\)/i);
  if (institutionMatch?.[1]) return institutionMatch[1].trim();
  return result.domain ?? null;
}

type ProjectLike = {
  title?: string | null;
  rawDemand?: string | null;
  domain?: string | null;
  riskLevel?: string | null;
  quantity?: number | null;
  personaJson?: string | null;
};

type SearchResultLike = {
  title?: string | null;
  url?: string | null;
  snippet?: string | null;
  domain?: string | null;
  query?: string | null;
};

type CandidateLike = {
  humanReviewNeeded?: boolean | null;
  sourceType?: string | null;
  expert?: {
    evidenceLevel?: string | null;
    sourceUrl?: string | null;
  } | null;
  evidenceItems?: Array<{
    sourceType?: string | null;
    sourceUrl?: string | null;
    sourceTitle?: string | null;
    claim?: string | null;
    snippet?: string | null;
  }>;
};

export type ExternalResearchAcceptanceReport = {
  passed: boolean;
  queryCount: number;
  cached: number;
  uncached: number;
  sourceCoverage: string[];
  coverageLabels: string[];
  candidateSourceCoverage: string[];
  unmetSourceCoverage: string[];
  providerStats: Record<string, number>;
  resultCount: number;
  candidateCount: number;
  e2PlusCandidates: number;
  hardRequirementReadyCandidates: number;
  candidateHardRequirements: string[];
  reviewRequiredCandidates: number;
  outreachReadyCandidates: number;
  blockers: string[];
  needsReview: string[];
  nextActions: string[];
};

export function selectExternalResearchQueries({
  project,
  gapQueries,
  projectQueries,
  hardRequirementQueries = [],
  instructionQueries = [],
  directionQueries,
  maxQueries = 4,
}: {
  project: ProjectLike;
  gapQueries: string[];
  projectQueries: string[];
  hardRequirementQueries?: string[];
  instructionQueries?: string[];
  directionQueries: string[];
  maxQueries?: number;
}) {
  const selected: string[] = [];
  const covered = new Set<string>();
  const hardRequirementCandidates = preferConciseQueries(hardRequirementQueries);
  const projectCandidates = preferConciseQueries(projectQueries);
  const instructionCandidates = preferConciseQueries(instructionQueries);
  const supplementCandidates = preferConciseQueries([...directionQueries, ...gapQueries]).filter(
    (query) => !projectCandidates.length || !isNoisyPlaceholderQuery(query),
  );
  const allCandidates = preferConciseQueries([
    ...hardRequirementCandidates,
    ...instructionCandidates,
    ...projectCandidates,
    ...supplementCandidates,
  ]);
  const peopleCandidates = preferConciseQueries([
    ...allCandidates.filter(isPeopleDiscoveryQuery),
    ...buildPeopleDiscoverySupplements(projectCandidates, project),
  ]);
  const peopleQuota = Math.min(maxQueries, Math.ceil(maxQueries / 2));
  const projectQuota = projectCandidates.length ? Math.min(maxQueries, Math.max(2, Math.ceil(maxQueries / 2))) : 0;
  const hardRequirementQuota = Math.min(hardRequirementCandidates.length, maxQueries >= 3 ? 2 : 1);

  for (const requiredQuery of hardRequirementCandidates.slice(0, hardRequirementQuota)) {
    selected.push(requiredQuery);
    inferQueryCoverage(project, requiredQuery).forEach((item) => covered.add(item));
  }
  if (hardRequirementCandidates.length) {
    pickDiverseQueries({
      project,
      candidates: instructionCandidates,
      selected,
      covered,
      maxQueries,
      requireNewCoverage: true,
    });
  } else {
    for (const requiredQuery of instructionCandidates.slice(0, maxQueries)) {
      selected.push(requiredQuery);
      inferQueryCoverage(project, requiredQuery).forEach((item) => covered.add(item));
    }
  }
  const authoritativeProjectQuery = projectCandidates.find(isAuthoritativePeopleQuery);
  if (
    authoritativeProjectQuery &&
    selected.length < maxQueries &&
    !selected.includes(authoritativeProjectQuery) &&
    !selected.some(isAuthoritativePeopleQuery)
  ) {
    selected.push(authoritativeProjectQuery);
    inferQueryCoverage(project, authoritativeProjectQuery).forEach((item) => covered.add(item));
  }
  pickDiverseQueries({ project, candidates: peopleCandidates, selected, covered, maxQueries: peopleQuota });
  pickDiverseQueries({ project, candidates: projectCandidates, selected, covered, maxQueries: projectQuota });
  pickDiverseQueries({ project, candidates: allCandidates, selected, covered, maxQueries });

  return selected;
}

export function buildInstructionSourceQueries(searchBase: string, instruction: string) {
  const base = searchBase.replace(/\s+/g, " ").trim().slice(0, 64);
  if (!base || !instruction.trim()) return [];

  const queries: string[] = [];
  const geography = requestedGeography(`${base} ${instruction}`);
  const geographySuffix = geography.length ? ` ${geography.join(" ")}` : "";
  const mentionsGitHub = /github|开源社区/i.test(instruction);
  const wantsMaintainers =
    /maintainer|维护者|维护人|contributor|贡献者|贡献记录|提交记录|修复\s*PR|pull\s+request|repository\s+contribution/i.test(
      instruction,
    );
  const softwareExpertSearch =
    /python|fastapi|django|sqlalchemy|pydantic|kubernetes|cilium|hubble|typescript|react/i.test(base) &&
    /代码评审|代码审查|后端|开源|code\s*review|backend/i.test(base);
  if (mentionsGitHub && (wantsMaintainers || softwareExpertSearch)) {
    const frameworkNames = requestedGitHubTargets(`${base} ${instruction}`);
    const languagePrefix = /python/i.test(`${base} ${instruction}`) ? "Python " : "";
    if (frameworkNames.length) {
      frameworkNames.slice(0, 2).forEach((framework) => queries.push(`${languagePrefix}${framework} GitHub maintainer`));
    } else {
      queries.push(`${base} GitHub maintainer`);
    }
  }
  if (mentionsGitHub && !queries.length) queries.push(`${base} GitHub user`);
  if (/会议|讲者|演讲|speaker|嘉宾/i.test(instruction)) {
    const conferences = requestedConferences(instruction);
    if (conferences.length) {
      conferences.forEach((conference) => queries.push(`${base} ${conference} conference speaker${geographySuffix}`));
    } else {
      queries.push(`${base} conference speaker${geographySuffix}`);
    }
  }
  if (/论文|作者|author|scholar|orcid/i.test(instruction)) {
    const recency = /近\s*5\s*年|近五年|recent\s*5\s*years?/i.test(instruction) ? " recent 5 years" : "";
    queries.push(`${base}${recency} paper author${geographySuffix}`);
  }
  const requestsInstitutionProfile = /团队成员|机构成员|机构|团队主页|教师主页|医生简介|医院|大学|研究所/i.test(
    instruction,
  );
  if (requestsInstitutionProfile) {
    queries.push(`${base} institution team member profile${geographySuffix}`);
  }
  if (/linkedin|领英/i.test(instruction)) queries.push(`${base} LinkedIn profile`);
  const requestsPersonalProfile = /个人主页|专家主页|专家简介|个人简介|personal\s+(?:profile|homepage)|expert\s+profile/i.test(
    instruction,
  );
  const requestsGenericProfile = /公开主页|\bprofile\b|\bhomepage\b/i.test(instruction);
  if (requestsPersonalProfile || (!requestsInstitutionProfile && requestsGenericProfile)) {
    queries.push(`${base} expert profile`);
  }

  return uniqueNonEmpty(queries).slice(0, 4);
}

export function buildPersonaSourceQueries(project: Pick<ProjectLike, "domain" | "rawDemand" | "personaJson"> & { taskType?: string | null }) {
  let persona: { taskFitSignals?: unknown; evidenceRequirements?: unknown } = {};
  try {
    persona = JSON.parse(project.personaJson ?? "{}") as typeof persona;
  } catch {
    return [];
  }
  const sourceSignals = [persona.taskFitSignals, persona.evidenceRequirements]
    .flatMap((value) => (Array.isArray(value) ? value.map(String) : []))
    .filter(Boolean)
    .concat(extractPositiveSourceRequirements(project.rawDemand ?? ""))
    .join(" ");
  if (!sourceSignals) return [];
  const searchBase = buildPersonaSearchBase(project);
  return buildInstructionSourceQueries(searchBase, sourceSignals);
}

function extractPositiveSourceRequirements(rawDemand: string) {
  const sourceDirectionPattern =
    /github|gitlab|开源(?:维护|贡献)|论文|作者|会议|讲者|机构.{0,12}(?:主页|官网|成员|背景)|团队.{0,12}(?:主页|官网|成员)|个人主页|专家主页|公开主页|linkedin|领英|orcid|scholar|researchgate/i;
  const negatedRequirementPattern =
    /不要求|不需要|无需|不强制|不限定|不依赖|不要|可不提供|非必须|不是必须/i;

  return rawDemand
    .split(/[，,。；;！!？?\n]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause && sourceDirectionPattern.test(clause) && !negatedRequirementPattern.test(clause));
}

function buildPersonaSearchBase(project: Pick<ProjectLike, "domain" | "rawDemand"> & { taskType?: string | null }) {
  const text = [project.domain, project.taskType, project.rawDemand].filter(Boolean).join(" ");
  const technologies = [
    "Python",
    "FastAPI",
    "Django",
    "SQLAlchemy",
    "Pydantic",
    "SQLModel",
    "Kubernetes",
    "Cilium",
    "Hubble",
    "eBPF",
    "TypeScript",
    "React",
  ].filter((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text));
  const task = /代码评审|代码审查|code\s*review/i.test(text)
    ? "代码评审"
    : /数据标注|annotation|labeling/i.test(text)
      ? "数据标注"
      : project.taskType?.split(/[\/|｜]/)[0]?.trim() ?? "";
  const fallbackDomain = project.domain?.trim() && !/未分类|unknown|general/i.test(project.domain) ? project.domain.trim() : "";
  return Array.from(new Set([...(technologies.length ? technologies : [fallbackDomain]), task].filter(Boolean))).join(" ").slice(0, 56);
}

function requestedConferences(text: string) {
  return ["AACR", "ASCO", "ESMO", "ASH"].filter((conference) =>
    new RegExp(`\\b${conference}\\b`, "i").test(text),
  );
}

function requestedGeography(text: string) {
  const normalized = text.toLowerCase();
  const locations: string[] = [];
  const mappings: Array<[RegExp, string]> = [
    [/中国|\bchina\b/i, "China"],
    [/新加坡|\bsingapore\b/i, "Singapore"],
    [/香港|\bhong\s*kong\b/i, "Hong Kong"],
    [/台湾|\btaiwan\b/i, "Taiwan"],
    [/日本|\bjapan\b/i, "Japan"],
    [/韩国|\bsouth\s*korea\b|\bkorea\b/i, "South Korea"],
    [/美国|\bunited\s*states\b|\busa\b/i, "United States"],
    [/英国|\bunited\s*kingdom\b|\buk\b/i, "United Kingdom"],
  ];
  mappings.forEach(([pattern, label]) => {
    if (pattern.test(normalized) && !locations.includes(label)) locations.push(label);
  });
  return locations.slice(0, 3);
}

function requestedGitHubTargets(text: string) {
  const normalized = text.toLowerCase();
  const frameworks = ["FastAPI", "Django", "Flask"].filter((framework) =>
    normalized.includes(framework.toLowerCase()),
  );
  if (frameworks.length) return frameworks.slice(0, 2);

  const hasCilium = normalized.includes("cilium");
  const hasHubble = normalized.includes("hubble");
  if (hasCilium && hasHubble) return ["Cilium", "Cilium Hubble"];
  if (hasCilium) return ["Cilium"];
  if (hasHubble) return ["Hubble"];

  const namedProjects = ["Pydantic", "SQLModel"].filter((project) => normalized.includes(project.toLowerCase()));
  return namedProjects.slice(0, 2);
}

function isPeopleDiscoveryQuery(query: string) {
  return /个人主页|专家主页|专家简介|讲者|嘉宾|作者|团队成员|教师主页|医生简介|profile|speaker|author|maintainer|contributor|github\s+user|linkedin|scholar|orcid/i.test(
    query,
  );
}

function isAuthoritativePeopleQuery(query: string) {
  return /github/i.test(query) && /maintainer|contributor|维护者|维护人|贡献者/i.test(query);
}

function buildPeopleDiscoverySupplements(projectQueries: string[], project: ProjectLike) {
  const nonPeopleProjectQueries = projectQueries.filter((query) => !isPeopleDiscoveryQuery(query));
  const bases = nonPeopleProjectQueries.length
    ? nonPeopleProjectQueries
    : [project.rawDemand ?? "", project.domain ?? "", project.title ?? ""];
  const conciseBases = bases.map(toPeopleQueryBase).filter(Boolean);
  if (!conciseBases.length) return [];
  return [
    `${conciseBases[0]} 个人主页`,
    `${conciseBases[1] ?? conciseBases[0]} 会议 讲者`,
  ];
}

function toPeopleQueryBase(value: string) {
  return value
    .replace(/[“”"]/g, "")
    .replace(/[，,。；;：:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 56);
}

function preferConciseQueries(queries: string[]) {
  const unique = uniqueNonEmpty(queries);
  const meaningful = unique.filter((query) => !isNoisyPlaceholderQuery(query));
  const base = meaningful.length ? meaningful : unique;
  const concise = base.filter((query) => query.length <= 80);
  return concise.length >= Math.min(base.length, 2) ? concise : base;
}

function isNoisyPlaceholderQuery(query: string) {
  return /未分类领域|未分类|unknown|general|n\/a/i.test(query);
}

function pickDiverseQueries({
  project,
  candidates,
  selected,
  covered,
  maxQueries,
  requireNewCoverage = false,
}: {
  project: ProjectLike;
  candidates: string[];
  selected: string[];
  covered: Set<string>;
  maxQueries: number;
  requireNewCoverage?: boolean;
}) {
  while (selected.length < maxQueries) {
    const best = candidates
      .filter((query) => !selected.includes(query))
      .map((query) => {
        const coverage = inferQueryCoverage(project, query);
        const newCoverage = coverage.filter((item) => !covered.has(item)).length;
        return { query, coverage, newCoverage };
      })
      .filter((candidate) => !requireNewCoverage || candidate.newCoverage > 0)
      .sort((a, b) => b.newCoverage - a.newCoverage || a.query.length - b.query.length)[0];
    if (!best) break;
    selected.push(best.query);
    best.coverage.forEach((item) => covered.add(item));
  }
}

export function buildExternalResearchAcceptancePreview({
  project,
  queries,
  cachedQueries,
}: {
  project: ProjectLike;
  queries: string[];
  cachedQueries: string[];
}) {
  const uniqueQueries = uniqueNonEmpty(queries);
  const cached = uniqueQueries.filter((query) => cachedQueries.includes(query)).length;
  const sourceCoverage = inferSourceCoverage({ project, queries: uniqueQueries, searchResults: [] });
  const coverageLabels = sourceCoverage.map(formatCoverageLabel);
  const isRegulated = isRegulatedProject(project);

  return {
    queryCount: uniqueQueries.length,
    cached,
    uncached: Math.max(0, uniqueQueries.length - cached),
    queryPreview: uniqueQueries,
    sourceCoverage,
    coverageLabels,
    acceptanceChecks: [
      "来源覆盖不少于 3 类。",
      "公开候选需有可追溯证据。",
      "E2+ 候选优先进入复核与排序。",
      "低证据候选不得直接触达。",
    ],
    needsReview: [
      "确认后会优先复用已保存结果；未保存的查询会调用外部搜索服务。",
      ...(isRegulated ? ["高风险项目下，公开候选需完成资质与触达许可复核。"] : []),
    ],
  };
}

export function evaluateExternalResearchAcceptance({
  project,
  queries,
  cacheHits,
  providerStats,
  searchResults,
  candidates,
}: {
  project: ProjectLike;
  queries: string[];
  cacheHits: string[];
  providerStats: Record<string, number>;
  searchResults: SearchResultLike[];
  candidates: CandidateLike[];
}): ExternalResearchAcceptanceReport {
  const uniqueQueries = uniqueNonEmpty(queries);
  const sourceCoverage = inferSourceCoverage({ project, queries: uniqueQueries, searchResults });
  const coverageLabels = sourceCoverage.map(formatCoverageLabel);
  const sourceYield = evaluateCandidateSourceYield({ queries: uniqueQueries, searchResults, candidates });
  const e2PlusCandidates = candidates.filter((candidate) => evidenceRank(candidate.expert?.evidenceLevel) >= 2).length;
  const hardRequirements = inferCandidateHardRequirements(project);
  const hardRequirementReadyCandidates = candidates.filter(
    (candidate) =>
      evidenceRank(candidate.expert?.evidenceLevel) >= 2 &&
      hardRequirements.every((requirement) => candidateHasHardRequirementEvidence(candidate, requirement)),
  ).length;
  const reviewRequiredCandidates = candidates.filter((candidate) => candidate.humanReviewNeeded).length;
  const regulated = isRegulatedProject(project);
  const outreachReadyCandidates = regulated
    ? 0
    : candidates.filter((candidate) => evidenceRank(candidate.expert?.evidenceLevel) >= 2 && !candidate.humanReviewNeeded).length;
  const blockers: string[] = [];
  const minimumEvidenceCandidates = expectedEvidenceCandidateCount(project);

  if (uniqueQueries.length < 2) blockers.push("查询数量不足。");
  if (sourceCoverage.length < 3) blockers.push("查询方向覆盖不足。");
  if (searchResults.length < 3) blockers.push("有效搜索结果不足。");
  if (candidates.length === 0) blockers.push("未抽取到可复核候选。");
  if (e2PlusCandidates < minimumEvidenceCandidates) blockers.push("高证据候选不足。");
  if (hardRequirements.length && hardRequirementReadyCandidates < minimumEvidenceCandidates) {
    blockers.push(`没有候选同时满足高证据和${hardRequirements.map(formatCandidateHardRequirement).join("、")}硬条件。`);
  }
  if (!Object.keys(providerStats).length) blockers.push("来源服务结果缺失。");

  const needsReview = [
    ...(reviewRequiredCandidates > 0 ? [`${reviewRequiredCandidates} 位候选需要人工复核。`] : []),
    ...(regulated ? ["高风险项目下，公开候选需完成资质与触达许可复核。"] : []),
    ...(cacheHits.length ? [`${cacheHits.length} 条查询复用了已保存结果。`] : []),
    ...sourceYield.unmet.map(sourceYieldBlocker),
  ];

  const nextActions = nextActionsForExternalResearch(
    blockers,
    regulated,
    e2PlusCandidates,
    outreachReadyCandidates,
    reviewRequiredCandidates,
  );
  if (sourceYield.unmet.length) {
    nextActions.unshift("调整未产出候选的来源搜索词，优先定位个人主页、讲者页或作者页。");
  }

  return {
    passed: blockers.length === 0,
    queryCount: uniqueQueries.length,
    cached: cacheHits.length,
    uncached: Math.max(0, uniqueQueries.length - cacheHits.length),
    sourceCoverage,
    coverageLabels,
    candidateSourceCoverage: sourceYield.covered,
    unmetSourceCoverage: sourceYield.unmet,
    providerStats,
    resultCount: searchResults.length,
    candidateCount: candidates.length,
    e2PlusCandidates,
    hardRequirementReadyCandidates,
    candidateHardRequirements: hardRequirements.map(formatCandidateHardRequirement),
    reviewRequiredCandidates,
    outreachReadyCandidates,
    blockers: unique(blockers),
    needsReview: unique(needsReview),
    nextActions: unique(nextActions),
  };
}

type CandidateHardRequirement =
  | "institution_profile"
  | "code_review_evidence"
  | "github_contribution"
  | "experience_duration";

function inferCandidateHardRequirements(project: ProjectLike): CandidateHardRequirement[] {
  const text = project.rawDemand ?? "";
  const persona = parsePersona(project.personaJson);
  const mustHaveText = persona.mustHave.join(" ");
  const evidenceText = persona.evidenceRequirements.join(" ");
  const allRequirements = `${text} ${mustHaveText} ${evidenceText}`;
  const requirements: CandidateHardRequirement[] = [];
  const requiresInstitutionProfile =
    /(?:所有|全部|每(?:一)?位)?候选.{0,20}(?:必须|需要|应当).{0,36}(?:大学|医院|研究机构|研究所|机构|团队).{0,18}(?:主页|官网|页面)/i.test(
      text,
    ) ||
    /(?:必须|需要|应当)有.{0,36}(?:大学|医院|研究机构|研究所|机构|团队).{0,18}(?:主页|官网|页面)/i.test(text);
  if (requiresInstitutionProfile) requirements.push("institution_profile");
  if (/代码评审|代码审查|code\s+review|pull\s+request\s+review/i.test(mustHaveText)) {
    requirements.push("code_review_evidence");
  }
  if (/github/i.test(evidenceText) && /贡献|pull\s+request|\bpr\b|commit|maintain/i.test(evidenceText)) {
    requirements.push("github_contribution");
  }
  if (/(?:\d+|一|二|三|四|五|六|七|八|九|十)\s*年(?:以上|及以上)?[^。；,]{0,20}经验|\d+\+?\s*years?[^.;,]{0,20}experience/i.test(allRequirements)) {
    requirements.push("experience_duration");
  }
  return unique(requirements);
}

function candidateHasHardRequirementEvidence(candidate: CandidateLike, requirement: CandidateHardRequirement) {
  const evidenceItems = candidate.evidenceItems ?? [];
  if (requirement === "institution_profile") {
    return evidenceItems.some((evidence) => {
      const text = `${evidence.sourceType ?? ""} ${evidence.sourceUrl ?? ""} ${evidence.sourceTitle ?? ""} ${evidence.claim ?? ""}`;
      return /institution_profile|机构公开人员页面|机构主页|团队主页/i.test(text);
    });
  }
  const evidenceText = evidenceItems
    .map((evidence) =>
      `${evidence.sourceType ?? ""} ${evidence.sourceUrl ?? ""} ${evidence.sourceTitle ?? ""} ${evidence.claim ?? ""} ${evidence.snippet ?? ""}`,
    )
    .join(" ");
  if (requirement === "code_review_evidence") {
    return /代码评审|代码审查|code\s+review|reviewed?\s+(?:pull\s+requests?|prs?)|pull\s+request\s+review/i.test(evidenceText);
  }
  if (requirement === "github_contribution") {
    return /github_api/i.test(evidenceText) && /repository evidence|contributions?\s+to|owner\s+of|贡献|pull\s+request|\bpr\b/i.test(evidenceText);
  }
  if (requirement === "experience_duration") {
    return /(?:\d+|一|二|三|四|五|六|七|八|九|十)\s*年(?:以上|及以上)?[^。；,]{0,20}经验|\d+\+?\s*years?[^.;,]{0,20}experience/i.test(evidenceText);
  }
  return false;
}

function parsePersona(value?: string | null) {
  try {
    const parsed = JSON.parse(value ?? "{}") as { mustHave?: unknown; evidenceRequirements?: unknown };
    return {
      mustHave: Array.isArray(parsed.mustHave) ? parsed.mustHave.map(String) : [],
      evidenceRequirements: Array.isArray(parsed.evidenceRequirements) ? parsed.evidenceRequirements.map(String) : [],
    };
  } catch {
    return { mustHave: [] as string[], evidenceRequirements: [] as string[] };
  }
}

function formatCandidateHardRequirement(requirement: CandidateHardRequirement) {
  const labels: Record<CandidateHardRequirement, string> = {
    institution_profile: "机构公开主页",
    code_review_evidence: "代码评审经历",
    github_contribution: "GitHub 实质贡献",
    experience_duration: "可核验的经验年限",
  };
  return labels[requirement];
}

function evaluateCandidateSourceYield({
  queries,
  searchResults,
  candidates,
}: {
  queries: string[];
  searchResults: SearchResultLike[];
  candidates: CandidateLike[];
}) {
  const requested = unique(queries.flatMap(inferExplicitSourceCategories));
  const candidateUrls = candidates.map((candidate) => normalizeUrl(candidate.expert?.sourceUrl)).filter(Boolean);
  if (!candidates.length || candidateUrls.length !== candidates.length) {
    return { covered: [] as string[], unmet: [] as string[] };
  }

  const resultByUrl = new Map(
    searchResults
      .map((result) => [normalizeUrl(result.url), result] as const)
      .filter(([url]) => Boolean(url)),
  );
  const covered = unique(
    candidateUrls.flatMap((url) => {
      const result = resultByUrl.get(url);
      if (!result) return [];
      const actualCategories = inferActualSourceCategories(result);
      const categories = actualCategories.length ? actualCategories : inferExplicitSourceCategories(result.query ?? "");
      return categories.filter((category) => requested.includes(category));
    }),
  );
  return {
    covered,
    unmet: requested.filter((source) => !covered.includes(source)),
  };
}

function inferActualSourceCategories(result: SearchResultLike) {
  const text = `${result.title ?? ""} ${result.url ?? ""} ${result.domain ?? ""} ${result.snippet ?? ""}`.toLowerCase();
  const categories: string[] = [];
  addIf(categories, "community", /github\.com|gitlab\.com|maintainer|contributor|开源贡献/.test(text));
  addIf(
    categories,
    "publication",
    /openalex\.org|doi\.org|pubmed|authors?:\s|publication|journal|论文作者|期刊/.test(text),
  );
  addIf(
    categories,
    "conference",
    /conference|meeting|symposium|summit|workshop|speaker|agenda|会议|讲者|嘉宾|论坛|研讨会|峰会|日程/.test(text),
  );
  const isInstitutionHost = /(?:\.edu(?:\.|\/)|\.ac\.|hospital|university|institute|研究所|医院|大学|高校)/.test(text);
  addIf(categories, "institution", isInstitutionHost && !categories.includes("conference") && !categories.includes("publication"));
  addIf(categories, "professional_profile", /linkedin\.com\/in\/|profile|homepage|个人主页|专家主页|bio[-_/]/.test(text));
  return categories;
}

function inferExplicitSourceCategories(query: string) {
  const text = query.toLowerCase();
  const categories: string[] = [];
  addIf(categories, "community", /github|maintainer|contributor|开源|社区/.test(text));
  addIf(categories, "conference", /conference|speaker|会议|讲者|嘉宾|演讲/.test(text));
  addIf(categories, "publication", /paper|publication|author|scholar|orcid|pubmed|openalex|doi|论文|作者|期刊/.test(text));
  addIf(categories, "institution", /institution|team member|hospital|university|institute|机构|团队成员|医院|大学|研究所/.test(text));
  addIf(
    categories,
    "professional_profile",
    /linkedin|领英/.test(text) ||
      (categories.length === 0 && /profile|homepage|个人主页|专家主页|公开主页/.test(text)),
  );
  return categories;
}

function sourceYieldBlocker(source: string) {
  const messages: Record<string, string> = {
    conference: "会议讲者方向未产出可复核候选。",
    publication: "论文作者方向未产出可复核候选。",
    community: "开源社区方向未产出可复核候选。",
    institution: "机构主页方向未产出可复核候选。",
    professional_profile: "专家主页方向未产出可复核候选。",
  };
  return messages[source] ?? "部分搜索方向未产出可复核候选。";
}

function normalizeUrl(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\/$/, "").toLowerCase() : "";
}

function inferSourceCoverage({
  queries,
}: {
  project: ProjectLike;
  queries: string[];
  searchResults: SearchResultLike[];
}) {
  return unique(queries.flatMap(inferExplicitSourceCategories));
}

function inferQueryCoverage(project: ProjectLike, query: string) {
  const coverage = inferExplicitSourceCategories(query);
  addIf(
    coverage,
    "localized",
    /[\u4e00-\u9fff]|china|中国|北京|上海|深圳|remote|中文|english/.test(
      `${project.domain ?? ""} ${query}`.toLowerCase(),
    ),
  );
  return coverage;
}

function addIf(items: string[], value: string, condition: boolean) {
  if (condition && !items.includes(value)) items.push(value);
}

function formatCoverageLabel(value: string) {
  const labels: Record<string, string> = {
    institution: "机构主页",
    academic: "会议与演讲",
    conference: "会议与演讲",
    publication: "论文作者",
    community: "开源社区",
    professional_profile: "专家主页",
    localized: "地区/语言",
  };
  return labels[value] ?? value;
}

function isRegulatedProject(project: ProjectLike) {
  const text = `${project.riskLevel ?? ""} ${project.domain ?? ""} ${project.rawDemand ?? ""}`.toLowerCase();
  return /high|critical|medical|medicine|clinical|legal|finance|insurance|医疗|医学|医生|法律|金融|保险/.test(text);
}

function evidenceRank(level: unknown) {
  const ranks: Record<string, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };
  return ranks[String(level ?? "E0").toUpperCase()] ?? 0;
}

function expectedEvidenceCandidateCount(project: ProjectLike) {
  const quantity = typeof project.quantity === "number" ? project.quantity : 0;
  return quantity >= 20 ? 2 : 1;
}

function nextActionsForExternalResearch(
  blockers: string[],
  regulated: boolean,
  e2PlusCandidates: number,
  outreachReadyCandidates: number,
  reviewRequiredCandidates: number,
) {
  if (blockers.length) {
    const actions = ["补充机构主页、论文/会议、专业社区等搜索方向后重试。"];
    if (blockers.some((blocker) => blocker.includes("同时满足高证据和"))) {
      actions.unshift("为同一候选补齐机构主页与论文、会议等证据，并完成人工同人核验。");
    }
    if (blockers.some((blocker) => blocker.includes("未产出可复核候选"))) {
      actions.unshift("调整未产出候选的来源搜索词，优先定位个人主页、讲者页或作者页。");
    }
    if (blockers.includes("高证据候选不足。")) actions.push("优先补齐候选的公开主页、论文、项目经历或资质证据。");
    if (blockers.includes("有效搜索结果不足。")) actions.push("放宽关键词或增加中英文/地区化查询。");
    return actions;
  }
  const nextActions = [
    e2PlusCandidates > 0 ? "优先复核 E2+ 候选，并更新候选排序。" : "先复核候选证据，再决定是否继续深搜。",
  ];
  if (regulated) nextActions.push("完成资质与触达许可复核后再进入候选推进。");
  else if (outreachReadyCandidates > 0) nextActions.push("把可触达候选推进到触达草稿或试标准备。");
  else if (reviewRequiredCandidates > 0) nextActions.push("完成候选复核和联系许可确认后，再准备触达草稿。");
  else nextActions.push("确认合规联系路径后，再准备触达草稿或试标。");
  return nextActions;
}

function uniqueNonEmpty(values: string[]) {
  return unique(values.map((value) => value.trim()).filter(Boolean));
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

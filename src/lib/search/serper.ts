import { extractHostname } from "@/lib/json";
import { searchResultSchema } from "@/lib/schemas";

export type NormalizedSearchResult = {
  title: string;
  url: string;
  snippet: string;
  domain: string | null;
  position: number | null;
};

export type SearchProviderResult = {
  provider: "cache" | "serper" | "openalex" | "github" | "none";
  cacheHit: boolean;
  results: NormalizedSearchResult[];
  error?: string;
};

export class MissingSerperKeyError extends Error {
  constructor() {
    super("SERPER_API_KEY is not configured.");
    this.name = "MissingSerperKeyError";
  }
}

type SerperOrganicResult = {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
};

type OpenAlexWork = {
  id?: string;
  doi?: string | null;
  display_name?: string;
  publication_year?: number;
  primary_location?: {
    source?: {
      display_name?: string;
    } | null;
  } | null;
  authorships?: Array<{
    author?: {
      display_name?: string;
    } | null;
    institutions?: Array<{
      display_name?: string;
    }>;
  }>;
};

type GitHubUserSearchItem = {
  login?: string;
  html_url?: string;
  url?: string;
};

type GitHubUserDetail = {
  login?: string;
  name?: string | null;
  html_url?: string;
  bio?: string | null;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  public_repos?: number;
  updated_at?: string | null;
  recentActivityAt?: string | null;
  maintainerEvidence?: string[];
};

type GitHubPublicEvent = {
  created_at?: string | null;
};

type GitHubRepositorySearchItem = {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  language?: string | null;
  topics?: string[];
  contributors_url?: string;
  owner?: {
    login?: string;
    html_url?: string;
    url?: string;
    type?: string;
  };
};

type GitHubContributor = {
  login?: string;
  html_url?: string;
  url?: string;
  type?: string;
  contributions?: number;
};

type GitHubIssueSearchResponse = {
  total_count?: number;
  items?: Array<{
    html_url?: string;
  }>;
};

type GitHubPersonEvidence = {
  login: string;
  htmlUrl: string;
  detailUrl?: string;
  evidence: string[];
  repositories: string[];
};

export async function searchSerper(query: string): Promise<NormalizedSearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    throw new MissingSerperKeyError();
  }

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      num: 8,
    }),
  });

  if (!response.ok) {
    throw new Error(`Serper request failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as { organic?: SerperOrganicResult[] };
  return normalizeSerperResults(body.organic ?? []);
}

export async function searchOpenAlex(query: string): Promise<NormalizedSearchResult[]> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", openAlexSearchText(query));
  url.searchParams.set("per-page", "8");
  const filters = openAlexFilters(query);
  if (filters.length) url.searchParams.set("filter", filters.join(","));

  const response = await fetch(url, {
    headers: {
      "User-Agent": "expert-recruiter-mvp/0.1 (local)",
    },
  });
  if (!response.ok) {
    throw new Error(`OpenAlex request failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as { results?: OpenAlexWork[] };
  return normalizeOpenAlexResults(body.results ?? []);
}

function openAlexSearchText(query: string) {
  const stripped = query
    .replace(/\b(?:recent\s*5\s*years?|paper\s*author|publication\s*author)\b/gi, " ")
    .replace(/(?:论文作者|论文|作者)/g, " ")
    .replace(/\b(?:China|Singapore|Hong\s*Kong|Taiwan|Japan|South\s*Korea|United\s*States|United\s*Kingdom)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const translatedConcepts: string[] = [];
  if (/单细胞|single[-\s]?cell/i.test(stripped)) translatedConcepts.push("single-cell RNA sequencing");
  if (/(?:肿瘤.*免疫|免疫.*肿瘤)|tumou?r immun|cancer immun/i.test(stripped)) {
    translatedConcepts.push("tumor immunology");
  } else {
    if (/肿瘤|癌症|tumou?r|cancer/i.test(stripped)) translatedConcepts.push("tumor cancer");
    if (/免疫|immun/i.test(stripped)) translatedConcepts.push("immunology");
  }
  if (/肺结节|lung nodule/i.test(stripped)) translatedConcepts.push("lung nodule");
  if (/放射|影像|radiolog|medical imaging/i.test(stripped)) translatedConcepts.push("radiology medical imaging");
  if (/病理|patholog/i.test(stripped)) translatedConcepts.push("pathology");

  const asciiTerms = stripped
    .replace(/[\u3400-\u9fff]+/g, " ")
    .replace(/[^a-zA-Z0-9+.#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(new Set([...translatedConcepts, asciiTerms].filter(Boolean))).join(" ") || stripped;
}

function openAlexFilters(query: string) {
  const filters: string[] = [];
  if (/recent\s*5\s*years?|近\s*5\s*年|近五年/i.test(query)) {
    filters.push(`from_publication_date:${new Date().getUTCFullYear() - 5}-01-01`);
  }
  const countries: string[] = [];
  if (/\bChina\b|中国/i.test(query)) countries.push("CN");
  if (/\bSingapore\b|新加坡/i.test(query)) countries.push("SG");
  if (/\bHong\s*Kong\b|香港/i.test(query)) countries.push("HK");
  if (/\bTaiwan\b|台湾/i.test(query)) countries.push("TW");
  if (countries.length) filters.push(`authorships.institutions.country_code:${countries.join("|")}`);
  return filters;
}

export async function searchGitHubMaintainers(query: string): Promise<NormalizedSearchResult[]> {
  const searchUrl = new URL("https://api.github.com/search/repositories");
  const repositoryQuery = buildGitHubRepositoryQuery(query);
  if (!repositoryQuery) return [];
  searchUrl.searchParams.set("q", repositoryQuery);
  searchUrl.searchParams.set("sort", "stars");
  searchUrl.searchParams.set("order", "desc");
  searchUrl.searchParams.set("per_page", "3");

  const response = await fetch(searchUrl, { headers: githubHeaders() });
  if (!response.ok) throw new Error(`GitHub repository search failed with HTTP ${response.status}.`);
  const body = (await response.json()) as { items?: GitHubRepositorySearchItem[] };
  const people = new Map<string, GitHubPersonEvidence>();

  for (const repository of (body.items ?? []).filter((item) => isGitHubRepositoryRelevant(item, query)).slice(0, 3)) {
    const repositoryName = repository.full_name?.trim();
    if (!repositoryName) continue;
    const stars = typeof repository.stargazers_count === "number" ? repository.stargazers_count : 0;

    if (repository.owner?.type === "User" && repository.owner.login && repository.owner.html_url) {
      addGitHubPersonSignal(people, {
        login: repository.owner.login,
        htmlUrl: repository.owner.html_url,
        detailUrl: repository.owner.url,
        evidence: `Repository evidence: owner of ${repositoryName} (${stars} stars).`,
        repository: repositoryName,
      });
    }

    if (!repository.contributors_url) continue;
    const contributorUrl = new URL(repository.contributors_url);
    contributorUrl.searchParams.set("per_page", "3");
    contributorUrl.searchParams.set("anon", "0");
    const contributorResponse = await fetch(contributorUrl, { headers: githubHeaders() });
    if (!contributorResponse.ok) continue;
    const contributors = (await contributorResponse.json()) as GitHubContributor[];
    for (const contributor of contributors) {
      if (contributor.type !== "User" || !contributor.login || !contributor.html_url) continue;
      const contributions = typeof contributor.contributions === "number" ? contributor.contributions : 0;
      addGitHubPersonSignal(people, {
        login: contributor.login,
        htmlUrl: contributor.html_url,
        detailUrl: contributor.url,
        evidence: `Repository evidence: ${contributions} contributions to ${repositoryName} (${stars} stars).`,
        repository: repositoryName,
      });
    }
  }

  const selectedPeople = Array.from(people.values()).slice(0, 6);
  await enrichGitHubReviewEvidence(selectedPeople);

  const details = await Promise.all(
    selectedPeople.map(async (person): Promise<GitHubUserDetail> => {
        const recentActivityAt = await fetchGitHubRecentActivity(person.login);
        if (!person.detailUrl) {
          return {
            login: person.login,
            name: person.login,
            html_url: person.htmlUrl,
            recentActivityAt,
            maintainerEvidence: person.evidence,
          };
        }
        const detailResponse = await fetch(person.detailUrl, { headers: githubHeaders() });
        if (!detailResponse.ok) {
          return {
            login: person.login,
            name: person.login,
            html_url: person.htmlUrl,
            recentActivityAt,
            maintainerEvidence: person.evidence,
          };
        }
        const detail = (await detailResponse.json()) as GitHubUserDetail;
        return {
          ...detail,
          login: detail.login || person.login,
          html_url: detail.html_url || person.htmlUrl,
          recentActivityAt,
          maintainerEvidence: person.evidence,
        };
    }),
  );

  return normalizeGitHubUserResults(details);
}

async function fetchGitHubRecentActivity(login: string) {
  try {
    const url = new URL(`https://api.github.com/users/${encodeURIComponent(login)}/events/public`);
    url.searchParams.set("per_page", "1");
    const response = await fetch(url, { headers: githubHeaders() });
    if (!response.ok) return null;
    const events = (await response.json()) as GitHubPublicEvent[];
    const createdAt = events[0]?.created_at?.trim();
    return createdAt && Number.isFinite(Date.parse(createdAt)) ? createdAt : null;
  } catch {
    return null;
  }
}

export function buildGitHubRepositoryQuery(query: string) {
  const normalized = query.toLowerCase();
  if (normalized.includes("pydantic")) return "pydantic in:name,description stars:>20";
  if (normalized.includes("sqlmodel")) return "sqlmodel in:name,description stars:>10";
  if (normalized.includes("fastapi")) return "fastapi language:python stars:>50";
  if (normalized.includes("django")) return "django language:python stars:>100";
  if (normalized.includes("flask")) return "flask language:python stars:>100";
  if (normalized.includes("rust")) return "rust stars:>200";
  if (normalized.includes("typescript")) return "typescript stars:>200";
  if (normalized.includes("python")) return "python backend language:python stars:>200";
  const terms = extractGitHubRepositoryTerms(query);
  if (!terms.length) return "";
  return `${terms.slice(0, 2).join(" ")} in:name,description stars:>10`;
}

export function isGitHubRepositoryRelevant(
  repository: Pick<GitHubRepositorySearchItem, "full_name" | "description" | "language" | "topics">,
  query: string,
) {
  const normalizedQuery = query.toLowerCase();
  const technologies = [
    "pydantic-core",
    "pydantic",
    "sqlmodel",
    "fastapi",
    "django",
    "flask",
    "cilium",
    "hubble",
    "ebpf",
    "kubernetes",
    "rust",
    "typescript",
    "react",
    "python",
  ].filter((term) => normalizedQuery.includes(term));
  if (!technologies.length) return false;
  const specificTechnologies = technologies.filter((term) => term !== "python");
  const required = specificTechnologies.length ? specificTechnologies : technologies;
  const maintainerIntent = /maintainer|维护者|维护人/i.test(query);
  const namedProjects = required.filter((term) =>
    ["pydantic-core", "pydantic", "sqlmodel", "fastapi", "django", "flask", "cilium", "hubble"].includes(term),
  );
  const corpusFields = maintainerIntent && namedProjects.length
    ? [repository.full_name]
    : maintainerIntent
      ? [repository.full_name, repository.description]
      : [repository.full_name, repository.description, repository.language, ...(repository.topics ?? [])];
  const corpus = corpusFields
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (namedProjects.length) return namedProjects.some((term) => corpus.includes(term));
  const strongDomainTerms = required.filter((term) => ["ebpf", "kubernetes"].includes(term));
  if (strongDomainTerms.length > 1) return strongDomainTerms.every((term) => corpus.includes(term));
  return required.some((term) => corpus.includes(term));
}

function extractGitHubRepositoryTerms(query: string) {
  const normalized = query.toLowerCase();
  const orderedTerms = [
    "cilium",
    "hubble",
    "ebpf",
    "kubernetes",
    "pydantic-core",
    "pydantic",
    "sqlmodel",
    "fastapi",
    "django",
    "flask",
    "rust",
    "typescript",
    "react",
    "python",
  ];
  return orderedTerms.filter((term) => normalized.includes(term));
}

function addGitHubPersonSignal(
  people: Map<string, GitHubPersonEvidence>,
  signal: { login: string; htmlUrl: string; detailUrl?: string; evidence: string; repository: string },
) {
  const key = signal.login.toLowerCase();
  const existing = people.get(key);
  if (existing) {
    if (!existing.evidence.includes(signal.evidence)) existing.evidence.push(signal.evidence);
    if (!existing.repositories.includes(signal.repository)) existing.repositories.push(signal.repository);
    return;
  }
  people.set(key, {
    login: signal.login,
    htmlUrl: signal.htmlUrl,
    detailUrl: signal.detailUrl,
    evidence: [signal.evidence],
    repositories: [signal.repository],
  });
}

async function enrichGitHubReviewEvidence(people: GitHubPersonEvidence[]) {
  const targets = people
    .flatMap((person) => person.repositories.map((repository) => ({ person, repository })))
    .slice(0, 3);

  for (const { person, repository } of targets) {
    const evidence = await fetchGitHubReviewEvidence(person.login, repository);
    if (evidence && !person.evidence.includes(evidence)) person.evidence.push(evidence);
  }
}

async function fetchGitHubReviewEvidence(login: string, repository: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(login) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    return null;
  }

  try {
    const url = new URL("https://api.github.com/search/issues");
    url.searchParams.set("q", `repo:${repository} is:pr reviewed-by:${login}`);
    url.searchParams.set("sort", "updated");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", "1");
    const response = await fetch(url, { headers: githubHeaders() });
    if (!response.ok) return null;
    const body = (await response.json()) as GitHubIssueSearchResponse;
    const total = typeof body.total_count === "number" ? Math.max(0, Math.floor(body.total_count)) : 0;
    const exampleUrl = body.items?.[0]?.html_url?.trim() ?? "";
    if (total < 1 || !isRepositoryPullRequestUrl(exampleUrl, repository)) return null;
    return `Code review evidence: reviewed ${total} pull requests in ${repository}. Example review: ${exampleUrl}.`;
  } catch {
    return null;
  }
}

function isRepositoryPullRequestUrl(value: string, repository: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/pull/`)
    );
  } catch {
    return false;
  }
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "expert-recruiter-mvp/0.1",
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  };
}

export async function searchGitHubUsers(query: string): Promise<NormalizedSearchResult[]> {
  const searchUrl = new URL("https://api.github.com/search/users");
  searchUrl.searchParams.set("q", `${query} type:user`);
  searchUrl.searchParams.set("per_page", "6");

  const response = await fetch(searchUrl, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`GitHub user search failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as { items?: GitHubUserSearchItem[] };
  const items = body.items ?? [];
  const details: GitHubUserDetail[] = [];

  for (const item of items) {
    if (!item.url) continue;
    const detailResponse = await fetch(item.url, { headers: githubHeaders() });
    if (!detailResponse.ok) continue;
    details.push((await detailResponse.json()) as GitHubUserDetail);
  }

  return normalizeGitHubUserResults(details.length ? details : items);
}

export function normalizeSerperResults(results: SerperOrganicResult[]): NormalizedSearchResult[] {
  return results
    .map((result, index) => ({
      title: result.title ?? "",
      url: result.link ?? "",
      snippet: result.snippet ?? "",
      position: result.position ?? index + 1,
    }))
    .filter((result) => searchResultSchema.safeParse(result).success)
    .map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      domain: extractHostname(result.url),
      position: result.position ?? null,
    }));
}

export function normalizeOpenAlexResults(results: OpenAlexWork[]): NormalizedSearchResult[] {
  return results
    .map((work, index) => {
      const authorSummary = (work.authorships ?? [])
        .slice(0, 4)
        .map((authorship) => {
          const name = authorship.author?.display_name;
          const institution = authorship.institutions?.[0]?.display_name;
          if (!name) return null;
          return institution ? `${name} (${institution})` : name;
        })
        .filter(Boolean)
        .join("; ");
      const source = work.primary_location?.source?.display_name;
      const doi = work.doi ? work.doi.replace(/^https?:\/\/doi.org\//, "https://doi.org/") : null;
      const url = work.id || doi;
      return {
        title: work.display_name ?? "",
        url: url ?? "",
        snippet: [
          work.publication_year ? `Year: ${work.publication_year}.` : "",
          authorSummary ? `Authors: ${authorSummary}.` : "",
          doi ? `DOI: ${doi}.` : "",
          source ? `Source: ${source}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        position: index + 1,
      };
    })
    .filter((result) => searchResultSchema.safeParse(result).success)
    .map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      domain: extractHostname(result.url),
      position: result.position ?? null,
    }));
}

export function normalizeGitHubUserResults(results: Array<GitHubUserDetail | GitHubUserSearchItem>): NormalizedSearchResult[] {
  return results
    .map((user, index) => {
      const detail = user as GitHubUserDetail;
      const login = detail.login ?? "";
      const titleName = detail.name || login;
      return {
        title: titleName ? `${titleName} GitHub profile` : "",
        url: detail.html_url ?? "",
        snippet: [
          detail.bio ? `Bio: ${detail.bio}.` : "",
          detail.company ? `Company: ${detail.company}.` : "",
          detail.location ? `Location: ${detail.location}.` : "",
          detail.blog ? `Website: ${detail.blog}.` : "",
          typeof detail.public_repos === "number" ? `Public repos: ${detail.public_repos}.` : "",
          detail.recentActivityAt ? `Recent public activity: ${detail.recentActivityAt}.` : "",
          detail.updated_at ? `Profile updated: ${detail.updated_at}.` : "",
          login ? `GitHub login: ${login}.` : "",
          ...(detail.maintainerEvidence ?? []),
        ]
          .filter(Boolean)
          .join(" "),
        position: index + 1,
      };
    })
    .filter((result) => searchResultSchema.safeParse(result).success)
    .map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      domain: extractHostname(result.url),
      position: result.position ?? null,
    }));
}

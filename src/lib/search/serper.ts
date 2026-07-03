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
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", "8");

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

export async function searchGitHubUsers(query: string): Promise<NormalizedSearchResult[]> {
  const searchUrl = new URL("https://api.github.com/search/users");
  searchUrl.searchParams.set("q", `${query} type:user`);
  searchUrl.searchParams.set("per_page", "6");

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "expert-recruiter-mvp/0.1",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub user search failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as { items?: GitHubUserSearchItem[] };
  const items = body.items ?? [];
  const details: GitHubUserDetail[] = [];

  for (const item of items) {
    if (!item.url) continue;
    const detailResponse = await fetch(item.url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "expert-recruiter-mvp/0.1",
      },
    });
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
      const url = work.doi ? work.doi.replace(/^https?:\/\/doi.org\//, "https://doi.org/") : work.id;
      return {
        title: work.display_name ?? "",
        url: url ?? "",
        snippet: [
          work.publication_year ? `Year: ${work.publication_year}.` : "",
          authorSummary ? `Authors: ${authorSummary}.` : "",
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
          login ? `GitHub login: ${login}.` : "",
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

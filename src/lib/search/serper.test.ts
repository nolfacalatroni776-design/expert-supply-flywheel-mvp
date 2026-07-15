import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGitHubRepositoryQuery,
  isGitHubRepositoryRelevant,
  normalizeGitHubUserResults,
  normalizeOpenAlexResults,
  normalizeSerperResults,
  searchOpenAlex,
  searchGitHubMaintainers,
} from "./serper";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeSerperResults", () => {
  it("normalizes valid Serper results and removes invalid URLs", () => {
    const results = normalizeSerperResults([
      {
        title: "Expert profile",
        link: "https://example.com/expert",
        snippet: "A useful profile",
        position: 1,
      },
      {
        title: "Bad URL",
        link: "not-a-url",
        snippet: "Invalid",
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Expert profile",
      domain: "example.com",
      position: 1,
    });
  });
});

describe("fallback search normalizers", () => {
  it("normalizes OpenAlex works into source-backed results", () => {
    const results = normalizeOpenAlexResults([
      {
        display_name: "Deep learning for code review",
        id: "https://openalex.org/W123",
        publication_year: 2025,
        primary_location: { source: { display_name: "Software Engineering Journal" } },
        authorships: [
          {
            author: { display_name: "Ada Zhang" },
            institutions: [{ display_name: "Example University" }],
          },
        ],
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Deep learning for code review",
      domain: "openalex.org",
      position: 1,
    });
    expect(results[0].snippet).toContain("Ada Zhang");
  });

  it("keeps the OpenAlex work URL as provenance when a DOI is also available", () => {
    const results = normalizeOpenAlexResults([
      {
        id: "https://openalex.org/W456",
        doi: "https://doi.org/10.1000/example",
        display_name: "Single-cell RNA sequencing in cancer research",
        publication_year: 2023,
        authorships: [{ author: { display_name: "Ada Zhang" }, institutions: [] }],
      },
    ]);

    expect(results[0].url).toBe("https://openalex.org/W456");
    expect(results[0].snippet).toContain("DOI: https://doi.org/10.1000/example");
  });

  it("uses a recent-publication filter for an explicit recent paper-author search", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      expect(url.hostname).toBe("api.openalex.org");
      expect(url.searchParams.get("filter")).toMatch(/^from_publication_date:\d{4}-01-01/);
      expect(url.searchParams.get("filter")).toContain("authorships.institutions.country_code:CN|SG");
      expect(url.searchParams.get("search")).not.toContain("paper author");
      return Response.json({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchOpenAlex("single cell tumor immunology recent 5 years paper author China Singapore");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("translates a known Chinese medical topic into an effective OpenAlex search", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      expect(url.searchParams.get("search")).toContain("single-cell RNA sequencing");
      expect(url.searchParams.get("search")).toContain("tumor immunology");
      expect(url.searchParams.get("search")).not.toContain("论文作者");
      return Response.json({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchOpenAlex("肿瘤免疫与单细胞组学 recent 5 years paper author China Singapore");
  });

  it("normalizes GitHub users into profile results", () => {
    const results = normalizeGitHubUserResults([
      {
        login: "py-reviewer",
        name: "Python Reviewer",
        html_url: "https://github.com/py-reviewer",
        bio: "Python backend maintainer",
        company: "Example OSS",
        public_repos: 42,
        updated_at: "2026-06-01T00:00:00Z",
        recentActivityAt: "2026-07-15T12:00:00Z",
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Python Reviewer GitHub profile",
      domain: "github.com",
    });
    expect(results[0].snippet).toContain("Python backend maintainer");
    expect(results[0].snippet).toContain("Recent public activity: 2026-07-15T12:00:00Z");
    expect(results[0].snippet).toContain("Profile updated: 2026-06-01T00:00:00Z");
  });
});

describe("searchGitHubMaintainers", () => {
  it("finds people through public repositories and contributor evidence", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      if (url.pathname === "/search/repositories") {
        expect(url.searchParams.get("q")).toBe("fastapi language:python stars:>50");
        return Response.json({
          items: [
            {
              full_name: "fastapi/fastapi",
              html_url: "https://github.com/fastapi/fastapi",
              description: "FastAPI framework",
              stargazers_count: 90000,
              language: "Python",
              contributors_url: "https://api.github.com/repos/fastapi/fastapi/contributors",
              owner: { login: "fastapi", type: "Organization" },
            },
          ],
        });
      }
      if (url.pathname === "/repos/fastapi/fastapi/contributors") {
        return Response.json([
          {
            login: "ada-fastapi",
            html_url: "https://github.com/ada-fastapi",
            url: "https://api.github.com/users/ada-fastapi",
            type: "User",
            contributions: 240,
          },
        ]);
      }
      if (url.pathname === "/users/ada-fastapi") {
        return Response.json({
          login: "ada-fastapi",
          name: "Ada FastAPI",
          html_url: "https://github.com/ada-fastapi",
          bio: "Python API maintainer",
          company: "Open source",
          location: "Remote",
          public_repos: 48,
          updated_at: "2026-06-01T00:00:00Z",
        });
      }
      if (url.pathname === "/users/ada-fastapi/events/public") {
        return Response.json([{ type: "PushEvent", created_at: "2026-07-15T12:00:00Z" }]);
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchGitHubMaintainers("Python FastAPI Django 代码评审 GitHub maintainer");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Ada FastAPI GitHub profile",
      url: "https://github.com/ada-fastapi",
      domain: "github.com",
    });
    expect(results[0].snippet).toContain("fastapi/fastapi");
    expect(results[0].snippet).toContain("240 contributions");
    expect(results[0].snippet).toContain("Recent public activity: 2026-07-15T12:00:00Z");
  });

  it("builds a bounded repository query from technology signals", () => {
    expect(buildGitHubRepositoryQuery("Python FastAPI Django 代码评审 GitHub maintainer")).toBe(
      "fastapi language:python stars:>50",
    );
  });

  it("builds a project-specific query for Kubernetes eBPF instead of falling back to generic popular software", () => {
    const query = buildGitHubRepositoryQuery("Kubernetes eBPF 网络可观测性 GitHub maintainer");

    expect(query).toContain("kubernetes");
    expect(query).toContain("ebpf");
    expect(query).not.toContain("software stars:>500");
  });

  it("rejects unrelated popular repositories for a Kubernetes eBPF maintainer search", () => {
    const query = "Kubernetes eBPF 网络可观测性 GitHub maintainer";

    expect(
      isGitHubRepositoryRelevant(
        {
          full_name: "public-apis/public-apis",
          description: "A collective list of free APIs",
          language: "Python",
          topics: ["api", "developer-tools"],
        },
        query,
      ),
    ).toBe(false);
    expect(
      isGitHubRepositoryRelevant(
        {
          full_name: "cilium/cilium",
          description: "eBPF-based networking, observability and security for Kubernetes",
          language: "Go",
          topics: ["ebpf", "kubernetes", "networking"],
        },
        query,
      ),
    ).toBe(true);
  });

  it("targets Pydantic repositories instead of degrading to generic Python backend search", () => {
    expect(
      buildGitHubRepositoryQuery("Python Pydantic v2 pydantic-core SQLModel 代码评审 GitHub maintainer"),
    ).toBe("pydantic in:name,description stars:>20");
  });

  it("rejects repositories that only weakly match the requested technology", () => {
    expect(
      isGitHubRepositoryRelevant(
        {
          full_name: "headroomlabs-ai/headroom",
          description: "AI application platform",
          language: "Python",
          topics: ["ai", "llm", "fastapi"],
        },
        "Python FastAPI Django 代码评审 GitHub maintainer",
      ),
    ).toBe(false);
    expect(
      isGitHubRepositoryRelevant(
        {
          full_name: "fastapi/fastapi",
          description: "FastAPI framework",
          language: "Python",
          topics: ["api", "python"],
        },
        "Python FastAPI Django 代码评审 GitHub maintainer",
      ),
    ).toBe(true);
  });

  it("rejects generic Python repositories for a Pydantic maintainer query", () => {
    const query = "Python Pydantic v2 pydantic-core SQLModel 代码评审 GitHub maintainer";

    expect(
      isGitHubRepositoryRelevant(
        {
          full_name: "sparckles/Robyn",
          description: "A fast async Python web framework",
          language: "Python",
          topics: ["python", "backend"],
        },
        query,
      ),
    ).toBe(false);
    expect(
      isGitHubRepositoryRelevant(
        {
          full_name: "pydantic/pydantic",
          description: "Data validation using Python type hints",
          language: "Python",
          topics: ["python", "validation"],
        },
        query,
      ),
    ).toBe(true);
  });

  it("does not treat a dependency mention in an unrelated repository description as maintainer evidence", () => {
    expect(
      isGitHubRepositoryRelevant(
        {
          full_name: "MetaCubeX/mihomo",
          description: "A network tool with a Python service using Pydantic configuration models",
          language: "Go",
          topics: ["network"],
        },
        "Python Pydantic v2 pydantic-core SQLModel 代码评审 GitHub maintainer",
      ),
    ).toBe(false);
  });
});

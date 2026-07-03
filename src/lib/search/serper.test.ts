import { describe, expect, it } from "vitest";
import { normalizeGitHubUserResults, normalizeOpenAlexResults, normalizeSerperResults } from "./serper";

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

  it("normalizes GitHub users into profile results", () => {
    const results = normalizeGitHubUserResults([
      {
        login: "py-reviewer",
        name: "Python Reviewer",
        html_url: "https://github.com/py-reviewer",
        bio: "Python backend maintainer",
        company: "Example OSS",
        public_repos: 42,
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Python Reviewer GitHub profile",
      domain: "github.com",
    });
    expect(results[0].snippet).toContain("Python backend maintainer");
  });
});

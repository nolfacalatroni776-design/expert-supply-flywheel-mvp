import { describe, expect, it } from "vitest";
import {
  buildFallbackCandidatesFromSearchResults,
  buildExpertIdentityKey,
  buildEvidenceDedupeKey,
  buildExternalCandidateReviewFields,
  chooseLatestActivityDate,
  getCompatibleCachedQueries,
  getRediscoveredCandidateScreenOutUpdate,
  requiresSourcedCandidateReview,
  resolveCandidateExtraction,
  selectResultsForCandidateExtraction,
  shouldBypassSearchCache,
  shouldUseCachedSearch,
} from "@/lib/sourcing";

const RECENT_GITHUB_ACTIVITY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

describe("expert identity", () => {
  it("keeps different people from one shared event page as separate experts", () => {
    const sourceUrl = "https://meeting.example/single-cell-2025";
    expect(buildExpertIdentityKey({ name: "韩欣欣", sourceUrl })).not.toBe(
      buildExpertIdentityKey({ name: "汤富酬", sourceUrl }),
    );
  });

  it("uses a stable personal-profile identity even when the display name changes", () => {
    expect(buildExpertIdentityKey({ name: "Thomas Graf", sourceUrl: "https://github.com/tgraf" })).toBe(
      buildExpertIdentityKey({ name: "Thomas", sourceUrl: "https://github.com/tgraf/" }),
    );
  });
});

describe("expert activity freshness", () => {
  it("keeps the newest verified activity when a repeated search returns older evidence", () => {
    const existing = new Date("2026-07-15T12:00:00.000Z");

    expect(chooseLatestActivityDate(existing, "2026-06-01T08:00:00Z")).toEqual(existing);
    expect(chooseLatestActivityDate(existing, "2026-07-16T08:00:00Z")).toEqual(
      new Date("2026-07-16T08:00:00.000Z"),
    );
  });

  it("ignores malformed activity evidence instead of clearing a known date", () => {
    const existing = new Date("2026-07-15T12:00:00.000Z");

    expect(chooseLatestActivityDate(existing, "not-a-date")).toEqual(existing);
    expect(chooseLatestActivityDate(null, "not-a-date")).toBeNull();
  });
});

describe("rediscovered candidate revalidation", () => {
  const currentResultUrls = ["https://github.com/current-reviewer", "https://example.com/profile"];

  it("screens out an unapproved early-stage candidate when the same source fails current quality gates", () => {
    expect(
      getRediscoveredCandidateScreenOutUpdate({
        candidate: {
          stage: "sourced",
          sourceType: "external",
          humanReviewNeeded: true,
          sourceUrl: "https://github.com/current-reviewer/",
        },
        currentResultUrls,
        acceptedSourceUrls: [],
      }),
    ).toEqual({
      stage: "screened_out",
      humanReviewNeeded: false,
      nextAction:
        "本项目暂不推进：最新公开资料未通过当前身份、相关性或近期活跃度校验。如有新证据，可重新复核。",
    });
  });

  it("preserves candidates already accepted by the current run or manually advanced", () => {
    const base = {
      sourceType: "external",
      humanReviewNeeded: true,
      sourceUrl: "https://github.com/current-reviewer",
    };
    expect(
      getRediscoveredCandidateScreenOutUpdate({
        candidate: { ...base, stage: "sourced" },
        currentResultUrls,
        acceptedSourceUrls: ["https://github.com/current-reviewer"],
      }),
    ).toBeNull();
    expect(
      getRediscoveredCandidateScreenOutUpdate({
        candidate: { ...base, stage: "verified", humanReviewNeeded: false },
        currentResultUrls,
        acceptedSourceUrls: [],
      }),
    ).toBeNull();
  });

  it("does not change a historical candidate that was absent from the current search results", () => {
    expect(
      getRediscoveredCandidateScreenOutUpdate({
        candidate: {
          stage: "sourced",
          sourceType: "external",
          humanReviewNeeded: true,
          sourceUrl: "https://github.com/not-seen-in-this-run",
        },
        currentResultUrls,
        acceptedSourceUrls: [],
      }),
    ).toBeNull();
  });
});

describe("external candidate review fields", () => {
  it("turns model-language drift into concise Chinese review items and a concrete next action", () => {
    const review = buildExternalCandidateReviewFields({
      evidenceLevel: "E2",
      lastActiveAt: "2026-07-15T12:00:00.000Z",
      risks: [
        "Region is Berlin, Germany (UTC+1), not in the requested UTC+8 timezone.",
        "Primary language likely English; Chinese language proficiency is unknown.",
        "No direct evidence of enterprise code review experience.",
      ],
    });

    expect(review.risks.every((risk) => /[\u3400-\u9fff]/.test(risk))).toBe(true);
    expect(review.missing.join(" ")).toContain("代码评审");
    expect(review.nextAction).toContain("人工复核");
    expect(review.nextAction).toContain("触达许可");
  });
});

describe("search cache compatibility", () => {
  it("only bypasses cache for an explicit server-side verification flag", () => {
    expect(shouldBypassSearchCache("1")).toBe(true);
    expect(shouldBypassSearchCache("true")).toBe(true);
    expect(shouldBypassSearchCache("TRUE")).toBe(true);
    expect(shouldBypassSearchCache("0")).toBe(false);
    expect(shouldBypassSearchCache(undefined)).toBe(false);
  });

  it("invalidates generic web cache for an explicit GitHub people search", () => {
    expect(shouldUseCachedSearch("Python FastAPI GitHub maintainer", "serper")).toBe(false);
    expect(shouldUseCachedSearch("Python FastAPI GitHub maintainer", "github")).toBe(false);
    expect(shouldUseCachedSearch("Python FastAPI GitHub maintainer", "github_maintainers_v2")).toBe(false);
    expect(shouldUseCachedSearch("Python FastAPI GitHub maintainer", "github_maintainers_v3")).toBe(false);
    expect(shouldUseCachedSearch("Python FastAPI GitHub maintainer", "github_maintainers_v4")).toBe(false);
    expect(shouldUseCachedSearch("Python FastAPI GitHub maintainer", "github_maintainers_v5")).toBe(false);
    expect(shouldUseCachedSearch("Python FastAPI GitHub maintainer", "github_maintainers_v6")).toBe(false);
    expect(shouldUseCachedSearch("Python FastAPI GitHub maintainer", "github_maintainers_v7")).toBe(true);
    expect(shouldUseCachedSearch("Python conference speaker", "serper")).toBe(true);
    expect(shouldUseCachedSearch("single cell recent 5 years paper author", "serper")).toBe(false);
    expect(shouldUseCachedSearch("single cell recent 5 years paper author", "openalex_works_v2")).toBe(false);
    expect(shouldUseCachedSearch("single cell recent 5 years paper author", "openalex_works_v3")).toBe(true);
  });

  it("uses the same compatibility rule for confirmation cost estimates", () => {
    expect(
      getCompatibleCachedQueries([
        { query: "Python FastAPI GitHub maintainer", provider: "github" },
        { query: "Python conference speaker", provider: "serper" },
      ]),
    ).toEqual(["Python conference speaker"]);
  });
});

describe("sourced candidate review policy", () => {
  it("keeps authoritative external evidence in human review before outreach", () => {
    expect(requiresSourcedCandidateReview({ sourceType: "external", evidenceLevel: "E2", regulated: false })).toBe(true);
    expect(requiresSourcedCandidateReview({ sourceType: "internal", evidenceLevel: "E3", regulated: false })).toBe(false);
    expect(requiresSourcedCandidateReview({ sourceType: "internal", evidenceLevel: "E3", regulated: true })).toBe(true);
  });
});

describe("evidence idempotency", () => {
  it("uses one stable identity for GitHub API evidence even when model claim wording changes", () => {
    const first = buildEvidenceDedupeKey({
      candidateId: "candidate-1",
      sourceUrl: "https://github.com/tiangolo",
      sourceType: "github_api",
      claim: "Maintains FastAPI",
    });
    const repeated = buildEvidenceDedupeKey({
      candidateId: "candidate-1",
      sourceUrl: "https://github.com/tiangolo/",
      sourceType: "github_api",
      claim: "Direct contributor to FastAPI",
    });
    const publicClaim = buildEvidenceDedupeKey({
      candidateId: "candidate-1",
      sourceUrl: "https://github.com/tiangolo",
      sourceType: "public_web",
      claim: "Conference speaker",
    });
    const reviewClaim = buildEvidenceDedupeKey({
      candidateId: "candidate-1",
      sourceUrl: "https://github.com/tiangolo",
      sourceType: "github_api",
      claim: "GitHub 公开代码评审记录与项目要求的技术仓库相关",
    });
    const repeatedReviewClaim = buildEvidenceDedupeKey({
      candidateId: "candidate-1",
      sourceUrl: "https://github.com/tiangolo/",
      sourceType: "github_api",
      claim: "Verified PR review activity",
    });

    expect(repeated).toBe(first);
    expect(publicClaim).not.toBe(first);
    expect(reviewClaim).not.toBe(first);
    expect(repeatedReviewClaim).toBe(reviewClaim);
  });
});

describe("candidate extraction input selection", () => {
  it("bounds model input while retaining every approved search direction", () => {
    const results = [
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `github-${index}`,
        query: "q-github",
        title: `Maintainer ${index} GitHub profile`,
        url: `https://github.com/maintainer-${index}`,
        snippet: `Repository evidence: ${index + 1} contributions to pydantic/pydantic.`,
      })),
      { id: "speaker", query: "q-speaker", title: "PyCon speaker", url: "https://conf.example/speaker", snippet: "Conference speaker profile" },
      { id: "institution", query: "q-institution", title: "Team profile", url: "https://org.example/team/ada", snippet: "Institution team member profile" },
      { id: "author", query: "q-author", title: "Paper author", url: "https://papers.example/author", snippet: "Publication author profile" },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `article-${index}`,
        query: "q-speaker",
        title: `Generic article ${index}`,
        url: `https://blog.example/${index}`,
        snippet: "Generic project article",
      })),
    ];

    const selected = selectResultsForCandidateExtraction(results, 8);

    expect(selected).toHaveLength(8);
    expect(new Set(selected.map((result) => result.query))).toEqual(
      new Set(["q-github", "q-speaker", "q-institution", "q-author"]),
    );
    expect(selected.filter((result) => result.id.startsWith("github-")).length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildFallbackCandidatesFromSearchResults", () => {
  it("turns saved public search results into reviewable E1 candidate leads", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "具身智能", languagesJson: JSON.stringify(["中文"]), regionsJson: JSON.stringify(["中国"]) },
      [
        {
          title: "王工 GitHub profile",
          url: "https://github.com/robotics-wang",
          snippet: `Embodied intelligence robotics maintainer. GitHub login: robotics-wang. Recent public activity: ${RECENT_GITHUB_ACTIVITY}.`,
          domain: "github.com",
        },
        {
          title: "具身智能工厂落地论文",
          url: "https://openalex.org/W123",
          snippet: "Authors: Li Wei (Example University). Year: 2025.",
          domain: "openalex.org",
        },
      ],
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      name: "王工",
      sourceUrl: "https://github.com/robotics-wang",
      evidenceLevel: "E1",
      risks: ["AI 抽取不可用，需人工复核公开结果是否为真实专家。"],
    });
    expect(candidates[0].claims[0].claim).toContain("公开搜索结果");
    expect(candidates[1].name).toBe("Li Wei");
  });

  it("does not mistake a Stack Overflow question containing the verb profile for a person", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "Python 后端", taskType: "代码评审", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "How can I profile a SQLAlchemy powered application?",
          url: "https://stackoverflow.com/questions/1171166/how-can-i-profile-a-sqlalchemy-powered-application",
          snippet: "Does anyone have experience profiling a Python and SQLAlchemy app?",
          domain: "stackoverflow.com",
        },
      ],
    );

    expect(candidates).toEqual([]);
  });

  it("keeps expert names from a news article as search evidence rather than candidate identities", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "具身智能", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "于海斌、王耀南、张钹三位院士解读具身智能",
          url: "https://news.example.com/embodied-ai-academicians",
          snippet: "三位院士围绕具身智能产业落地进行解读。",
          domain: "news.example.com",
        },
      ],
    );

    expect(candidates).toEqual([]);
  });

  it("recognizes a one-segment GitHub user page from real search-result structure", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "Python 开源后端", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "panbin - python开源项目",
          url: "https://github.com/panbin",
          snippet: `GitHub 上的 Python 开源项目维护记录。Recent public activity: ${RECENT_GITHUB_ACTIVITY}.`,
          domain: "github.com",
        },
      ],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: "panbin", sourceUrl: "https://github.com/panbin", evidenceLevel: "E1" });
  });

  it("assigns E2 when GitHub directly verifies a person-to-repository contribution", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "Python 开源后端", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "Sebastián Ramírez GitHub profile",
          url: "https://github.com/tiangolo",
          snippet:
            `GitHub login: tiangolo. Repository evidence: 2200 contributions to fastapi/fastapi (100000 stars). Recent public activity: ${RECENT_GITHUB_ACTIVITY}.`,
          domain: "github.com",
        },
      ],
    );

    expect(candidates[0].evidenceLevel).toBe("E2");
    expect(candidates[0].claims[0].evidenceLevel).toBe("E2");
    expect(candidates[0].claims[0].sourceType).toBe("github_api");
    expect(candidates[0].lastActiveAt).toBe(RECENT_GITHUB_ACTIVITY);
    expect(candidates[0].risks.join(" ")).not.toContain("近期活跃");
  });

  it("preserves a directly verified GitHub PR review as a separate evidence claim", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      {
        domain: "Python FastAPI 后端",
        rawDemand: "需要 FastAPI 维护者完成代码评审。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      [
        {
          title: "Ada FastAPI GitHub profile",
          url: "https://github.com/ada-fastapi",
          snippet:
            `Repository evidence: 240 contributions to fastapi/fastapi (90000 stars). Code review evidence: reviewed 17 pull requests in fastapi/fastapi. Example review: https://github.com/fastapi/fastapi/pull/1234. Recent public activity: ${RECENT_GITHUB_ACTIVITY}.`,
          domain: "github.com",
        },
      ],
    );

    expect(candidates[0].claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: "GitHub 公开代码评审记录与项目要求的技术仓库相关",
          sourceType: "github_api",
          evidenceLevel: "E2",
        }),
      ]),
    );
  });

  it("rejects GitHub contribution evidence when the repository is unrelated to the project", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      {
        domain: "Kubernetes eBPF 网络可观测性",
        rawDemand: "需要 Cilium、Hubble、Linux eBPF 或云原生网络实践。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      [
        {
          title: "Matheus Felipe GitHub profile",
          url: "https://github.com/matheusfelipeog",
          snippet: "Repository evidence: 826 contributions to public-apis/public-apis (450357 stars).",
          domain: "github.com",
        },
      ],
    );

    expect(candidates).toEqual([]);
  });

  it("keeps direct Cilium contribution evidence as a reviewable E2 candidate", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      {
        domain: "Kubernetes eBPF 网络可观测性",
        rawDemand: "需要 Cilium、Hubble、Linux eBPF 或云原生网络实践。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      [
        {
          title: "Ada Network GitHub profile",
          url: "https://github.com/ada-network",
          snippet: `Repository evidence: 640 contributions to cilium/cilium (22000 stars). Profile updated: ${RECENT_GITHUB_ACTIVITY}.`,
          domain: "github.com",
        },
      ],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ name: "Ada Network", evidenceLevel: "E2" });
  });

  it("does not mistake a GitHub repository page for a person", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "Python 开源后端", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "likeadmin通用管理后台（Python）",
          url: "https://github.com/likeadmin/likeadmin_python",
          snippet: "A Python admin repository.",
          domain: "github.com",
        },
      ],
    );

    expect(candidates).toHaveLength(0);
  });

  it("does not turn a LinkedIn post or hashtags into a person", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "Python 开源后端", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "#django #fastapi #python",
          url: "https://www.linkedin.com/posts/djangocon_django-fastapi-python-activity-123",
          snippet: "A conference community post.",
          domain: "linkedin.com",
        },
      ],
    );

    expect(candidates).toHaveLength(0);
  });

  it("keeps generic articles as search evidence instead of creating noisy expert candidates", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "具身智能", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "漫画：大模型强控具身智能机器人？",
          url: "https://news.example.com/cartoon",
          snippet: "这是一篇泛科普文章。",
          domain: "news.example.com",
        },
      ],
    );

    expect(candidates).toHaveLength(0);
  });

  it("does not turn the project domain itself into a candidate name", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "具身智能", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "具身智能：产业趋势与落地路径",
          url: "https://news.example.com/domain",
          snippet: "行业趋势文章。",
          domain: "news.example.com",
        },
      ],
    );

    expect(candidates).toHaveLength(0);
  });

  it("extracts a Chinese profile name from result snippets before using the page title", () => {
    const candidates = buildFallbackCandidatesFromSearchResults(
      { domain: "具身智能", languagesJson: "[]", regionsJson: "[]" },
      [
        {
          title: "具身智能",
          url: "https://ccf.org.cn/profile",
          snippet: "简介：霍静，博士，南京大学计算机科学与技术系准聘副教授，博导。",
          domain: "ccf.org.cn",
        },
      ],
    );

    expect(candidates[0].name).toBe("霍静");
  });
});

describe("resolveCandidateExtraction", () => {
  const project = {
    domain: "中文 NLP",
    languagesJson: JSON.stringify(["中文"]),
    regionsJson: JSON.stringify(["远程"]),
  };

  it("keeps an interview video as search evidence instead of creating a candidate", () => {
    const sourceUrl = "https://www.youtube.com/watch?v=QWFmWOw8gRg";
    const result = resolveCandidateExtraction({
      project: {
        domain: "Python 开源后端",
        taskType: "代码评审",
        rawDemand: "招募具备 FastAPI 或 Django 代码评审经历的专家。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      searchResults: [
        {
          title: "Jeff Triplett on Django, FastAPI, uv, Pydantic, and AI Agents in Python",
          url: sourceUrl,
          snippet: "Jeff Triplett discusses Django, FastAPI, uv and Pydantic in an interview.",
          domain: "youtube.com",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Jeff Triplett",
            title: "Python open-source expert",
            affiliation: null,
            sourceUrl,
            domainTags: ["Django", "FastAPI"],
            languages: ["English"],
            region: null,
            evidenceLevel: "E1",
            risks: [],
            claims: [
              {
                claim: "Discusses Django and FastAPI",
                sourceUrl,
                sourceTitle: "Interview",
                sourceType: "public_web",
                snippet: "Interview about Django and FastAPI.",
                evidenceLevel: "E1",
                confidence: 0.7,
              },
            ],
          },
        ],
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedCandidates).toBe(1);
  });

  it("uses review-only fallback leads when the model succeeds with an empty candidate array", () => {
    const result = resolveCandidateExtraction({
      project,
      searchResults: [
        {
          title: "张敏 GitHub profile",
          url: "https://github.com/zhangmin-nlp",
          snippet: `Chinese NLP annotation quality maintainer. GitHub login: zhangmin-nlp. Recent public activity: ${RECENT_GITHUB_ACTIVITY}.`,
          domain: "github.com",
        },
      ],
      extraction: { ok: true, candidates: [] },
    });

    expect(result.usedFallback).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ name: "张敏", evidenceLevel: "E1" });
  });

  it("keeps authoritative OpenAlex authors alongside a model-extracted conference speaker", () => {
    const result = resolveCandidateExtraction({
      project: {
        domain: "肿瘤免疫与单细胞组学",
        rawDemand: "招募单细胞 RNA 测序肿瘤免疫论文作者和会议讲者。",
        languagesJson: JSON.stringify(["中文", "英文"]),
        regionsJson: JSON.stringify(["中国", "新加坡"]),
      },
      searchResults: [
        {
          title: "Single-cell RNA sequencing in cancer research",
          url: "https://openalex.org/W456",
          snippet:
            "Year: 2023. Authors: Yijie Zhang (Central South University); Dan Wang (Central South University). DOI: https://doi.org/10.1000/example. Source: Journal of Hematology & Oncology.",
          domain: "openalex.org",
        },
        {
          title: "AACR speaker profile",
          url: "https://conference.example/speakers/lai-ng",
          snippet: "Speaker Lai Guan Ng, Singapore Immunology Network.",
          domain: "conference.example",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Lai Guan Ng",
            title: "Speaker",
            affiliation: "Singapore Immunology Network",
            sourceUrl: "https://conference.example/speakers/lai-ng",
            domainTags: ["肿瘤免疫"],
            languages: ["英文"],
            region: "新加坡",
            evidenceLevel: "E1",
            risks: [],
            claims: [],
          },
        ],
      },
    });

    expect(result.candidates.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(["Lai Guan Ng", "Yijie Zhang", "Dan Wang"]),
    );
    expect(result.candidates.find((candidate) => candidate.name === "Yijie Zhang")).toMatchObject({
      evidenceLevel: "E2",
      sourceUrl: "https://openalex.org/W456",
      affiliation: "Central South University",
    });
  });

  it("does not turn broad Python papers into code-review expert candidates", () => {
    const result = resolveCandidateExtraction({
      project: {
        domain: "Python 后端",
        taskType: "代码评审",
        rawDemand:
          "招募具备 5 年以上企业级 Python 后端经验、精通 FastAPI、Django、SQLAlchemy 并有代码评审经历的专家。",
        languagesJson: JSON.stringify(["中文", "英文"]),
        regionsJson: JSON.stringify(["远程", "UTC+8"]),
      },
      searchResults: [
        {
          title: "What are the Top Used Modules in Python Open-Source Projects?",
          url: "https://openalex.org/W4285496174",
          snippet:
            "Year: 2022. Authors: Luana Gribel Ito (National Institute of Telecommunications); Mariana Helena Ines Moreira (National Institute of Telecommunications). DOI: https://doi.org/10.14210/example.",
          domain: "openalex.org",
        },
      ],
      extraction: { ok: false, error: "Model unavailable" },
    });

    expect(result.candidates).toEqual([]);
  });

  it("extracts dedicated speaker and institutional profile pages without relying on the model", () => {
    const result = resolveCandidateExtraction({
      project: {
        domain: "肿瘤免疫与单细胞组学",
        rawDemand: "招募会议讲者和机构团队成员。",
        languagesJson: JSON.stringify(["中文", "英文"]),
        regionsJson: JSON.stringify(["中国", "新加坡"]),
      },
      searchResults: [
        {
          title: "Speaker: Cell Symposia: Myeloid Cells",
          url: "https://cell-press-symposia.com/myeloidcells-2021/bio-Ng.html",
          snippet: "Speaker Lai Guan Ng, Singapore Immunology Network ・ study how immune cells shape tumors.",
          domain: "cell-press-symposia.com",
        },
        {
          title: "Assoc Prof Ong Choon Kiat",
          url: "https://www.nccs.com.sg/researcher/ong-choon-kiat",
          snippet:
            "Assoc Prof Ong Choon Kiat is the Principal Investigator of Lymphoma Genomic Translational Research Laboratory, National Cancer Centre Singapore.",
          domain: "nccs.com.sg",
        },
        {
          title: "肿瘤医院",
          url: "https://example.edu.cn/department/oncology",
          snippet: "从事单细胞功能与组学技术应用研究，在肿瘤免疫微环境解析领域积累经验。",
          domain: "example.edu.cn",
        },
      ],
      extraction: { ok: true, candidates: [] },
    });

    expect(result.candidates.map((candidate) => candidate.name)).toEqual(["Lai Guan Ng", "Ong Choon Kiat"]);
    expect(result.candidates.every((candidate) => candidate.evidenceLevel === "E1")).toBe(true);
    expect(result.candidates.every((candidate) => candidate.risks.join(" ").includes("人工复核"))).toBe(true);
    expect(result.candidates.find((candidate) => candidate.name === "Lai Guan Ng")?.affiliation).toBe(
      "Singapore Immunology Network",
    );
  });

  it("rejects an institutional profile lead when the snippet identifies a different person", () => {
    const result = resolveCandidateExtraction({
      project: {
        domain: "肿瘤免疫",
        rawDemand: "招募机构研究人员。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      searchResults: [
        {
          title: "Xin Lin, Ph.D.",
          url: "https://www.iitu.tsinghua.edu.cn/XinLin/list.htm",
          snippet: "Dr. Zhao has more than 15 years experience in tumor immunology and CAR-T research.",
          domain: "iitu.tsinghua.edu.cn",
        },
      ],
      extraction: { ok: true, candidates: [] },
    });

    expect(result.candidates).toEqual([]);
  });

  it("filters implausible model candidates before they reach the database", () => {
    const result = resolveCandidateExtraction({
      project,
      searchResults: [
        {
          title: "Ada FastAPI GitHub profile",
          url: "https://github.com/ada-fastapi",
          snippet: `FastAPI contributor profile. Recent public activity: ${RECENT_GITHUB_ACTIVITY}.`,
          domain: "github.com",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Ada FastAPI",
            title: "Open-source maintainer",
            affiliation: "GitHub",
            sourceUrl: "https://github.com/ada-fastapi",
            domainTags: ["FastAPI"],
            languages: ["English"],
            region: null,
            evidenceLevel: "E1",
            risks: [],
            claims: [
              {
                claim: "Maintains FastAPI",
                sourceUrl: "https://github.com/tiangolo",
                sourceTitle: "Public profile",
                sourceType: "public_web",
                snippet: "Generic profile summary.",
                evidenceLevel: "E1",
                confidence: 0.6,
              },
            ],
          },
          {
            name: "#django #fastapi #python",
            title: "Social post",
            affiliation: "LinkedIn",
            sourceUrl: "https://www.linkedin.com/posts/djangocon_activity-123",
            domainTags: ["Python"],
            languages: [],
            region: null,
            evidenceLevel: "E1",
            risks: [],
            claims: [
              {
                claim: "Maintains FastAPI",
                sourceUrl: "https://github.com/tiangolo",
                sourceTitle: "Public profile",
                sourceType: "public_web",
                snippet: "Generic profile summary.",
                evidenceLevel: "E1",
                confidence: 0.6,
              },
            ],
          },
        ],
      },
    });

    expect(result.candidates.map((candidate) => candidate.name)).toEqual(["Ada FastAPI"]);
    expect(result.rejectedCandidates).toBe(1);
  });

  it("rejects a plausible-looking candidate whose profile was not present in saved search results", () => {
    const result = resolveCandidateExtraction({
      project,
      searchResults: [
        {
          title: "Pydantic release notes",
          url: "https://pydantic.dev/articles/release",
          snippet: "Pydantic v2 release notes.",
          domain: "pydantic.dev",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Invented Maintainer",
            title: "Pydantic maintainer",
            affiliation: "GitHub",
            sourceUrl: "https://github.com/invented-maintainer",
            domainTags: ["Pydantic"],
            languages: ["English"],
            region: null,
            evidenceLevel: "E2",
            risks: [],
            claims: [],
          },
        ],
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedCandidates).toBe(1);
  });

  it("upgrades model output to E2 only when the saved GitHub result has direct contribution evidence", () => {
    const result = resolveCandidateExtraction({
      project: {
        domain: "Python FastAPI 后端",
        rawDemand: "需要 FastAPI 维护者参与代码评审。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      searchResults: [
        {
          title: "Sebastián Ramírez GitHub profile",
          url: "https://github.com/tiangolo",
          snippet:
            `Repository evidence: 2200 contributions to fastapi/fastapi (100000 stars). Recent public activity: ${RECENT_GITHUB_ACTIVITY}.`,
          domain: "github.com",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Sebastián Ramírez",
            title: "FastAPI maintainer",
            affiliation: "GitHub",
            sourceUrl: "https://github.com/tiangolo",
            domainTags: ["FastAPI"],
            languages: [],
            region: null,
            evidenceLevel: "E1",
            risks: [],
            claims: [
              {
                claim: "Maintains FastAPI",
                sourceUrl: "https://github.com/tiangolo",
                sourceTitle: "Public profile",
                sourceType: "public_web",
                snippet: "Generic profile summary.",
                evidenceLevel: "E1",
                confidence: 0.6,
              },
            ],
          },
        ],
      },
    });

    expect(result.candidates[0].evidenceLevel).toBe("E2");
    expect(result.candidates[0].claims[0]).toMatchObject({
      claim: "GitHub 公开贡献记录与目标技术相关",
      sourceType: "github_api",
      evidenceLevel: "E2",
      snippet:
        `Repository evidence: 2200 contributions to fastapi/fastapi (100000 stars). Recent public activity: ${RECENT_GITHUB_ACTIVITY}.`,
    });
    expect(result.candidates[0].lastActiveAt).toBe(RECENT_GITHUB_ACTIVITY);
    expect(result.candidates[0].risks.join(" ")).not.toContain("近期活跃");
  });

  it("keeps stale GitHub contribution history as search evidence instead of a current candidate", () => {
    const result = resolveCandidateExtraction({
      project: {
        domain: "Python FastAPI 后端",
        rawDemand: "需要 FastAPI 维护者参与代码评审。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      searchResults: [
        {
          title: "Ada Maintainer GitHub profile",
          url: "https://github.com/ada-maintainer",
          snippet: "Repository evidence: 400 contributions to fastapi/fastapi (100000 stars). Profile updated: 2021-01-01T00:00:00Z.",
          domain: "github.com",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Ada Maintainer",
            title: "FastAPI maintainer",
            affiliation: "GitHub",
            sourceUrl: "https://github.com/ada-maintainer",
            domainTags: ["FastAPI"],
            languages: [],
            region: null,
            evidenceLevel: "E1",
            risks: [],
            claims: [],
          },
        ],
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedCandidates).toBe(1);
  });

  it("hydrates missing claim provenance from the saved search result", () => {
    const sourceUrl = "https://www.youtube.com/watch?v=django-fastapi";
    const result = resolveCandidateExtraction({
      project: {
        domain: "Python 后端",
        taskType: "代码评审",
        rawDemand: "招募熟悉 Django 与 FastAPI 的代码评审专家。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      searchResults: [
        {
          title: "Combining Django ORM & FastAPI in a Single App",
          url: sourceUrl,
          snippet: "Talk by Mia Bajić at DjangoCon Europe 2024.",
          domain: "youtube.com",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Mia Bajić",
            title: "Conference Speaker",
            affiliation: null,
            sourceUrl,
            domainTags: ["Django", "FastAPI"],
            languages: [],
            region: null,
            evidenceLevel: "E1",
            risks: [],
            claims: [
              {
                claim: "在 DjangoCon Europe 分享 Django ORM 与 FastAPI 集成实践",
                sourceUrl,
                sourceTitle: null,
                sourceType: "public_web",
                snippet: "",
                evidenceLevel: "E1",
                confidence: 0.6,
              },
            ],
          },
        ],
      },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].claims[0]).toMatchObject({
      sourceTitle: "Combining Django ORM & FastAPI in a Single App",
      snippet: "Talk by Mia Bajić at DjangoCon Europe 2024.",
    });
  });

  it("rejects a model candidate backed only by an unrelated GitHub repository", () => {
    const result = resolveCandidateExtraction({
      project: {
        domain: "Kubernetes eBPF 网络可观测性",
        rawDemand: "需要 Cilium、Hubble、Linux eBPF 或云原生网络实践。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      searchResults: [
        {
          title: "Matheus Felipe GitHub profile",
          url: "https://github.com/matheusfelipeog",
          snippet: "Repository evidence: 826 contributions to public-apis/public-apis (450357 stars).",
          domain: "github.com",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Matheus Felipe",
            title: "Open-source contributor",
            affiliation: "GitHub",
            sourceUrl: "https://github.com/matheusfelipeog",
            domainTags: ["eBPF"],
            languages: [],
            region: null,
            evidenceLevel: "E2",
            risks: [],
            claims: [],
          },
        ],
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedCandidates).toBe(1);
  });

  it("removes unseen claim URLs and does not allow public model output above E2", () => {
    const result = resolveCandidateExtraction({
      project,
      searchResults: [
        {
          title: "Ada Reviewer profile",
          url: "https://profiles.example.com/profile/ada-reviewer",
          snippet: "Ada Reviewer public professional profile.",
          domain: "profiles.example.com",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Ada Reviewer",
            title: "Reviewer",
            affiliation: "Example",
            sourceUrl: "https://profiles.example.com/profile/ada-reviewer",
            domainTags: ["review"],
            languages: ["English"],
            region: null,
            evidenceLevel: "E4",
            risks: [],
            claims: [
              {
                claim: "Unverified credential",
                sourceUrl: "https://unseen.example.com/credential",
                sourceTitle: "Unseen source",
                sourceType: "public_web",
                snippet: "Not returned by search.",
                evidenceLevel: "E4",
                confidence: 0.99,
              },
            ],
          },
        ],
      },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].claims).toEqual([]);
    expect(result.candidates[0].evidenceLevel).toBe("E1");
  });

  it("does not attach other speakers' affiliations to a candidate from a shared conference page", () => {
    const sourceUrl = "https://meeting.example/single-cell-2025";
    const result = resolveCandidateExtraction({
      project: {
        domain: "肿瘤免疫与单细胞组学",
        rawDemand: "需要单细胞肿瘤免疫研究和会议讲者经历。",
        languagesJson: "[]",
        regionsJson: "[]",
      },
      searchResults: [
        {
          title: "单细胞多组学研究会议",
          url: sourceUrl,
          snippet: "确认嘉宾：赵玉政 教授，华东理工大学；汤富酬 教授，北京大学；韩欣欣 副研究员，复旦大学附属口腔医院。",
          domain: "meeting.example",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "韩欣欣",
            title: "副研究员",
            affiliation: "复旦大学附属口腔医院",
            sourceUrl,
            domainTags: ["单细胞"],
            languages: ["中文"],
            region: "中国",
            evidenceLevel: "E2",
            risks: [],
            claims: [
              {
                claim: "华东理工大学教授",
                sourceUrl,
                sourceTitle: "单细胞多组学研究会议",
                sourceType: "public_web",
                snippet: "",
                evidenceLevel: "E2",
                confidence: 0.9,
              },
              {
                claim: "复旦大学附属口腔医院副研究员",
                sourceUrl,
                sourceTitle: "单细胞多组学研究会议",
                sourceType: "public_web",
                snippet: "",
                evidenceLevel: "E2",
                confidence: 0.9,
              },
            ],
          },
        ],
      },
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].evidenceLevel).toBe("E1");
    expect(result.candidates[0].claims).toHaveLength(1);
    expect(result.candidates[0].claims[0].claim).toContain("韩欣欣");
    expect(result.candidates[0].claims[0].claim).not.toContain("华东理工大学");
    expect(result.candidates[0].claims[0].snippet).toContain("韩欣欣");
  });

  it("rejects a shared-page candidate whose name is absent from the saved result", () => {
    const result = resolveCandidateExtraction({
      project,
      searchResults: [
        {
          title: "AI conference speakers",
          url: "https://conference.example/speakers",
          snippet: "Speakers: Ada Chen; Li Wei.",
          domain: "conference.example",
        },
      ],
      extraction: {
        ok: true,
        candidates: [
          {
            name: "Invented Speaker",
            title: "Speaker",
            affiliation: null,
            sourceUrl: "https://conference.example/speakers",
            domainTags: ["AI"],
            languages: [],
            region: null,
            evidenceLevel: "E2",
            risks: [],
            claims: [],
          },
        ],
      },
    });

    expect(result.candidates).toEqual([]);
    expect(result.rejectedCandidates).toBe(1);
  });

  it("keeps a zero-candidate result explicit when neither model nor fallback found a person", () => {
    const result = resolveCandidateExtraction({
      project,
      searchResults: [
        {
          title: "中文文本标注质量白皮书",
          url: "https://example.com/annotation-quality-report",
          snippet: "行业资料与方法概览。",
          domain: "example.com",
        },
      ],
      extraction: { ok: true, candidates: [] },
    });

    expect(result.usedFallback).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.failureReason).toBe("搜索结果中没有识别出明确的个人主页、作者或讲者。");
  });
});

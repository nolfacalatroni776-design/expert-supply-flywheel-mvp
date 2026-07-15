import { describe, expect, it } from "vitest";
import {
  buildCandidateEvidenceQueries,
  filterEvidenceEnrichmentCandidates,
} from "@/lib/candidate-evidence-enrichment";

describe("candidate evidence enrichment queries", () => {
  it("targets E2+ candidates that still lack an institution profile", () => {
    const queries = buildCandidateEvidenceQueries([
      {
        expert: { name: "Junjie Hu", affiliation: "Tongji University", evidenceLevel: "E2" },
        evidenceItems: [{ sourceType: "openalex_api", sourceUrl: "https://openalex.org/W1", claim: "论文作者" }],
      },
      {
        expert: { name: "Ong Choon Kiat", affiliation: "NCCS", evidenceLevel: "E1" },
        evidenceItems: [],
      },
      {
        expert: { name: "Lai Guan Ng", affiliation: "A*STAR", evidenceLevel: "E2" },
        evidenceItems: [
          {
            sourceType: "institution_profile",
            sourceUrl: "https://www.a-star.edu.sg/researcher/lai-guan-ng",
            claim: "机构公开人员页面",
          },
        ],
      },
    ]);

    expect(queries).toEqual(['"Junjie Hu" "Tongji University" institution profile']);
  });

  it("deduplicates candidates and caps a single approved batch at four queries", () => {
    const candidates = ["Ada One", "Ada Two", "Ada Three", "Ada Four", "Ada Five", "Ada One"].map((name) => ({
      expert: { name, affiliation: null, evidenceLevel: "E3" },
      evidenceItems: [],
    }));

    expect(buildCandidateEvidenceQueries(candidates)).toEqual([
      '"Ada One" institution profile',
      '"Ada Two" institution profile',
      '"Ada Three" institution profile',
      '"Ada Four" institution profile',
    ]);
  });
});

describe("candidate evidence enrichment acceptance", () => {
  it("keeps only approved names backed by an institution personnel page", () => {
    const candidates = [
      {
        name: "Junjie Hu",
        sourceUrl: "https://www.tongji.edu.cn/faculty/junjie-hu",
        claims: [{ sourceType: "institution_profile", sourceUrl: "https://www.tongji.edu.cn/faculty/junjie-hu" }],
      },
      {
        name: "Qingzhu Jia",
        sourceUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9065032/",
        claims: [{ sourceType: "institution_profile", sourceUrl: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9065032/" }],
      },
      {
        name: "Yonglun Luo",
        sourceUrl: "https://www.bgi.com/people/yonglun-luo",
        claims: [{ sourceType: "institution_profile", sourceUrl: "https://www.bgi.com/people/yonglun-luo" }],
      },
    ];
    const searchResults = [
      {
        title: "Junjie Hu - Faculty",
        url: "https://www.tongji.edu.cn/faculty/junjie-hu",
        snippet: "Junjie Hu is a faculty member at Tongji University.",
        domain: "tongji.edu.cn",
      },
      {
        title: "Research article",
        url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC9065032/",
        snippet: "Qingzhu Jia is a corresponding author.",
        domain: "pmc.ncbi.nlm.nih.gov",
      },
      {
        title: "Yonglun Luo",
        url: "https://www.bgi.com/people/yonglun-luo",
        snippet: "Yonglun Luo is a BGI researcher.",
        domain: "bgi.com",
      },
    ];

    expect(
      filterEvidenceEnrichmentCandidates({
        candidates,
        searchResults,
        approvedNames: ["Junjie Hu", "Qingzhu Jia"],
      }).map((candidate) => candidate.name),
    ).toEqual(["Junjie Hu"]);
  });
});

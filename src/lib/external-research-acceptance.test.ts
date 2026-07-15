import { describe, expect, it } from "vitest";
import {
  buildInstructionSourceQueries,
  buildPersonaSourceQueries,
  buildExternalResearchAcceptancePreview,
  evaluateExternalResearchAcceptance,
  selectExternalResearchQueries,
} from "@/lib/external-research-acceptance";

const softwareProject = {
  title: "Python 后端代码评审专家招募",
  rawDemand: "为 Python 后端代码评审任务招募 30 位 FastAPI、Django、工程质量方向专家。",
  domain: "software",
  riskLevel: "medium",
  quantity: 30,
};

const medicalProject = {
  title: "肺结节 CT 标注医生招募",
  rawDemand: "为肺结节 CT 标注招募 50 位放射科医生，需要医学影像背景和人工复核。",
  domain: "medical",
  riskLevel: "high",
  quantity: 50,
};

describe("buildExternalResearchAcceptancePreview", () => {
  it("turns queries into a business-facing coverage preview before external search", () => {
    const preview = buildExternalResearchAcceptancePreview({
      project: softwareProject,
      queries: [
        "FastAPI maintainer GitHub Python backend",
        "Python backend conference speaker code review",
        "Django consultant public profile",
        "Python 工程质量 专家 社区",
      ],
      cachedQueries: ["Django consultant public profile"],
    });

    expect(preview.queryCount).toBe(4);
    expect(preview.cached).toBe(1);
    expect(preview.uncached).toBe(3);
    expect(preview.coverageLabels).toContain("开源社区");
    expect(preview.coverageLabels).toContain("会议与演讲");
    expect(preview.acceptanceChecks).toContain("来源覆盖不少于 3 类。");
    expect(preview.needsReview.join(" ")).not.toContain("Serper");
  });
});

describe("selectExternalResearchQueries", () => {
  it("keeps an explicit user source direction in the approved tool plan", () => {
    const githubQuery = "Python FastAPI Django GitHub maintainer";
    const queries = selectExternalResearchQueries({
      project: softwareProject,
      gapQueries: [],
      projectQueries: ["Python backend code review expert profile", "Python backend expert public page"],
      instructionQueries: [githubQuery],
      directionQueries: [
        "Python backend institution experts",
        "Python backend conference speakers",
        "Python backend industry association experts",
      ],
      maxQueries: 4,
    });

    expect(queries).toContain(githubQuery);
  });

  it("prioritizes an authoritative GitHub maintainer query over shorter generic profile queries", () => {
    const queries = selectExternalResearchQueries({
      project: softwareProject,
      gapQueries: ["Python backend institution expert"],
      projectQueries: [
        "SQLAlchemy Python backend maintainer profile",
        "Python FastAPI GitHub maintainer",
        "Python backend conference speaker",
      ],
      directionQueries: ["Python backend paper author"],
      maxQueries: 4,
    });

    expect(queries[0]).toBe("Python FastAPI GitHub maintainer");
  });

  it("preserves the user's first source preference before adding diverse directions", () => {
    const queries = selectExternalResearchQueries({
      project: softwareProject,
      gapQueries: [],
      projectQueries: ["Python backend expert profile"],
      instructionQueries: [
        "Python FastAPI Django GitHub maintainer",
        "Python FastAPI Django conference speaker",
      ],
      directionQueries: ["Python backend institution experts"],
      maxQueries: 4,
    });

    expect(queries[0]).toBe("Python FastAPI Django GitHub maintainer");
    expect(queries[1]).toBe("Python FastAPI Django conference speaker");
  });

  it("preserves every explicit source request when it fits within the approved query limit", () => {
    const explicitQueries = [
      "Cilium GitHub maintainer",
      "Cilium Hubble GitHub maintainer",
      "Kubernetes eBPF conference speaker",
      "Kubernetes eBPF paper author",
    ];
    const queries = selectExternalResearchQueries({
      project: softwareProject,
      gapQueries: [],
      projectQueries: ["Kubernetes eBPF expert profile"],
      instructionQueries: explicitQueries,
      directionQueries: ["Kubernetes eBPF institution experts"],
      maxQueries: 4,
    });

    expect(queries).toEqual(explicitQueries);
  });

  it("keeps project hard-evidence searches when the operator adds broader public-profile directions", () => {
    const project = {
      ...softwareProject,
      taskType: "代码评审 / 标注质检",
      rawDemand:
        "为企业级 Python 后端代码评审任务招募专家，要求熟悉 FastAPI、Django、SQLAlchemy、测试质量和代码安全。",
      personaJson: JSON.stringify({
        taskFitSignals: ["GitHub 仓库中有 FastAPI 或 Django 的近期维护和代码评审记录"],
        evidenceRequirements: ["提供可核验的漏洞修复 PR、提交或代码评审记录"],
      }),
    };
    const hardRequirementQueries = buildPersonaSourceQueries(project);
    const operatorQueries = buildInstructionSourceQueries(
      "Python FastAPI Django 代码评审",
      "补充公开个人主页和机构团队成员，优先核验近期活跃情况。",
    );

    const queries = selectExternalResearchQueries({
      project,
      gapQueries: [],
      projectQueries: ["Python backend code review expert profile"],
      hardRequirementQueries,
      instructionQueries: operatorQueries,
      directionQueries: ["Python backend conference speaker"],
      maxQueries: 4,
    });

    expect(queries).toHaveLength(4);
    expect(queries).toContain("Python FastAPI GitHub maintainer");
    expect(queries).toContain("Python Django GitHub maintainer");
    expect(queries).toContain("Python FastAPI Django 代码评审 institution team member profile");
    expect(queries).toContain("Python FastAPI Django 代码评审 expert profile");
  });

  it("does not spend the approved plan on repeated institution-profile directions", () => {
    const project = {
      ...softwareProject,
      taskType: "代码评审",
      personaJson: JSON.stringify({
        evidenceRequirements: ["候选必须有机构团队公开主页"],
      }),
    };
    const hardRequirementQueries = buildPersonaSourceQueries(project);
    const operatorQueries = buildInstructionSourceQueries(
      "Python 后端代码评审",
      "只从机构团队主页和公开专家主页补充候选。",
    );

    const queries = selectExternalResearchQueries({
      project,
      gapQueries: [],
      projectQueries: ["Python backend code review expert profile"],
      hardRequirementQueries,
      instructionQueries: operatorQueries,
      directionQueries: [
        "Python backend conference speaker",
        "Python backend paper author",
        "Python backend industry association expert",
      ],
      maxQueries: 4,
    });

    const preview = buildExternalResearchAcceptancePreview({ project, queries, cachedQueries: [] });
    expect(queries).toHaveLength(4);
    expect(queries.filter((query) => /institution|team member/i.test(query))).toHaveLength(1);
    expect(preview.sourceCoverage).toEqual(
      expect.arrayContaining(["institution", "professional_profile", "conference", "publication"]),
    );
  });

  it("does not spend a diverse-source slot on a duplicate GitHub maintainer query", () => {
    const queries = selectExternalResearchQueries({
      project: softwareProject,
      gapQueries: ["Python backend institution team member profile"],
      projectQueries: ["FastAPI maintainer GitHub profile Python backend"],
      instructionQueries: ["Python FastAPI GitHub maintainer", "Python Django GitHub maintainer"],
      directionQueries: [
        "Python FastAPI Django conference speaker",
        "Python backend institution team member profile",
      ],
      maxQueries: 4,
    });

    expect(queries).toContain("Python FastAPI GitHub maintainer");
    expect(queries).toContain("Python Django GitHub maintainer");
    expect(queries).toContain("Python FastAPI Django conference speaker");
    expect(queries).toContain("Python backend institution team member profile");
    expect(queries).not.toContain("FastAPI maintainer GitHub profile Python backend");
  });

  it("keeps project-specific queries before generic direction queries", () => {
    const queries = selectExternalResearchQueries({
      project: {
        title: "线上 UI 跳转回归",
        rawDemand: "需要熟悉中文文本质量评估、标注指南拆解、一致性审核和试标反馈的专家。",
        domain: "未分类领域",
        riskLevel: "medium",
        quantity: 2,
      },
      gapQueries: [],
      projectQueries: [
        "\"中文文本\" \"标注指南\" \"质量评估\" 数据标注 专家",
        "\"一致性审核\" \"标注指南拆解\" \"数据标注\" 中文文本",
        "\"试标反馈\" \"标注评审\" \"一致性\" 中文 文本标注",
      ],
      directionQueries: [
        "未分类领域 机构主页 专家",
        "未分类领域 会议 讲者 专家",
        "未分类领域 论文 作者 专家",
      ],
      maxQueries: 4,
    });

    expect(queries.some((query) => query.includes("中文文本") || query.includes("一致性审核"))).toBe(true);
    expect(queries.filter((query) => query.includes("未分类领域"))).toHaveLength(0);
    expect(
      queries.filter((query) => /个人主页|专家简介|讲者|作者|团队成员|profile|speaker|author|maintainer|github user/i.test(query)),
    ).toHaveLength(2);
  });

  it("reserves at least half of the external-search plan for people-discovery queries", () => {
    const queries = selectExternalResearchQueries({
      project: {
        title: "中文文本标注质量专家招募",
        rawDemand: "需要熟悉中文文本标注指南、一致性审核和试标反馈的专家。",
        domain: "数据标注",
        riskLevel: "medium",
        quantity: 4,
      },
      gapQueries: ["中文文本 标注质量 论文 作者", "中文文本 标注质量 专家 个人主页"],
      projectQueries: [
        '"中文文本" "标注指南" "质量评估"',
        '"标注一致性" "试标反馈" 数据标注',
      ],
      directionQueries: ["中文 NLP 标注质量 会议 讲者", "中文 NLP 标注质量 机构团队成员"],
      maxQueries: 4,
    });

    const peopleQueries = queries.filter((query) =>
      /个人主页|专家简介|讲者|作者|团队成员|profile|speaker|author|maintainer|github user/i.test(query),
    );
    expect(queries).toHaveLength(4);
    expect(peopleQueries.length).toBeGreaterThanOrEqual(2);
  });

  it("prefers diverse source directions over repeating long gap descriptions", () => {
    const queries = selectExternalResearchQueries({
      project: medicalProject,
      gapQueries: [
        "医学影像 内部专家库当前仅召回 1 位符合条件的放射科医生，距离项目目标 50 位存在 49 人的巨大缺口。专家 公开资料",
        "医学影像 当前已记录明确联系许可的候选仅 1 位，无法支撑批量招募。专家 公开资料",
        "医学影像 缺少主任医师级别候选和肺结节 AI 标注质控经验。专家 公开资料",
      ],
      projectQueries: [
        "肺结节 CT 放射科 医生 三甲医院 公开主页",
        "lung nodule CT radiologist publication",
        "医学影像 会议 讲者 肺结节",
      ],
      directionQueries: [
        "医学影像 行业协会 专家",
        "医学影像 专家 公开主页",
      ],
      maxQueries: 4,
    });
    const preview = buildExternalResearchAcceptancePreview({ project: medicalProject, queries, cachedQueries: [] });

    expect(queries).toHaveLength(4);
    expect(preview.sourceCoverage.length).toBeGreaterThanOrEqual(3);
    expect(queries.filter((query) => query.length > 80)).toHaveLength(0);
  });
});

describe("buildInstructionSourceQueries", () => {
  it("translates explicit source preferences into bounded people-search queries", () => {
    expect(
      buildInstructionSourceQueries(
        "Python 开源后端",
        "优先查找 GitHub 维护者和贡献者的个人主页，不要泛行业文章。",
      ),
    ).toEqual([
      "Python 开源后端 GitHub maintainer",
      "Python 开源后端 expert profile",
    ]);
  });

  it("splits distinct frameworks into separate GitHub maintainer searches", () => {
    expect(
      buildInstructionSourceQueries(
        "Python FastAPI Django 代码评审",
        "优先查找 FastAPI 和 Django 的 GitHub 开源维护者，也检查会议讲者。",
      ).slice(0, 3),
    ).toEqual([
      "Python FastAPI GitHub maintainer",
      "Python Django GitHub maintainer",
      "Python FastAPI Django 代码评审 conference speaker",
    ]);
  });

  it("turns Cilium and Hubble plus conference and paper requests into four targeted people searches", () => {
    expect(
      buildInstructionSourceQueries(
        "Kubernetes eBPF 网络可观测性",
        "从 GitHub 优先寻找 Cilium、Hubble 维护者与贡献者，同时补充会议讲者和论文作者，只保留公开主页。",
      ),
    ).toEqual([
      "Cilium GitHub maintainer",
      "Cilium Hubble GitHub maintainer",
      "Kubernetes eBPF 网络可观测性 conference speaker",
      "Kubernetes eBPF 网络可观测性 paper author",
    ]);
  });

  it("does not forward an unrelated instruction as a raw search query", () => {
    expect(buildInstructionSourceQueries("Python 开源后端", "请尽快完成，token=secret-value")).toEqual([]);
  });

  it("keeps named conferences, geography, publications, and institution profiles in a medical search plan", () => {
    const queries = buildInstructionSourceQueries(
      "肿瘤免疫与单细胞组学",
      "请从机构团队主页、近五年论文作者、AACR 或 ASCO 会议讲者三个方向补充候选，优先中国和新加坡。",
    );

    expect(queries).toHaveLength(4);
    expect(queries).toContain("肿瘤免疫与单细胞组学 AACR conference speaker China Singapore");
    expect(queries).toContain("肿瘤免疫与单细胞组学 ASCO conference speaker China Singapore");
    expect(queries).toContain("肿瘤免疫与单细胞组学 recent 5 years paper author China Singapore");
    expect(queries).toContain("肿瘤免疫与单细胞组学 institution team member profile China Singapore");
  });
});

describe("buildPersonaSourceQueries", () => {
  it("recovers hard evidence directions from legacy raw demand when the stored persona is generic", () => {
    const queries = buildPersonaSourceQueries({
      domain: "Python 开源后端",
      taskType: "代码审查与模型反馈",
      rawDemand:
        "招募 3 位活跃的 Python 开源后端专家，要求熟悉 FastAPI、Django 和代码审查，优先有公开 GitHub 维护或贡献记录。",
      personaJson: JSON.stringify({
        evidenceRequirements: ["公开主页", "作品/论文/项目证据", "机构或职业背景证明"],
      }),
    });

    expect(queries).toContain("Python FastAPI GitHub maintainer");
    expect(queries).toContain("Python Django GitHub maintainer");
  });

  it("does not turn a negated source requirement into a mandatory search direction", () => {
    const queries = buildPersonaSourceQueries({
      domain: "Python 后端",
      taskType: "代码评审",
      rawDemand: "招募 Python 后端专家，不要求 GitHub 贡献记录，仅根据脱敏试标结果判断。",
      personaJson: JSON.stringify({ evidenceRequirements: ["试标结果"] }),
    });

    expect(queries.some((query) => /github/i.test(query))).toBe(false);
  });

  it("turns GitHub contribution requirements into named maintainer searches", () => {
    expect(
      buildPersonaSourceQueries({
        domain: "Python 后端",
        taskType: "代码安全评审",
        rawDemand: "招募 FastAPI、Django、SQLAlchemy 代码安全评审专家。",
        personaJson: JSON.stringify({
          taskFitSignals: ["GitHub 仓库中有 FastAPI 或 Django 安全加固提交记录"],
          evidenceRequirements: ["提供漏洞修复 PR 或代码评审记录"],
        }),
      }),
    ).toEqual(["Python FastAPI GitHub maintainer", "Python Django GitHub maintainer"]);
  });

  it("does not forward the raw project demand into a GitHub people query", () => {
    const queries = buildPersonaSourceQueries({
      domain: "Python 后端",
      taskType: "代码评审 / 标注质检",
      rawDemand:
        "为企业级 Python 后端代码评审任务招募 3 位专家，要求熟悉 FastAPI、Django、SQLAlchemy、测试质量、代码安全和工程规范。",
      personaJson: JSON.stringify({
        taskFitSignals: ["具备可核验的代码评审经验"],
        evidenceRequirements: ["提供公开 GitHub 主页或仓库链接"],
      }),
    });

    expect(queries).toEqual(["Python FastAPI GitHub maintainer", "Python Django GitHub maintainer"]);
    expect(queries.join(" ")).not.toContain("为企业级");
    expect(queries.every((query) => query.length <= 64)).toBe(true);
  });
});

describe("evaluateExternalResearchAcceptance", () => {
  it("passes a useful software search run with diverse sources and E2+ candidates", () => {
    const report = evaluateExternalResearchAcceptance({
      project: softwareProject,
      queries: [
        "FastAPI maintainer GitHub Python backend",
        "Python backend conference speaker code review",
        "Django consultant public profile",
        "Python 工程质量 专家 社区",
      ],
      cacheHits: ["Django consultant public profile"],
      providerStats: { serper: 16, github: 6 },
      searchResults: [
        { title: "Ada FastAPI", url: "https://github.com/ada-fastapi", snippet: "Python maintainer", domain: "github.com" },
        { title: "PyCon Speaker", url: "https://pycon.example/speakers/lin", snippet: "backend performance talk", domain: "pycon.example" },
        { title: "Django Consultant", url: "https://consultants.example/li", snippet: "code review services", domain: "consultants.example" },
        { title: "Engineering community", url: "https://community.example/python", snippet: "review mentors", domain: "community.example" },
      ],
      candidates: [
        { expert: { evidenceLevel: "E3" }, humanReviewNeeded: false, sourceType: "external" },
        { expert: { evidenceLevel: "E2" }, humanReviewNeeded: false, sourceType: "external" },
        { expert: { evidenceLevel: "E1" }, humanReviewNeeded: true, sourceType: "external" },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.e2PlusCandidates).toBe(2);
    expect(report.reviewRequiredCandidates).toBe(1);
    expect(report.sourceCoverage.length).toBeGreaterThanOrEqual(3);
    expect(report.nextActions).toContain("优先复核 E2+ 候选，并更新候选排序。");
  });

  it("fails a noisy run without high-evidence candidates and gives concrete recovery actions", () => {
    const report = evaluateExternalResearchAcceptance({
      project: softwareProject,
      queries: ["Python expert"],
      cacheHits: [],
      providerStats: { serper: 8 },
      searchResults: [
        { title: "Python tutorial", url: "https://blog.example/python", snippet: "generic article", domain: "blog.example" },
      ],
      candidates: [{ expert: { evidenceLevel: "E1" }, humanReviewNeeded: true, sourceType: "external" }],
    });

    expect(report.passed).toBe(false);
    expect(report.blockers).toContain("高证据候选不足。");
    expect(report.blockers).toContain("查询方向覆盖不足。");
    expect(report.nextActions.join(" ")).toContain("补充机构主页、论文/会议、专业社区等搜索方向");
  });

  it("keeps regulated medical discovery review-first even when the run finds E2+ candidates", () => {
    const report = evaluateExternalResearchAcceptance({
      project: medicalProject,
      queries: [
        "肺结节 CT 放射科 医生 三甲医院 公开主页",
        "lung nodule CT radiologist publication",
        "医学影像 会议 讲者 肺结节",
        "放射科 专家 简介 肺结节",
      ],
      cacheHits: [],
      providerStats: { serper: 24, openalex: 8 },
      searchResults: [
        { title: "医院影像科医生", url: "https://hospital.example/radiology/chen", snippet: "肺结节 CT", domain: "hospital.example" },
        { title: "OpenAlex publication", url: "https://openalex.org/W1", snippet: "Authors: Dr Chen", domain: "openalex.org" },
        { title: "医学会议讲者", url: "https://conference.example/speakers/chen", snippet: "胸部影像", domain: "conference.example" },
      ],
      candidates: [
        { expert: { evidenceLevel: "E3" }, humanReviewNeeded: true, sourceType: "external" },
        { expert: { evidenceLevel: "E2" }, humanReviewNeeded: true, sourceType: "external" },
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.needsReview).toContain("高风险项目下，公开候选需完成资质与触达许可复核。");
    expect(report.outreachReadyCandidates).toBe(0);
  });

  it("does not tell operators to advance outreach when every candidate still needs review", () => {
    const report = evaluateExternalResearchAcceptance({
      project: softwareProject,
      queries: [
        "FastAPI maintainer GitHub Python backend",
        "Python backend conference speaker code review",
        "Django consultant public profile",
      ],
      cacheHits: [],
      providerStats: { serper: 18 },
      searchResults: [
        { title: "Maintainer", url: "https://github.com/example", snippet: "FastAPI contributor", domain: "github.com" },
        { title: "Speaker", url: "https://conference.example/speaker", snippet: "Python speaker", domain: "conference.example" },
        { title: "Profile", url: "https://consulting.example/profile", snippet: "Django consultant", domain: "consulting.example" },
      ],
      candidates: [
        { expert: { evidenceLevel: "E2" }, humanReviewNeeded: true, sourceType: "external" },
        { expert: { evidenceLevel: "E2" }, humanReviewNeeded: true, sourceType: "external" },
      ],
    });

    expect(report.outreachReadyCandidates).toBe(0);
    expect(report.nextActions.join(" ")).toContain("完成候选复核和联系许可确认");
    expect(report.nextActions.join(" ")).not.toContain("把可触达候选推进");
  });

  it("does not count publication authors as satisfying explicit code-review and GitHub evidence requirements", () => {
    const report = evaluateExternalResearchAcceptance({
      project: {
        ...softwareProject,
        quantity: 3,
        personaJson: JSON.stringify({
          mustHave: ["5 年以上 Python 后端开发经验", "具备企业级代码评审经验"],
          evidenceRequirements: ["GitHub 上的 FastAPI、Django 或 SQLAlchemy 实质性贡献记录"],
        }),
      },
      queries: [
        "Python FastAPI GitHub maintainer",
        "Python backend conference speaker",
        "Python backend paper author",
      ],
      cacheHits: [],
      providerStats: { openalex: 8, serper: 16 },
      searchResults: [
        {
          title: "Benchmarking the performance of Python web frameworks",
          url: "https://openalex.org/W1",
          snippet: "Authors: Example Author. Source: Journal.",
          domain: "openalex.org",
          query: "Python backend paper author",
        },
      ],
      candidates: [
        {
          expert: { evidenceLevel: "E2", sourceUrl: "https://openalex.org/W1" },
          humanReviewNeeded: true,
          sourceType: "external",
          evidenceItems: [
            {
              sourceType: "openalex_api",
              sourceUrl: "https://openalex.org/W1",
              sourceTitle: "Benchmarking the performance of Python web frameworks",
              claim: "Example Author 列于论文作者名单",
              snippet: "Authors: Example Author.",
            },
          ],
        },
      ],
    });

    expect(report.hardRequirementReadyCandidates).toBe(0);
    expect(report.candidateHardRequirements).toEqual(
      expect.arrayContaining(["代码评审经历", "GitHub 实质贡献", "可核验的经验年限"]),
    );
    expect(report.passed).toBe(false);
  });

  it("marks the run incomplete when an explicitly searched source produced no candidate", () => {
    const report = evaluateExternalResearchAcceptance({
      project: {
        title: "Kubernetes eBPF 专家招募",
        rawDemand: "需要 Cilium、Hubble 和 eBPF 网络可观测性专家。",
        domain: "Kubernetes eBPF",
        riskLevel: "medium",
        quantity: 4,
      },
      queries: ["Cilium GitHub maintainer", "Kubernetes eBPF conference speaker", "Kubernetes eBPF paper author"],
      cacheHits: [],
      providerStats: { github: 6, serper: 16 },
      searchResults: [
        {
          title: "Thomas Graf GitHub profile",
          url: "https://github.com/tgraf",
          snippet: "Repository evidence: 2754 contributions to cilium/cilium.",
          domain: "github.com",
          query: "Cilium GitHub maintainer",
        },
        {
          title: "eBPF observability conference article",
          url: "https://conference.example/ebpf",
          snippet: "Conference recap without a named speaker profile.",
          domain: "conference.example",
          query: "Kubernetes eBPF conference speaker",
        },
      ],
      candidates: [
        {
          expert: { evidenceLevel: "E2", sourceUrl: "https://github.com/tgraf" },
          humanReviewNeeded: true,
          sourceType: "external",
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.candidateSourceCoverage).toEqual(["community"]);
    expect(report.unmetSourceCoverage).toEqual(["conference", "publication"]);
    expect(report.blockers).toContain("会议讲者方向未产出可复核候选。");
    expect(report.blockers).toContain("论文作者方向未产出可复核候选。");
    expect(report.nextActions.join(" ")).toContain("调整未产出候选的来源搜索词");
  });

  it("does not count a conference candidate as publication-author coverage", () => {
    const report = evaluateExternalResearchAcceptance({
      project: medicalProject,
      queries: ["AACR conference speaker", "single cell paper author", "hospital team member profile"],
      cacheHits: [],
      providerStats: { serper: 8, openalex: 8 },
      searchResults: [
        {
          title: "AACR speakers",
          url: "https://conference.example/speakers/chen",
          snippet: "Dr Chen, conference speaker",
          query: "AACR conference speaker",
        },
        {
          title: "Publication",
          url: "https://openalex.org/W1",
          snippet: "Authors: Li Wei",
          query: "single cell paper author",
        },
      ],
      candidates: [
        {
          expert: { evidenceLevel: "E2", sourceUrl: "https://conference.example/speakers/chen" },
          humanReviewNeeded: true,
          sourceType: "external",
        },
      ],
    });

    expect(report.candidateSourceCoverage).toContain("conference");
    expect(report.unmetSourceCoverage).toContain("publication");
    expect(report.blockers).toContain("论文作者方向未产出可复核候选。");
  });

  it("classifies a speaker page by its actual content instead of the query that happened to return it", () => {
    const report = evaluateExternalResearchAcceptance({
      project: medicalProject,
      queries: ["AACR conference speaker", "hospital institution team member profile"],
      cacheHits: [],
      providerStats: { serper: 8 },
      searchResults: [
        {
          title: "Speaker: Cell Symposium",
          url: "https://cell-symposium.example/bio-ng",
          snippet: "Speaker Lai Guan Ng, Singapore Immunology Network.",
          query: "hospital institution team member profile",
        },
      ],
      candidates: [
        {
          expert: { evidenceLevel: "E1", sourceUrl: "https://cell-symposium.example/bio-ng" },
          humanReviewNeeded: true,
          sourceType: "external",
        },
      ],
    });

    expect(report.candidateSourceCoverage).toContain("conference");
    expect(report.candidateSourceCoverage).not.toContain("institution");
    expect(report.unmetSourceCoverage).toContain("institution");
    expect(report.unmetSourceCoverage).not.toContain("professional_profile");
  });

  it("does not pass when different people separately satisfy a per-candidate institutional-profile requirement", () => {
    const report = evaluateExternalResearchAcceptance({
      project: {
        title: "单细胞肿瘤免疫专家招募",
        rawDemand:
          "招募论文作者和会议讲者，并且所有候选必须有大学、医院或研究机构公开团队主页。",
        domain: "肿瘤免疫与单细胞组学",
        riskLevel: "regulated",
        quantity: 5,
      },
      queries: [
        "single-cell tumor immunology paper author",
        "AACR conference speaker",
        "institution team member profile",
      ],
      cacheHits: [],
      providerStats: { openalex: 8, serper: 16 },
      searchResults: [
        {
          title: "Single-cell cancer paper",
          url: "https://openalex.org/W1",
          snippet: "Authors: Paper Author (Example University).",
          query: "single-cell tumor immunology paper author",
        },
        {
          title: "Assoc Prof Profile Person",
          url: "https://example.edu/researcher/profile-person",
          snippet: "Profile Person is a principal investigator.",
          query: "institution team member profile",
        },
        {
          title: "Conference speaker",
          url: "https://conference.example/speaker/person",
          snippet: "Speaker Conference Person.",
          query: "AACR conference speaker",
        },
      ],
      candidates: [
        {
          expert: { evidenceLevel: "E2", sourceUrl: "https://openalex.org/W1" },
          humanReviewNeeded: true,
          sourceType: "external",
          evidenceItems: [{ sourceType: "openalex_api", sourceUrl: "https://openalex.org/W1" }],
        },
        {
          expert: { evidenceLevel: "E1", sourceUrl: "https://example.edu/researcher/profile-person" },
          humanReviewNeeded: true,
          sourceType: "external",
          evidenceItems: [
            { sourceType: "institution_profile", sourceUrl: "https://example.edu/researcher/profile-person" },
          ],
        },
        {
          expert: { evidenceLevel: "E1", sourceUrl: "https://conference.example/speaker/person" },
          humanReviewNeeded: true,
          sourceType: "external",
          evidenceItems: [
            { sourceType: "public_event_page", sourceUrl: "https://conference.example/speaker/person" },
          ],
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.sourceCoverage).toEqual(["publication", "conference", "institution"]);
    expect(report.coverageLabels).toEqual(["论文作者", "会议与演讲", "机构主页"]);
    expect(report.hardRequirementReadyCandidates).toBe(0);
    expect(report.candidateHardRequirements).toEqual(["机构公开主页"]);
    expect(report.blockers).toContain("没有候选同时满足高证据和机构公开主页硬条件。");
    expect(report.nextActions.join(" ")).toContain("同一候选");
  });
});

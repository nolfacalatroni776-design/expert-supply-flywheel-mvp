import { describe, expect, it } from "vitest";
import { canApproveForOutreach, getInitialProjectRiskLevel, requiresProjectReview } from "./gates";

describe("getInitialProjectRiskLevel", () => {
  it("marks regulated medical demand before AI analysis runs", () => {
    expect(
      getInitialProjectRiskLevel({
        rawDemand: "招募肿瘤免疫与单细胞组学专家，评审医院来源的单细胞数据。",
        domain: "肿瘤免疫",
        taskType: "医学研究数据评审",
      }),
    ).toBe("regulated");
  });

  it("keeps ordinary software work at medium risk", () => {
    expect(
      getInitialProjectRiskLevel({
        rawDemand: "招募 Python 后端专家进行 FastAPI 代码评审。",
        domain: "软件工程",
        taskType: "代码评审",
      }),
    ).toBe("medium");
  });

  it("does not treat ordinary code security review as a regulated industry", () => {
    expect(
      getInitialProjectRiskLevel({
        rawDemand: "招募 Python 后端专家检查 OWASP、代码安全和自动化测试质量。",
        domain: "Python 后端",
        taskType: "代码安全评审",
      }),
    ).toBe("medium");
  });

  it("still treats explicitly safety-critical software as regulated", () => {
    expect(
      getInitialProjectRiskLevel({
        rawDemand: "招募专家评审自动驾驶安全关键控制软件。",
        domain: "自动驾驶",
        taskType: "安全关键系统评审",
      }),
    ).toBe("regulated");
  });
});

const baseExpert = {
  evidenceLevel: "E2",
  consentState: "unknown",
  contactJson: JSON.stringify({ email: "expert@example.com", contactPermissionBasis: "direct_consent" }),
  sourceUrl: "https://example.com/profile",
};
const baseCandidate = { risksJson: JSON.stringify([]), humanReviewNeeded: false, fitScore: 82, stage: "verified" };

describe("canApproveForOutreach", () => {
  it("allows E2 candidates with a contact path", () => {
    expect(canApproveForOutreach({ candidate: baseCandidate, expert: baseExpert })).toEqual({ ok: true });
  });

  it("blocks candidates still requiring human review", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, humanReviewNeeded: true },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "该候选需完成人工复核后才能生成触达草稿。" });
  });

  it("allows a low-scoring candidate after explicit human verification", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, fitScore: 74 },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: true });
  });

  it("keeps a low-scoring candidate behind review before verification", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, fitScore: 74, stage: "sourced" },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "匹配评分低于 75 分，需人工复核通过后才能生成触达草稿。" });
  });

  it("blocks candidates without a score", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, fitScore: null },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "请先完成匹配评分，再生成触达草稿。" });
  });

  it("blocks low evidence candidates", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: { ...baseExpert, evidenceLevel: "E1" },
    });
    expect(result).toEqual({ ok: false, reason: "证据等级需达到 E2 后才能生成触达草稿。" });
  });

  it("blocks opt-outs", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: { ...baseExpert, consentState: "do_not_contact" },
    });
    expect(result).toEqual({ ok: false, reason: "候选已退订、不再联系或请求删除资料，不能触达。" });
  });

  it("blocks missing contact path", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: { ...baseExpert, contactJson: "{}", sourceUrl: null },
    });
    expect(result).toEqual({ ok: false, reason: "缺少合规联系路径或明确联系许可；公开主页不等于可触达许可。" });
  });

  it("does not treat email as compliant without permission basis", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: { ...baseExpert, contactJson: JSON.stringify({ email: "expert@example.com" }) },
    });
    expect(result).toEqual({ ok: false, reason: "缺少合规联系路径或明确联系许可；公开主页不等于可触达许可。" });
  });

  it("blocks project-level do-not-contact stage", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, stage: "do_not_contact" },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "该候选在当前项目中已标记为不再联系。" });
  });

  it("blocks candidates screened out for the current project", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, stage: "screened_out" },
      expert: baseExpert,
    });
    expect(result).toEqual({ ok: false, reason: "该候选在当前项目中暂不推进。" });
  });

  it("does not treat a profile URL as a compliant contact path without explicit permission", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: {
        ...baseExpert,
        contactJson: JSON.stringify({ profileUrl: "https://example.com/profile" }),
        sourceUrl: "https://example.com/profile",
      },
    });
    expect(result).toEqual({ ok: false, reason: "缺少合规联系路径或明确联系许可；公开主页不等于可触达许可。" });
  });

  it("allows public profile outreach only when permission basis is explicit", () => {
    const result = canApproveForOutreach({
      candidate: baseCandidate,
      expert: {
        ...baseExpert,
        contactJson: JSON.stringify({
          profileUrl: "https://example.com/profile",
          contactPermissionBasis: "public_outreach_allowed",
        }),
        sourceUrl: "https://example.com/profile",
      },
    });
    expect(result).toEqual({ ok: true });
  });

  it("keeps regulated projects behind human review", () => {
    const result = canApproveForOutreach({
      candidate: { ...baseCandidate, humanReviewNeeded: true },
      expert: baseExpert,
      project: { riskLevel: "regulated", domain: "医学影像" },
    });
    expect(result).toEqual({
      ok: false,
      reason: "高风险或受监管项目需完成人工复核后才能生成触达草稿。",
    });
  });

  it("blocks risks that reference protected or sensitive attributes", () => {
    const result = canApproveForOutreach({
      candidate: {
        ...baseCandidate,
        risksJson: JSON.stringify(["protected attribute used in ranking"]),
      },
      expert: baseExpert,
    });

    expect(result).toEqual({ ok: false, reason: "候选风险记录涉及受保护或敏感属性，需人工处理。" });
  });

  it("treats oncology and hospital research as regulated even when the stored risk is stale", () => {
    expect(requiresProjectReview({ riskLevel: "medium", domain: "肿瘤免疫与单细胞组学" })).toBe(true);
    expect(
      requiresProjectReview({
        riskLevel: "medium",
        domain: "数据评审",
        rawDemand: "招募医院研究人员评审癌症免疫相关数据",
      }),
    ).toBe(true);
  });
});

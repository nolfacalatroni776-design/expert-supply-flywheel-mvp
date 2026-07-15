import { describe, expect, it } from "vitest";
import { normalizeCandidateScore, normalizeLanguageCompatibility } from "@/lib/candidate-scoring";

const baseScore = {
  fitScore: 76,
  evidenceLevel: "E1" as const,
  scoreBreakdown: [
    { dimension: "domain_fit", score: 100, weight: 30, evidence: "Pydantic maintainer", reason: "Direct match" },
    { dimension: "credential_evidence", score: 90, weight: 25, evidence: "GitHub contributions", reason: "Public evidence" },
    { dimension: "task_fit", score: 85, weight: 20, evidence: "Pydantic v2", reason: "Task match" },
    { dimension: "availability_signal", score: 20, weight: 15, evidence: "Unknown", reason: "Availability unknown" },
    { dimension: "communication_fit", score: 30, weight: 5, evidence: "English only", reason: "No Chinese evidence" },
    { dimension: "compliance_risk", score: 40, weight: 5, evidence: "No contact path", reason: "Needs review" },
  ],
  topReasons: ["Direct domain match"],
  risks: ["No evidence of Chinese language proficiency; project explicitly requires both Chinese and English"],
  missingEvidence: ["Chinese language proficiency verification", "Current availability"],
  nextAction: "人工复核证据后决定下一步。",
  humanReviewRequired: true,
};

describe("normalizeLanguageCompatibility", () => {
  it("treats 中英文均可 as either language and removes the false bilingual blocker", () => {
    const result = normalizeLanguageCompatibility({
      project: { rawDemand: "中英文均可，远程协作", languages: ["中文", "英文"] },
      candidate: { languages: ["English"] },
      score: baseScore,
    });

    expect(result.scoreBreakdown.find((item) => item.dimension === "communication_fit")?.score).toBeGreaterThanOrEqual(80);
    expect(result.risks.join(" ")).not.toMatch(/Chinese|中文/i);
    expect(result.missingEvidence.join(" ")).not.toMatch(/Chinese|中文/i);
    expect(result.fitScore).toBeGreaterThan(76);
  });

  it("keeps the bilingual blocker when the demand explicitly requires both languages", () => {
    const result = normalizeLanguageCompatibility({
      project: { rawDemand: "必须同时具备中英文工作能力", languages: ["中文", "英文"] },
      candidate: { languages: ["English"] },
      score: baseScore,
    });

    expect(result).toEqual(baseScore);
  });

  it("removes currency and budget conclusions when the project never specified currency or billing units", () => {
    const score = {
      ...baseScore,
      risks: ["Budget range ($150-300) is below market rate"],
      missingEvidence: ["USD budget confirmation"],
      nextAction: "Deprioritize due to budget mismatch.",
      scoreBreakdown: baseScore.scoreBreakdown.map((item) =>
        item.dimension === "availability_signal"
          ? { ...item, score: 10, reason: "Unlikely to accept a $150-300 contract.", evidence: "Budget $150-300" }
          : item,
      ),
    };

    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Pydantic v2 代码评审专家。", languages: ["中文", "英文"] },
      candidate: { languages: ["English"] },
      score,
    });

    expect(JSON.stringify(result)).not.toMatch(/\$150|USD|budget mismatch/i);
    expect(result.scoreBreakdown.find((item) => item.dimension === "可参与性")?.score).toBeGreaterThanOrEqual(30);
  });

  it("keeps authoritative evidence as the floor and removes positive fit statements from risks", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "中英文均可，招募 Pydantic 代码评审专家。", languages: ["中文", "英文"] },
      candidate: { languages: ["English"], evidenceLevel: "E2" },
      score: {
        ...baseScore,
        evidenceLevel: "E1",
        risks: [
          "domain_fit: Candidate is the creator and maintainer of Pydantic.",
          "credential_evidence: GitHub contributions are directly verifiable.",
          "availability_signal: No availability information is present.",
        ],
      },
    });

    expect(result.evidenceLevel).toBe("E2");
    expect(result.risks).toEqual(["当前可用时间和参与意愿尚未确认。"]);
  });

  it("does not misclassify positive security-review experience as a risk", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Python 后端代码评审专家。", languages: ["中文"] },
      candidate: { languages: ["中文"], evidenceLevel: "E4" },
      score: {
        ...baseScore,
        risks: [
          "task_fit: 历史记录显示完成过代码安全风险审查、工程规范检查和可解释意见输出。",
          "availability_signal: 当前可用时间未知。",
        ],
      },
    });

    expect(result.risks).toEqual(["availability_signal: 当前可用时间未知。"]);
  });

  it("normalizes model language drift across score explanations and actions", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Python 后端代码评审专家。", languages: ["中文"] },
      candidate: { languages: ["中文"], evidenceLevel: "E4" },
      score: {
        ...baseScore,
        risks: ["No conflict-of-interest or NDA evidence on file"],
        missingEvidence: ["Public repository or redacted code review sample"],
        nextAction: "Verify materials before assignment",
      },
    });

    expect(result.risks).toEqual(["利益冲突与保密要求尚未确认。"]);
    expect(result.missingEvidence).toEqual(["缺少公开项目仓库或脱敏代码评审案例。"]);
    expect(result.nextAction).toBe("完成人工复核并补齐必要证据后，再决定是否推进。 ".trim());
    expect(result.scoreBreakdown.every((item) => /[\u3400-\u9fff]/.test(`${item.dimension} ${item.reason} ${item.evidence}`))).toBe(true);
  });

  it("removes stale missing-evidence risks and respects an active trial stage", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Python 后端代码评审专家。", languages: ["中文"] },
      candidate: {
        languages: ["中文"],
        evidenceLevel: "E2",
        evidenceItemCount: 3,
        stage: "trial",
      },
      score: {
        ...baseScore,
        risks: ["当前 evidenceItems 为空，无法核验证据。", "当前可用时间尚未确认。"],
        missingEvidence: ["无证据项，需先补齐 evidenceItems。", "缺少当前参与意愿确认。"],
        nextAction: "安排小规模试标并完成人工复核。",
      },
    });

    expect(result.risks.join(" ")).not.toMatch(/evidenceItems|无证据项|证据为空/i);
    expect(result.missingEvidence.join(" ")).not.toMatch(/evidenceItems|无证据项|证据为空/i);
    expect(result.nextAction).toBe("继续当前试标，记录提交结果并完成人工复核。");
  });

  it("does not recommend outreach or a new trial while the candidate still needs review", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Python 后端代码评审专家。", languages: ["中文"] },
      candidate: {
        languages: ["中文"],
        evidenceLevel: "E2",
        evidenceItemCount: 2,
        stage: "verified",
        humanReviewNeeded: true,
      },
      score: {
        ...baseScore,
        topReasons: [
          "候选具备可核验的 Python 开源贡献。",
          "匹配度较高，可以立即触达并安排试标。",
        ],
        nextAction: "向候选人发送试标邀请并立即启动试标。",
      },
    });

    expect(result.topReasons).toEqual(["候选具备可核验的 Python 开源贡献\u3002"]);
    expect(result.nextAction).toBe(
      "先完成人工复核并补齐必要证据和联系许可，再决定是否生成触达草稿或准备试标材料。",
    );
    expect(`${result.topReasons.join(" ")} ${result.nextAction}`).not.toMatch(/立即触达|发送试标邀请|立即启动试标/);
  });

  it("repairs contradictory review facts, positive risks, and truncated JSON tails", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Python 后端代码评审专家。", languages: ["中文"] },
      candidate: {
        languages: ["中文"],
        evidenceLevel: "E4",
        evidenceItemCount: 2,
        stage: "sourced",
        humanReviewNeeded: true,
      },
      score: {
        ...baseScore,
        scoreBreakdown: baseScore.scoreBreakdown.map((item) =>
          item.dimension === "compliance_risk"
            ? {
                ...item,
                reason: "当前候选人标记为无需人工复核，与项目流程存在潜在偏差。",
                evidence: "联系许可已记录，但仍需人工复核。",
              }
            : item.dimension === "communication_fit"
              ? { ...item, reason: "语言条件满足，仍需验证沟通效率。}],\"" }
              : item,
        ),
        risks: [
          "领域匹配度: 技术栈与项目要求高度一致。",
          "合规风险: 当前候选人标记为无需人工复核，与项目流程存在潜在偏差。",
        ],
      },
    });

    const userFacingText = [
      ...result.scoreBreakdown.flatMap((item) => [item.dimension, item.evidence, item.reason]),
      ...result.topReasons,
      ...result.risks,
      ...result.missingEvidence,
      result.nextAction,
    ].join(" ");
    expect(result.risks).toEqual([]);
    expect(result.scoreBreakdown.find((item) => item.dimension === "合规风险")?.reason).toContain("仍需完成人工复核");
    expect(userFacingText).not.toMatch(/无需人工复核|\}\],\"/);
  });

  it("does not describe a sourced candidate as already in trial or already permitted for outreach", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Python 后端代码评审专家。", languages: ["英文"] },
      candidate: {
        languages: ["英文"],
        evidenceLevel: "E2",
        evidenceItemCount: 2,
        stage: "sourced",
        humanReviewNeeded: true,
      },
      score: {
        ...baseScore,
        scoreBreakdown: baseScore.scoreBreakdown.map((item) =>
          item.dimension === "availability_signal"
            ? { ...item, evidence: "stage=sourced; availability unknown", reason: "availability unknown" }
            : item.dimension === "compliance_risk"
              ? {
                  ...item,
                  evidence: "consentState=unknown; contactPermissionBasis missing",
                  reason: "humanReviewNeeded=true",
                }
              : item,
        ),
      },
    });

    const availability = result.scoreBreakdown.find((item) => item.dimension === "可参与性");
    const compliance = result.scoreBreakdown.find((item) => item.dimension === "合规风险");
    expect(`${availability?.evidence} ${availability?.reason}`).not.toContain("试标流程");
    expect(`${availability?.evidence} ${availability?.reason}`).toContain("可用时间");
    expect(`${compliance?.evidence} ${compliance?.reason}`).not.toContain("已记录联系许可");
    expect(`${compliance?.evidence} ${compliance?.reason}`).toContain("联系许可");
  });

  it("does not expose internal field names or fixture identifiers in user-facing scoring", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Python 后端代码评审专家。", languages: ["中文", "英文"] },
      candidate: { languages: ["中文", "英文"], evidenceLevel: "E4", evidenceItemCount: 3, stage: "trial" },
      score: {
        ...baseScore,
        scoreBreakdown: [
          {
            dimension: "credential_evidence",
            score: 85,
            weight: 50,
            evidence: "evidenceLevel 为 E4，confidence 0.96，来源为 live_smoke_internal_profile；evidenceItems 中缺少外部案例。",
            reason: "signals 和 domainTags 显示能力匹配，但仍需 humanReviewNeeded。",
          },
          {
            dimension: "compliance_risk",
            score: 88,
            weight: 30,
            evidence: "consentState 为 consented，contactPermissionBasis 为 direct_consent，profileAllowsOutreach 为 true。",
            reason: "项目 riskLevel 为 medium，仍需人工复核。",
          },
          {
            dimension: "availability_signal",
            score: 70,
            weight: 20,
            evidence: "stage 为 trial，languages 包含中文和英文。",
            reason: "候选当前可参与性仍需确认。",
          },
        ],
        risks: [
          "历史试标得分来源于 live_smoke_fixture，属于生产流程验证用 fixture。",
          "项目 riskLevel 为 medium，必须执行 humanReviewNeeded。",
        ],
        topReasons: ["项目 mustHave 全部覆盖，persona 匹配。"],
        missingEvidence: ["evidenceItems 尚缺少外部案例，evidenceRequirements 仍待补齐。"],
        nextAction: "继续当前试标，记录提交结果并完成人工复核。",
      },
    });

    const userFacingText = [
      ...result.scoreBreakdown.flatMap((item) => [item.dimension, item.evidence, item.reason]),
      ...result.topReasons,
      ...result.risks,
      ...result.missingEvidence,
      result.nextAction,
    ].join(" ");
    expect(userFacingText).not.toMatch(
      /evidenceLevel|confidence|live_smoke|fixture|evidenceItems|evidenceRequirements|signals|domainTags|humanReviewNeeded|consentState|contactPermissionBasis|direct_consent|profileAllowsOutreach|riskLevel|mustHave|persona|\bstage\b|\blanguages\b/i,
    );
    expect(result.scoreBreakdown.every((item) => item.evidence.length > 0 && item.reason.length > 0)).toBe(true);
    expect(result.risks).toContain("该历史试标记录尚未核验为真实项目表现，不能作为正式决策依据。");
  });

  it("turns a live trial score into an actionable, internally consistent result", () => {
    const result = normalizeCandidateScore({
      project: { rawDemand: "招募 Python 后端代码评审专家。", languages: ["中文", "英文"] },
      candidate: { languages: ["中文", "英文"], evidenceLevel: "E2", evidenceItemCount: 3, stage: "trial" },
      score: {
        ...baseScore,
        risks: [
          "领域匹配度：候选标签与核心框架吻合，但缺少外部可验证的项目仓库或公开代码评审案例佐证。",
          "合规风险：项目风险等级为 medium，需人工复核通过后方可进入正式任务。",
        ],
        missingEvidence: [],
        nextAction: "人工复核证据后决定下一步。",
      },
    });

    expect(result.nextAction).toBe("继续当前试标，记录提交结果并完成人工复核。");
    expect(result.missingEvidence).toContain("缺少外部可验证的项目仓库或公开代码评审案例佐证。");
    expect(result.risks.join(" ")).not.toMatch(/\bmedium\b/i);
  });
});

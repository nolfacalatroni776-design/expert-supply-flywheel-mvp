import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const personaJson = JSON.stringify({
    summary: "需要具备胸部 CT 阅片经验、可执行结构化标注指南的放射科专家。",
    mustHave: ["放射科临床或影像诊断经验", "能阅读中文病例和标注指南"],
    niceToHave: ["肺结节研究或质控经验", "三甲医院影像科经历"],
    exclude: ["仅医学销售岗位", "无临床或阅片经验"],
    taskFitSignals: ["结构化判断", "双盲复核", "仲裁解释"],
    evidenceRequirements: ["机构主页", "论文/指南/课程", "执业或职位证明"],
    humanReviewPoints: ["资质真实性", "数据敏感性", "NDA 和试标设计"],
  });
  const searchQueriesJson = JSON.stringify([
    "放射科 肺结节 CT 医生 机构主页",
    "胸部 CT 肺结节 放射科 论文 医生",
  ]);
  const scoringJson = JSON.stringify({
    evidenceLevel: "E2",
    scoreBreakdown: [
      {
        dimension: "领域匹配",
        score: 88,
        weight: 35,
        evidence: "公开主页显示放射科医学影像背景",
        reason: "与肺结节 CT 标注审核任务高度相关。",
      },
      {
        dimension: "证据强度",
        score: 68,
        weight: 30,
        evidence: "公开专家主页",
        reason: "已有公开来源，但还缺执业资质和近期病例质控证据。",
      },
      {
        dimension: "合规与可触达",
        score: 58,
        weight: 35,
        evidence: "仅记录公开主页链接，未记录明确同意",
        reason: "医疗任务必须人工复核，不应自动批量触达。",
      },
    ],
    topReasons: ["公开主页显示放射科背景", "领域标签与肺结节 CT 标注任务匹配"],
  });
  const risksJson = JSON.stringify(["未验证每周可投入时间", "未完成平台试标"]);
  const missingJson = JSON.stringify(["执业资质原始证明", "历史标注质量数据"]);

  const project = await prisma.project.upsert({
    where: { id: "seed-medical-project" },
    update: {
      title: "肺结节 CT 标注专家招募",
      rawDemand:
        "为肺结节 CT 标注项目招募 50 位放射科医生，要求有胸部 CT 或肺结节诊断经验，可参与病例审核、标注质检和仲裁。",
      domain: "医学影像",
      taskType: "标注审核 / 质检 / 仲裁",
      quantity: 50,
      budgetMin: 180,
      budgetMax: 300,
      languagesJson: JSON.stringify(["中文"]),
      regionsJson: JSON.stringify(["中国", "UTC+8"]),
      riskLevel: "regulated",
      status: "analyzed",
      personaJson,
      searchQueriesJson,
      supplyGoalJson: JSON.stringify({ targetCount: 50, priority: "regulated_review_first" }),
    },
    create: {
      id: "seed-medical-project",
      title: "肺结节 CT 标注专家招募",
      rawDemand:
        "为肺结节 CT 标注项目招募 50 位放射科医生，要求有胸部 CT 或肺结节诊断经验，可参与病例审核、标注质检和仲裁。",
      domain: "医学影像",
      taskType: "标注审核 / 质检 / 仲裁",
      quantity: 50,
      budgetMin: 180,
      budgetMax: 300,
      languagesJson: JSON.stringify(["中文"]),
      regionsJson: JSON.stringify(["中国", "UTC+8"]),
      riskLevel: "regulated",
      status: "analyzed",
      personaJson,
      searchQueriesJson,
      supplyGoalJson: JSON.stringify({ targetCount: 50, priority: "regulated_review_first" }),
    },
  });

  const expert = await prisma.expert.upsert({
    where: { identityKey: "https://example.com/radiology-expert#person=待核验候选张医生" },
    update: {
      name: "待核验候选 张医生",
      title: "放射科主治医师",
      affiliation: "公开资料待核验机构",
      domainTagsJson: JSON.stringify(["医学影像", "胸部 CT", "肺结节"]),
      languagesJson: JSON.stringify(["中文"]),
      region: "中国",
      contactJson: JSON.stringify({ profileUrl: "https://example.com/radiology-expert" }),
      evidenceLevel: "E2",
      consentState: "unknown",
      expertType: "external",
    },
    create: {
      identityKey: "https://example.com/radiology-expert#person=待核验候选张医生",
      name: "待核验候选 张医生",
      title: "放射科主治医师",
      affiliation: "公开资料待核验机构",
      sourceUrl: "https://example.com/radiology-expert",
      domainTagsJson: JSON.stringify(["医学影像", "胸部 CT", "肺结节"]),
      languagesJson: JSON.stringify(["中文"]),
      region: "中国",
      contactJson: JSON.stringify({ profileUrl: "https://example.com/radiology-expert" }),
      evidenceLevel: "E2",
      consentState: "unknown",
      expertType: "external",
    },
  });

  const candidate = await prisma.projectCandidate.upsert({
    where: { projectId_expertId: { projectId: project.id, expertId: expert.id } },
    update: {
      stage: "verified",
      fitScore: 82,
      scoringJson,
      risksJson,
      missingJson,
      nextAction: "人工核验资质后生成触达草稿",
      humanReviewNeeded: true,
      sourceType: "external",
      conversionProbability: 0.42,
      rankReasonJson: JSON.stringify({ reasons: ["外部公开资料显示医学影像背景", "医疗项目仍需人工核验证据和联系许可"] }),
    },
    create: {
      projectId: project.id,
      expertId: expert.id,
      stage: "verified",
      fitScore: 82,
      scoringJson,
      risksJson,
      missingJson,
      nextAction: "人工核验资质后生成触达草稿",
      humanReviewNeeded: true,
      sourceType: "external",
      conversionProbability: 0.42,
      rankReasonJson: JSON.stringify({ reasons: ["外部公开资料显示医学影像背景", "医疗项目仍需人工核验证据和联系许可"] }),
    },
  });

  const internalExpert = await prisma.expert.upsert({
    where: { identityKey: "https://expert-ops.local/internal/expert/radiology-mentor#person=内部专家李医生" },
    update: {
      name: "内部专家 李医生",
      title: "影像科副主任医师",
      affiliation: "历史合作专家库",
      domainTagsJson: JSON.stringify(["医学影像", "胸部 CT", "肺结节", "质控"]),
      languagesJson: JSON.stringify(["中文"]),
      region: "中国",
      contactJson: JSON.stringify({
        profileUrl: "https://expert-ops.local/internal/expert/radiology-mentor",
        contactPermissionBasis: "direct_consent",
        profileAllowsOutreach: true,
      }),
      evidenceLevel: "E3",
      consentState: "consented",
      expertType: "internal",
      lastActiveAt: new Date("2026-06-20T08:00:00.000Z"),
      qualitySummaryJson: JSON.stringify({ averageScore: 91, metricCount: 2, eventCount: 3 }),
    },
    create: {
      identityKey: "https://expert-ops.local/internal/expert/radiology-mentor#person=内部专家李医生",
      name: "内部专家 李医生",
      title: "影像科副主任医师",
      affiliation: "历史合作专家库",
      sourceUrl: "https://expert-ops.local/internal/expert/radiology-mentor",
      domainTagsJson: JSON.stringify(["医学影像", "胸部 CT", "肺结节", "质控"]),
      languagesJson: JSON.stringify(["中文"]),
      region: "中国",
      contactJson: JSON.stringify({
        profileUrl: "https://expert-ops.local/internal/expert/radiology-mentor",
        contactPermissionBasis: "direct_consent",
        profileAllowsOutreach: true,
      }),
      evidenceLevel: "E3",
      consentState: "consented",
      expertType: "internal",
      lastActiveAt: new Date("2026-06-20T08:00:00.000Z"),
      qualitySummaryJson: JSON.stringify({ averageScore: 91, metricCount: 2, eventCount: 3 }),
    },
  });

  const internalCandidate = await prisma.projectCandidate.upsert({
    where: { projectId_expertId: { projectId: project.id, expertId: internalExpert.id } },
    update: {
      stage: "verified",
      fitScore: 89,
      scoringJson: JSON.stringify({
        evidenceLevel: "E3",
        scoreBreakdown: [
          { dimension: "领域匹配", score: 92, weight: 35, evidence: "历史合作标签包含胸部 CT 与肺结节", reason: "与当前任务高度相关。" },
          { dimension: "历史质量", score: 91, weight: 30, evidence: "历史试标和质检记录", reason: "过往交付稳定。" },
          { dimension: "合规与可触达", score: 84, weight: 35, evidence: "已记录直接同意联系", reason: "仍需医疗项目人工复核。" },
        ],
        topReasons: ["历史任务质量稳定", "领域标签直接匹配", "已记录联系许可"],
      }),
      risksJson: JSON.stringify(["医疗项目需人工复核"]),
      missingJson: JSON.stringify(["本项目可用时间确认"]),
      nextAction: "确认档期后进入试标安排",
      humanReviewNeeded: true,
      sourceType: "internal",
      conversionProbability: 0.72,
      rankReasonJson: JSON.stringify({ reasons: ["内部专家库优先召回", "历史质量均分 91", "证据等级 E3"] }),
    },
    create: {
      projectId: project.id,
      expertId: internalExpert.id,
      stage: "verified",
      fitScore: 89,
      scoringJson: JSON.stringify({
        evidenceLevel: "E3",
        scoreBreakdown: [
          { dimension: "领域匹配", score: 92, weight: 35, evidence: "历史合作标签包含胸部 CT 与肺结节", reason: "与当前任务高度相关。" },
          { dimension: "历史质量", score: 91, weight: 30, evidence: "历史试标和质检记录", reason: "过往交付稳定。" },
          { dimension: "合规与可触达", score: 84, weight: 35, evidence: "已记录直接同意联系", reason: "仍需医疗项目人工复核。" },
        ],
        topReasons: ["历史任务质量稳定", "领域标签直接匹配", "已记录联系许可"],
      }),
      risksJson: JSON.stringify(["医疗项目需人工复核"]),
      missingJson: JSON.stringify(["本项目可用时间确认"]),
      nextAction: "确认档期后进入试标安排",
      humanReviewNeeded: true,
      sourceType: "internal",
      conversionProbability: 0.72,
      rankReasonJson: JSON.stringify({ reasons: ["内部专家库优先召回", "历史质量均分 91", "证据等级 E3"] }),
    },
  });

  for (const signal of [
    { id: "seed-signal-radiology-ct", expertId: internalExpert.id, type: "skill", value: "胸部 CT", source: "历史合作记录", evidenceLevel: "E3", confidence: 0.9 },
    { id: "seed-signal-radiology-nodule", expertId: internalExpert.id, type: "skill", value: "肺结节质控", source: "历史试标记录", evidenceLevel: "E3", confidence: 0.86 },
    { id: "seed-signal-radiology-language", expertId: internalExpert.id, type: "language", value: "中文", source: "专家档案", evidenceLevel: "E2", confidence: 0.95 },
  ]) {
    await prisma.expertSignal.upsert({
      where: { id: signal.id },
      update: signal,
      create: signal,
    });
  }

  for (const metric of [
    { id: "seed-quality-radiology-trial", expertId: internalExpert.id, projectId: project.id, metricType: "trial_passed", score: 92, source: "historical_trial", notes: "脱敏病例质控试标通过" },
    { id: "seed-quality-radiology-delivery", expertId: internalExpert.id, projectId: project.id, metricType: "delivery_quality", score: 90, source: "historical_delivery", notes: "历史审核一致性高" },
  ]) {
    await prisma.expertQualityMetric.upsert({
      where: { id: metric.id },
      update: metric,
      create: metric,
    });
  }

  await prisma.expertEngagementEvent.upsert({
    where: { id: "seed-engagement-radiology-recalled" },
    update: {
      expertId: internalExpert.id,
      projectId: project.id,
      candidateId: internalCandidate.id,
      eventType: "recalled",
      channel: "internal_library",
      payloadJson: JSON.stringify({ fitScore: 89, note: "seed internal recall" }),
    },
    create: {
      id: "seed-engagement-radiology-recalled",
      expertId: internalExpert.id,
      projectId: project.id,
      candidateId: internalCandidate.id,
      eventType: "recalled",
      channel: "internal_library",
      payloadJson: JSON.stringify({ fitScore: 89, note: "seed internal recall" }),
    },
  });

  await prisma.supplyGap.upsert({
    where: { id: "seed-supply-gap-medical-quantity" },
    update: {
      projectId: project.id,
      gapType: "quantity",
      description: "内部专家数量不足，需要补充更多 E2+ 放射科候选。",
      requiredCount: 50,
      availableCount: 1,
      severity: "high",
      recommendedAction: "优先搜索机构主页、会议讲者和论文作者，并人工核验证据。",
      status: "open",
    },
    create: {
      id: "seed-supply-gap-medical-quantity",
      projectId: project.id,
      gapType: "quantity",
      description: "内部专家数量不足，需要补充更多 E2+ 放射科候选。",
      requiredCount: 50,
      availableCount: 1,
      severity: "high",
      recommendedAction: "优先搜索机构主页、会议讲者和论文作者，并人工核验证据。",
      status: "open",
    },
  });

  await prisma.supplySearchRun.upsert({
    where: { id: "seed-supply-run-medical-internal" },
    update: {
      projectId: project.id,
      runType: "internal",
      status: "completed",
      goalJson: JSON.stringify({ targetCount: 50, riskLevel: "regulated" }),
      queriesJson: searchQueriesJson,
      summaryJson: JSON.stringify({ matched: 1, eligibleExperts: 1, highEvidence: 1 }),
    },
    create: {
      id: "seed-supply-run-medical-internal",
      projectId: project.id,
      runType: "internal",
      status: "completed",
      goalJson: JSON.stringify({ targetCount: 50, riskLevel: "regulated" }),
      queriesJson: searchQueriesJson,
      summaryJson: JSON.stringify({ matched: 1, eligibleExperts: 1, highEvidence: 1 }),
    },
  });

  await prisma.evidenceItem.upsert({
    where: { id: "seed-evidence-1" },
    update: {
      projectId: project.id,
      expertId: expert.id,
      candidateId: candidate.id,
      claim: "放射科医生背景",
      sourceUrl: "https://example.com/radiology-expert",
      sourceTitle: "公开专家主页",
      sourceType: "official_profile",
      snippet: "公开资料显示该候选从事医学影像诊断工作，仍需人工核验资质与可联系依据。",
      evidenceLevel: "E2",
      confidence: 0.72,
    },
    create: {
      id: "seed-evidence-1",
      projectId: project.id,
      expertId: expert.id,
      candidateId: candidate.id,
      claim: "放射科医生背景",
      sourceUrl: "https://example.com/radiology-expert",
      sourceTitle: "公开专家主页",
      sourceType: "official_profile",
      snippet: "公开资料显示该候选从事医学影像诊断工作，仍需人工核验资质与可联系依据。",
      evidenceLevel: "E2",
      confidence: 0.72,
    },
  });

  await prisma.auditEvent.upsert({
    where: { id: "seed-agent-event-1" },
    update: {
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "agent.step.completed",
      payloadJson: JSON.stringify({
        step: "seed_data",
        searchResults: 1,
        candidates: 1,
        scored: 1,
      }),
    },
    create: {
      id: "seed-agent-event-1",
      projectId: project.id,
      entityType: "project",
      entityId: project.id,
      action: "agent.step.completed",
      payloadJson: JSON.stringify({
        step: "seed_data",
        searchResults: 1,
        candidates: 1,
        scored: 1,
      }),
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

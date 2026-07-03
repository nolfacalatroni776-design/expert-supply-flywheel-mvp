import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PrismaClient } from "@prisma/client";

let initPromise: Promise<void> | null = null;

export function ensureSqliteDirectoryFromEnv() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.startsWith("file:")) {
    return;
  }

  const dbPath = databaseUrl.slice("file:".length);
  if (!dbPath || dbPath.startsWith("./") || dbPath === ":memory:") {
    return;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
}

export async function ensureRuntimeDatabase(client: PrismaClient) {
  if (process.env.ENABLE_RUNTIME_DB_INIT !== "1") {
    return;
  }

  initPromise ??= initializeRuntimeDatabase(client);
  return initPromise;
}

async function initializeRuntimeDatabase(client: PrismaClient) {
  for (const statement of runtimeSchemaSql
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)) {
    await client.$executeRawUnsafe(`${statement};`);
  }

  const projectCount = await client.project.count();
  if (projectCount > 0) {
    return;
  }

  await seedTrialData(client);
}

const runtimeSchemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS Project (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  rawDemand TEXT NOT NULL,
  domain TEXT,
  taskType TEXT,
  quantity INTEGER,
  budgetMin REAL,
  budgetMax REAL,
  languagesJson TEXT NOT NULL DEFAULT '[]',
  regionsJson TEXT NOT NULL DEFAULT '[]',
  riskLevel TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'draft',
  personaJson TEXT NOT NULL DEFAULT '{}',
  searchQueriesJson TEXT NOT NULL DEFAULT '[]',
  supplyGoalJson TEXT NOT NULL DEFAULT '{}',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Expert (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  affiliation TEXT,
  domainTagsJson TEXT NOT NULL DEFAULT '[]',
  languagesJson TEXT NOT NULL DEFAULT '[]',
  region TEXT,
  contactJson TEXT NOT NULL DEFAULT '{}',
  sourceUrl TEXT,
  evidenceLevel TEXT NOT NULL DEFAULT 'E0',
  consentState TEXT NOT NULL DEFAULT 'unknown',
  riskFlagsJson TEXT NOT NULL DEFAULT '[]',
  expertType TEXT NOT NULL DEFAULT 'external',
  lastActiveAt DATETIME,
  qualitySummaryJson TEXT NOT NULL DEFAULT '{}',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ProjectCandidate (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  expertId TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'sourced',
  fitScore INTEGER,
  scoringJson TEXT NOT NULL DEFAULT '{}',
  risksJson TEXT NOT NULL DEFAULT '[]',
  missingJson TEXT NOT NULL DEFAULT '[]',
  nextAction TEXT,
  humanReviewNeeded BOOLEAN NOT NULL DEFAULT 1,
  sourceType TEXT NOT NULL DEFAULT 'external',
  sourceRunId TEXT,
  conversionProbability REAL,
  rankReasonJson TEXT NOT NULL DEFAULT '{}',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ProjectCandidate_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ProjectCandidate_expertId_fkey FOREIGN KEY (expertId) REFERENCES Expert (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ProjectCandidate_sourceRunId_fkey FOREIGN KEY (sourceRunId) REFERENCES SupplySearchRun (id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS SearchResult (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  searchRunId TEXT,
  query TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT NOT NULL,
  domain TEXT,
  position INTEGER,
  sourceType TEXT NOT NULL DEFAULT 'public_web',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT SearchResult_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT SearchResult_searchRunId_fkey FOREIGN KEY (searchRunId) REFERENCES SupplySearchRun (id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS SearchCache (
  id TEXT PRIMARY KEY NOT NULL,
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  resultsJson TEXT NOT NULL,
  expiresAt DATETIME NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS EvidenceItem (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT,
  expertId TEXT NOT NULL,
  candidateId TEXT,
  claim TEXT NOT NULL,
  sourceUrl TEXT NOT NULL,
  sourceTitle TEXT,
  sourceType TEXT NOT NULL DEFAULT 'public_web',
  snippet TEXT NOT NULL,
  evidenceLevel TEXT NOT NULL DEFAULT 'E1',
  confidence REAL NOT NULL DEFAULT 0.5,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT EvidenceItem_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT EvidenceItem_expertId_fkey FOREIGN KEY (expertId) REFERENCES Expert (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT EvidenceItem_candidateId_fkey FOREIGN KEY (candidateId) REFERENCES ProjectCandidate (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS OutreachDraft (
  id TEXT PRIMARY KEY NOT NULL,
  candidateId TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  replyTemplatesJson TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT OutreachDraft_candidateId_fkey FOREIGN KEY (candidateId) REFERENCES ProjectCandidate (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS TrialTask (
  id TEXT PRIMARY KEY NOT NULL,
  candidateId TEXT NOT NULL,
  instructions TEXT NOT NULL,
  rubricJson TEXT NOT NULL DEFAULT '{}',
  score REAL,
  outcome TEXT,
  notes TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT TrialTask_candidateId_fkey FOREIGN KEY (candidateId) REFERENCES ProjectCandidate (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS ExpertSignal (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT NOT NULL,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  evidenceLevel TEXT NOT NULL DEFAULT 'E1',
  confidence REAL NOT NULL DEFAULT 0.5,
  sourceUrl TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ExpertSignal_expertId_fkey FOREIGN KEY (expertId) REFERENCES Expert (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS ExpertEngagementEvent (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT NOT NULL,
  projectId TEXT,
  candidateId TEXT,
  eventType TEXT NOT NULL,
  channel TEXT,
  payloadJson TEXT NOT NULL DEFAULT '{}',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ExpertEngagementEvent_expertId_fkey FOREIGN KEY (expertId) REFERENCES Expert (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ExpertEngagementEvent_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ExpertEngagementEvent_candidateId_fkey FOREIGN KEY (candidateId) REFERENCES ProjectCandidate (id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS ExpertQualityMetric (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT NOT NULL,
  projectId TEXT,
  metricType TEXT NOT NULL,
  score REAL NOT NULL,
  source TEXT NOT NULL,
  notes TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ExpertQualityMetric_expertId_fkey FOREIGN KEY (expertId) REFERENCES Expert (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ExpertQualityMetric_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS SupplySearchRun (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  runType TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  goalJson TEXT NOT NULL DEFAULT '{}',
  queriesJson TEXT NOT NULL DEFAULT '[]',
  summaryJson TEXT NOT NULL DEFAULT '{}',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT SupplySearchRun_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS SupplyGap (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  gapType TEXT NOT NULL,
  description TEXT NOT NULL,
  requiredCount INTEGER NOT NULL,
  availableCount INTEGER NOT NULL,
  severity TEXT NOT NULL,
  recommendedAction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT SupplyGap_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS SearchSourceMetric (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  searchRunId TEXT,
  query TEXT NOT NULL,
  domain TEXT,
  resultCount INTEGER NOT NULL DEFAULT 0,
  candidateCount INTEGER NOT NULL DEFAULT 0,
  e2PlusCount INTEGER NOT NULL DEFAULT 0,
  approvedCount INTEGER NOT NULL DEFAULT 0,
  trialCount INTEGER NOT NULL DEFAULT 0,
  onboardedCount INTEGER NOT NULL DEFAULT 0,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT SearchSourceMetric_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT SearchSourceMetric_searchRunId_fkey FOREIGN KEY (searchRunId) REFERENCES SupplySearchRun (id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS ExpertMergeCandidate (
  id TEXT PRIMARY KEY NOT NULL,
  primaryExpertId TEXT NOT NULL,
  duplicateExpertId TEXT NOT NULL,
  reasonJson TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ExpertMergeCandidate_primaryExpertId_fkey FOREIGN KEY (primaryExpertId) REFERENCES Expert (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ExpertMergeCandidate_duplicateExpertId_fkey FOREIGN KEY (duplicateExpertId) REFERENCES Expert (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS RecruitmentOutcome (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  targetCount INTEGER NOT NULL DEFAULT 0,
  sourcedCount INTEGER NOT NULL DEFAULT 0,
  approvedCount INTEGER NOT NULL DEFAULT 0,
  contactedCount INTEGER NOT NULL DEFAULT 0,
  trialCount INTEGER NOT NULL DEFAULT 0,
  onboardedCount INTEGER NOT NULL DEFAULT 0,
  summaryJson TEXT NOT NULL DEFAULT '{}',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT RecruitmentOutcome_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS MarketingCampaign (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT 'recruit_experts',
  audienceJson TEXT NOT NULL DEFAULT '[]',
  channelsJson TEXT NOT NULL DEFAULT '[]',
  messageBrief TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT MarketingCampaign_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS MarketingPost (
  id TEXT PRIMARY KEY NOT NULL,
  campaignId TEXT NOT NULL,
  projectId TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cta TEXT NOT NULL,
  hashtagsJson TEXT NOT NULL DEFAULT '[]',
  riskNotesJson TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  scheduledFor DATETIME,
  publishedAt DATETIME,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT MarketingPost_campaignId_fkey FOREIGN KEY (campaignId) REFERENCES MarketingCampaign (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT MarketingPost_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS AuditEvent (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT,
  entityType TEXT NOT NULL,
  entityId TEXT NOT NULL,
  action TEXT NOT NULL,
  payloadJson TEXT NOT NULL DEFAULT '{}',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT AuditEvent_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS AgentTaskRun (
  id TEXT PRIMARY KEY NOT NULL,
  projectId TEXT NOT NULL,
  intent TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  planJson TEXT NOT NULL DEFAULT '{}',
  contextSnapshotJson TEXT NOT NULL DEFAULT '{}',
  reportJson TEXT NOT NULL DEFAULT '{}',
  errorMessage TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  startedAt DATETIME,
  completedAt DATETIME,
  CONSTRAINT AgentTaskRun_projectId_fkey FOREIGN KEY (projectId) REFERENCES Project (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS AgentTaskStep (
  id TEXT PRIMARY KEY NOT NULL,
  runId TEXT NOT NULL,
  stepKey TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  "order" INTEGER NOT NULL,
  requiresConfirmation BOOLEAN NOT NULL DEFAULT 0,
  confirmedAt DATETIME,
  inputJson TEXT NOT NULL DEFAULT '{}',
  outputJson TEXT NOT NULL DEFAULT '{}',
  checksJson TEXT NOT NULL DEFAULT '{}',
  errorMessage TEXT,
  startedAt DATETIME,
  completedAt DATETIME,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT AgentTaskStep_runId_fkey FOREIGN KEY (runId) REFERENCES AgentTaskRun (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ProjectCandidate_projectId_expertId_key ON ProjectCandidate(projectId, expertId);
CREATE UNIQUE INDEX IF NOT EXISTS Expert_sourceUrl_key ON Expert(sourceUrl);
CREATE INDEX IF NOT EXISTS Expert_name_idx ON Expert(name);
CREATE INDEX IF NOT EXISTS Expert_expertType_idx ON Expert(expertType);
CREATE INDEX IF NOT EXISTS Expert_lastActiveAt_idx ON Expert(lastActiveAt);
CREATE INDEX IF NOT EXISTS SearchResult_projectId_idx ON SearchResult(projectId);
CREATE INDEX IF NOT EXISTS SearchResult_searchRunId_idx ON SearchResult(searchRunId);
CREATE INDEX IF NOT EXISTS SearchResult_url_idx ON SearchResult(url);
CREATE UNIQUE INDEX IF NOT EXISTS SearchResult_projectId_url_key ON SearchResult(projectId, url);
CREATE UNIQUE INDEX IF NOT EXISTS SearchCache_query_key ON SearchCache(query);
CREATE INDEX IF NOT EXISTS SearchCache_expiresAt_idx ON SearchCache(expiresAt);
CREATE INDEX IF NOT EXISTS ProjectCandidate_stage_idx ON ProjectCandidate(stage);
CREATE INDEX IF NOT EXISTS ProjectCandidate_sourceType_idx ON ProjectCandidate(sourceType);
CREATE INDEX IF NOT EXISTS ProjectCandidate_sourceRunId_idx ON ProjectCandidate(sourceRunId);
CREATE INDEX IF NOT EXISTS EvidenceItem_expertId_idx ON EvidenceItem(expertId);
CREATE INDEX IF NOT EXISTS EvidenceItem_candidateId_idx ON EvidenceItem(candidateId);
CREATE INDEX IF NOT EXISTS EvidenceItem_evidenceLevel_idx ON EvidenceItem(evidenceLevel);
CREATE INDEX IF NOT EXISTS OutreachDraft_candidateId_idx ON OutreachDraft(candidateId);
CREATE INDEX IF NOT EXISTS OutreachDraft_status_idx ON OutreachDraft(status);
CREATE INDEX IF NOT EXISTS TrialTask_candidateId_idx ON TrialTask(candidateId);
CREATE INDEX IF NOT EXISTS TrialTask_outcome_idx ON TrialTask(outcome);
CREATE INDEX IF NOT EXISTS MarketingCampaign_projectId_idx ON MarketingCampaign(projectId);
CREATE INDEX IF NOT EXISTS MarketingCampaign_status_idx ON MarketingCampaign(status);
CREATE INDEX IF NOT EXISTS MarketingPost_projectId_idx ON MarketingPost(projectId);
CREATE INDEX IF NOT EXISTS MarketingPost_campaignId_idx ON MarketingPost(campaignId);
CREATE INDEX IF NOT EXISTS MarketingPost_channel_idx ON MarketingPost(channel);
CREATE INDEX IF NOT EXISTS MarketingPost_status_idx ON MarketingPost(status);
CREATE INDEX IF NOT EXISTS AuditEvent_entityType_entityId_idx ON AuditEvent(entityType, entityId);
CREATE INDEX IF NOT EXISTS AuditEvent_action_idx ON AuditEvent(action);
CREATE INDEX IF NOT EXISTS ExpertSignal_expertId_idx ON ExpertSignal(expertId);
CREATE INDEX IF NOT EXISTS ExpertSignal_type_idx ON ExpertSignal(type);
CREATE INDEX IF NOT EXISTS ExpertSignal_evidenceLevel_idx ON ExpertSignal(evidenceLevel);
CREATE INDEX IF NOT EXISTS ExpertEngagementEvent_expertId_idx ON ExpertEngagementEvent(expertId);
CREATE INDEX IF NOT EXISTS ExpertEngagementEvent_projectId_idx ON ExpertEngagementEvent(projectId);
CREATE INDEX IF NOT EXISTS ExpertEngagementEvent_candidateId_idx ON ExpertEngagementEvent(candidateId);
CREATE INDEX IF NOT EXISTS ExpertEngagementEvent_eventType_idx ON ExpertEngagementEvent(eventType);
CREATE INDEX IF NOT EXISTS ExpertQualityMetric_expertId_idx ON ExpertQualityMetric(expertId);
CREATE INDEX IF NOT EXISTS ExpertQualityMetric_projectId_idx ON ExpertQualityMetric(projectId);
CREATE INDEX IF NOT EXISTS ExpertQualityMetric_metricType_idx ON ExpertQualityMetric(metricType);
CREATE INDEX IF NOT EXISTS SupplySearchRun_projectId_idx ON SupplySearchRun(projectId);
CREATE INDEX IF NOT EXISTS SupplySearchRun_runType_idx ON SupplySearchRun(runType);
CREATE INDEX IF NOT EXISTS SupplySearchRun_status_idx ON SupplySearchRun(status);
CREATE INDEX IF NOT EXISTS SupplyGap_projectId_idx ON SupplyGap(projectId);
CREATE INDEX IF NOT EXISTS SupplyGap_severity_idx ON SupplyGap(severity);
CREATE INDEX IF NOT EXISTS SupplyGap_status_idx ON SupplyGap(status);
CREATE INDEX IF NOT EXISTS SearchSourceMetric_projectId_idx ON SearchSourceMetric(projectId);
CREATE INDEX IF NOT EXISTS SearchSourceMetric_searchRunId_idx ON SearchSourceMetric(searchRunId);
CREATE INDEX IF NOT EXISTS SearchSourceMetric_domain_idx ON SearchSourceMetric(domain);
CREATE UNIQUE INDEX IF NOT EXISTS ExpertMergeCandidate_primaryExpertId_duplicateExpertId_key ON ExpertMergeCandidate(primaryExpertId, duplicateExpertId);
CREATE INDEX IF NOT EXISTS ExpertMergeCandidate_status_idx ON ExpertMergeCandidate(status);
CREATE INDEX IF NOT EXISTS RecruitmentOutcome_projectId_idx ON RecruitmentOutcome(projectId);
CREATE INDEX IF NOT EXISTS RecruitmentOutcome_createdAt_idx ON RecruitmentOutcome(createdAt);
CREATE INDEX IF NOT EXISTS AgentTaskRun_projectId_idx ON AgentTaskRun(projectId);
CREATE INDEX IF NOT EXISTS AgentTaskRun_intent_idx ON AgentTaskRun(intent);
CREATE INDEX IF NOT EXISTS AgentTaskRun_status_idx ON AgentTaskRun(status);
CREATE INDEX IF NOT EXISTS AgentTaskRun_createdAt_idx ON AgentTaskRun(createdAt);
CREATE UNIQUE INDEX IF NOT EXISTS AgentTaskStep_runId_stepKey_key ON AgentTaskStep(runId, stepKey);
CREATE INDEX IF NOT EXISTS AgentTaskStep_runId_idx ON AgentTaskStep(runId);
CREATE INDEX IF NOT EXISTS AgentTaskStep_status_idx ON AgentTaskStep(status);
CREATE INDEX IF NOT EXISTS AgentTaskStep_stepKey_idx ON AgentTaskStep(stepKey);
`;

async function seedTrialData(client: PrismaClient) {
  const projectId = "seed-medical-project";
  const campaignId = "seed-medical-campaign";

  await client.project.create({
    data: {
      id: projectId,
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
      personaJson: JSON.stringify({
        summary: "需要具备胸部 CT 阅片经验、可执行结构化标注指南的放射科专家。",
        mustHave: ["放射科临床或影像诊断经验", "能阅读中文病例和标注指南"],
        niceToHave: ["肺结节研究或质控经验", "三甲医院影像科经历"],
        exclude: ["仅医学销售岗位", "无临床或阅片经验"],
        evidenceRequirements: ["机构主页", "论文/指南/课程", "执业或职位证明"],
        humanReviewPoints: ["资质真实性", "数据敏感性", "NDA 和试标设计"],
      }),
      searchQueriesJson: JSON.stringify([
        "放射科 肺结节 CT 医生 机构主页",
        "胸部 CT 肺结节 放射科 论文 医生",
      ]),
      supplyGoalJson: JSON.stringify({ targetCount: 50, priority: "regulated_review_first" }),
    },
  });

  const internalExpert = await client.expert.create({
    data: {
      id: "trial-internal-radiology-expert",
      name: "内部专家 李医生",
      title: "影像科副主任医师",
      affiliation: "历史合作专家库",
      sourceUrl: "https://expert-ops.local/internal/expert/radiology-mentor",
      domainTagsJson: JSON.stringify(["医学影像", "胸部 CT", "肺结节", "质控"]),
      languagesJson: JSON.stringify(["中文"]),
      region: "中国",
      contactJson: JSON.stringify({
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

  const externalExpert = await client.expert.create({
    data: {
      id: "trial-external-radiology-expert",
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

  const internalCandidate = await client.projectCandidate.create({
    data: {
      id: "trial-candidate-internal-radiology",
      projectId,
      expertId: internalExpert.id,
      stage: "verified",
      fitScore: 89,
      scoringJson: JSON.stringify({
        evidenceLevel: "E3",
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

  const externalCandidate = await client.projectCandidate.create({
    data: {
      id: "trial-candidate-external-radiology",
      projectId,
      expertId: externalExpert.id,
      stage: "verified",
      fitScore: 82,
      scoringJson: JSON.stringify({
        evidenceLevel: "E2",
        topReasons: ["公开主页显示放射科背景", "领域标签与肺结节 CT 标注任务匹配"],
      }),
      risksJson: JSON.stringify(["未验证每周可投入时间", "未完成平台试标"]),
      missingJson: JSON.stringify(["执业资质原始证明", "历史标注质量数据"]),
      nextAction: "人工核验资质后生成触达草稿",
      humanReviewNeeded: true,
      sourceType: "external",
      conversionProbability: 0.42,
      rankReasonJson: JSON.stringify({ reasons: ["外部公开资料显示医学影像背景", "医疗项目仍需人工核验证据和联系许可"] }),
    },
  });

  await client.evidenceItem.createMany({
    data: [
      {
        id: "trial-evidence-internal-quality",
        projectId,
        expertId: internalExpert.id,
        candidateId: internalCandidate.id,
        claim: "历史合作记录显示其具备胸部 CT 与肺结节质控经验。",
        sourceUrl: "https://expert-ops.local/internal/expert/radiology-mentor",
        sourceTitle: "内部专家档案",
        sourceType: "internal_profile",
        snippet: "历史试标通过，质控一致性高。",
        evidenceLevel: "E3",
        confidence: 0.9,
      },
      {
        id: "trial-evidence-external-profile",
        projectId,
        expertId: externalExpert.id,
        candidateId: externalCandidate.id,
        claim: "公开资料显示候选人与放射科医学影像方向相关。",
        sourceUrl: "https://example.com/radiology-expert",
        sourceTitle: "公开专家主页",
        sourceType: "public_web",
        snippet: "公开主页待人工核验，不作为资质最终判断。",
        evidenceLevel: "E2",
        confidence: 0.68,
      },
    ],
  });

  await client.expertSignal.createMany({
    data: [
      {
        id: "trial-signal-ct",
        expertId: internalExpert.id,
        type: "skill",
        value: "胸部 CT",
        source: "历史合作记录",
        evidenceLevel: "E3",
        confidence: 0.9,
      },
      {
        id: "trial-signal-quality",
        expertId: internalExpert.id,
        type: "quality",
        value: "质控一致性高",
        source: "历史试标记录",
        evidenceLevel: "E3",
        confidence: 0.86,
      },
    ],
  });

  await client.expertQualityMetric.create({
    data: {
      id: "trial-quality-radiology",
      expertId: internalExpert.id,
      projectId,
      metricType: "trial_passed",
      score: 92,
      source: "historical_trial",
      notes: "脱敏病例质控试标通过。",
    },
  });

  await client.supplySearchRun.create({
    data: {
      id: "trial-internal-run",
      projectId,
      runType: "internal",
      status: "completed",
      goalJson: JSON.stringify({ targetCount: 50 }),
      queriesJson: JSON.stringify(["医学影像", "胸部 CT", "肺结节"]),
      summaryJson: JSON.stringify({ recalled: 1, highEvidence: 1, outreachReady: 0 }),
    },
  });

  await client.supplyGap.create({
    data: {
      id: "trial-gap-radiology",
      projectId,
      gapType: "count",
      description: "内部专家不足以覆盖 50 位目标，需要继续补充公开候选并进行资质复核。",
      requiredCount: 50,
      availableCount: 1,
      severity: "high",
      recommendedAction: "优先召回内部专家，同时围绕三甲医院影像科主页、会议讲者和论文作者进行公开证据补充。",
      status: "open",
    },
  });

  await client.marketingCampaign.create({
    data: {
      id: campaignId,
      projectId,
      objective: "recruit_experts",
      audienceJson: JSON.stringify(["放射科医生", "医学影像研究者", "胸部 CT 质控专家"]),
      channelsJson: JSON.stringify(["linkedin", "wechat", "community"]),
      messageBrief: "招募具备肺结节 CT 阅片经验的放射科专家参与结构化标注质控。",
      status: "draft",
    },
  });

  await client.marketingPost.createMany({
    data: [
      {
        id: "trial-post-linkedin",
        campaignId,
        projectId,
        channel: "LinkedIn",
        title: "招募肺结节 CT 标注质控专家",
        body: "我们正在招募具备胸部 CT 或肺结节诊断经验的放射科专家，参与医学影像标注质控与仲裁。项目包含标准化指南、试标和人工复核流程。",
        cta: "有兴趣的专家可提交公开资料或推荐合适人选，运营团队会进行资质复核后安排试标。",
        hashtagsJson: JSON.stringify(["医学影像", "放射科", "数据标注"]),
        riskNotesJson: JSON.stringify(["医疗任务需资质核验", "不承诺未经复核的任务分配"]),
        status: "needs_review",
      },
      {
        id: "trial-post-wechat",
        campaignId,
        projectId,
        channel: "微信公众号",
        title: "肺结节 CT 标注质控专家招募",
        body: "面向有胸部 CT 阅片经验的放射科医生开放专家招募。入选前会完成资料核验、试标评估和项目说明确认。",
        cta: "欢迎转发给符合条件的医生或医学影像研究者。",
        hashtagsJson: JSON.stringify(["专家招募", "医学影像"]),
        riskNotesJson: JSON.stringify(["需人工审核资质", "试标通过后进入项目候选池"]),
        status: "approved",
      },
      {
        id: "trial-post-community",
        campaignId,
        projectId,
        channel: "专业社群",
        title: "寻找胸部 CT/肺结节方向放射科专家",
        body: "项目需要专家协助完成标注审核、质控和疑难样本仲裁，适合有临床阅片和结构化标注经验的人选。",
        cta: "可直接推荐候选人公开主页或过往研究方向，运营团队后续核验。",
        hashtagsJson: JSON.stringify(["肺结节", "胸部CT", "专家众包"]),
        riskNotesJson: JSON.stringify(["不自动外联", "不采集私人联系方式"]),
        status: "needs_review",
      },
    ],
  });

  await client.auditEvent.create({
    data: {
      id: "trial-audit-seeded",
      projectId,
      entityType: "project",
      entityId: projectId,
      action: "trial.seeded",
      payloadJson: JSON.stringify({ source: "runtime_db", purpose: "public_trial" }),
    },
  });
}

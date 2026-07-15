import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const dbPath = databaseUrl.startsWith("file:")
  ? databaseUrl.slice("file:".length)
  : databaseUrl;
const absoluteDbPath = resolve(process.cwd(), "prisma", dbPath.replace(/^\.\//, ""));

mkdirSync(dirname(absoluteDbPath), { recursive: true });

const sql = `
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
  identityKey TEXT NOT NULL,
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
  workflowRunId TEXT,
  executionToken TEXT,
  leaseExpiresAt DATETIME,
  heartbeatAt DATETIME,
  attempt INTEGER NOT NULL DEFAULT 0,
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
  confirmationDecision TEXT,
  confirmationReason TEXT,
  decidedAt DATETIME,
  inputJson TEXT NOT NULL DEFAULT '{}',
  outputJson TEXT NOT NULL DEFAULT '{}',
  checksJson TEXT NOT NULL DEFAULT '{}',
  errorMessage TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  startedAt DATETIME,
  completedAt DATETIME,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT AgentTaskStep_runId_fkey FOREIGN KEY (runId) REFERENCES AgentTaskRun (id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ProjectCandidate_projectId_expertId_key ON ProjectCandidate(projectId, expertId);
CREATE UNIQUE INDEX IF NOT EXISTS Expert_identityKey_key ON Expert(identityKey);
CREATE INDEX IF NOT EXISTS Expert_sourceUrl_idx ON Expert(sourceUrl);
CREATE INDEX IF NOT EXISTS Expert_name_idx ON Expert(name);
DELETE FROM SearchResult
WHERE id NOT IN (
  SELECT MIN(id)
  FROM SearchResult
  GROUP BY projectId, url
);
CREATE INDEX IF NOT EXISTS SearchResult_projectId_idx ON SearchResult(projectId);
CREATE INDEX IF NOT EXISTS SearchResult_url_idx ON SearchResult(url);
CREATE UNIQUE INDEX IF NOT EXISTS SearchResult_projectId_url_key ON SearchResult(projectId, url);
CREATE UNIQUE INDEX IF NOT EXISTS SearchCache_query_key ON SearchCache(query);
CREATE INDEX IF NOT EXISTS SearchCache_expiresAt_idx ON SearchCache(expiresAt);
CREATE INDEX IF NOT EXISTS ProjectCandidate_stage_idx ON ProjectCandidate(stage);
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
CREATE INDEX IF NOT EXISTS AgentTaskRun_status_leaseExpiresAt_idx ON AgentTaskRun(status, leaseExpiresAt);
CREATE INDEX IF NOT EXISTS AgentTaskRun_createdAt_idx ON AgentTaskRun(createdAt);
CREATE UNIQUE INDEX IF NOT EXISTS AgentTaskRun_workflowRunId_key ON AgentTaskRun(workflowRunId);
CREATE UNIQUE INDEX IF NOT EXISTS AgentTaskStep_runId_stepKey_key ON AgentTaskStep(runId, stepKey);
CREATE INDEX IF NOT EXISTS AgentTaskStep_runId_idx ON AgentTaskStep(runId);
CREATE INDEX IF NOT EXISTS AgentTaskStep_status_idx ON AgentTaskStep(status);
CREATE INDEX IF NOT EXISTS AgentTaskStep_stepKey_idx ON AgentTaskStep(stepKey);
`;

const tempSql = resolve(process.cwd(), "prisma", ".init.sql");
writeFileSync(tempSql, sql);
execFileSync("sqlite3", [absoluteDbPath, `.read ${tempSql}`], { stdio: "inherit" });

const migrationSql = `
ALTER TABLE OutreachDraft ADD COLUMN replyTemplatesJson TEXT NOT NULL DEFAULT '{}';
ALTER TABLE Project ADD COLUMN supplyGoalJson TEXT NOT NULL DEFAULT '{}';
ALTER TABLE Expert ADD COLUMN expertType TEXT NOT NULL DEFAULT 'external';
ALTER TABLE Expert ADD COLUMN lastActiveAt DATETIME;
ALTER TABLE Expert ADD COLUMN qualitySummaryJson TEXT NOT NULL DEFAULT '{}';
ALTER TABLE Expert ADD COLUMN identityKey TEXT;
ALTER TABLE ProjectCandidate ADD COLUMN sourceType TEXT NOT NULL DEFAULT 'external';
ALTER TABLE ProjectCandidate ADD COLUMN sourceRunId TEXT;
ALTER TABLE ProjectCandidate ADD COLUMN conversionProbability REAL;
ALTER TABLE ProjectCandidate ADD COLUMN rankReasonJson TEXT NOT NULL DEFAULT '{}';
ALTER TABLE SearchResult ADD COLUMN searchRunId TEXT;
ALTER TABLE SearchResult ADD COLUMN sourceType TEXT NOT NULL DEFAULT 'public_web';
ALTER TABLE AgentTaskRun ADD COLUMN workflowRunId TEXT;
ALTER TABLE AgentTaskRun ADD COLUMN executionToken TEXT;
ALTER TABLE AgentTaskRun ADD COLUMN leaseExpiresAt DATETIME;
ALTER TABLE AgentTaskRun ADD COLUMN heartbeatAt DATETIME;
ALTER TABLE AgentTaskRun ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE AgentTaskStep ADD COLUMN confirmationDecision TEXT;
ALTER TABLE AgentTaskStep ADD COLUMN confirmationReason TEXT;
ALTER TABLE AgentTaskStep ADD COLUMN decidedAt DATETIME;
ALTER TABLE AgentTaskStep ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
`;

for (const statement of migrationSql.split(";").map((item) => item.trim()).filter(Boolean)) {
  try {
    execFileSync("sqlite3", [absoluteDbPath, `${statement};`], { stdio: "pipe" });
  } catch {
    // The column already exists in freshly initialized or previously migrated databases.
  }
}

const postMigrationSql = `
UPDATE Expert
SET identityKey = CASE
  WHEN sourceUrl IS NULL OR TRIM(sourceUrl) = '' THEN 'expert:' || id
  ELSE LOWER(RTRIM(sourceUrl, '/')) || '#person=' || LOWER(REPLACE(name, ' ', ''))
END
WHERE identityKey IS NULL OR TRIM(identityKey) = '';
DROP INDEX IF EXISTS Expert_sourceUrl_key;
CREATE UNIQUE INDEX IF NOT EXISTS Expert_identityKey_key ON Expert(identityKey);
CREATE INDEX IF NOT EXISTS Expert_sourceUrl_idx ON Expert(sourceUrl);
CREATE INDEX IF NOT EXISTS Expert_expertType_idx ON Expert(expertType);
CREATE INDEX IF NOT EXISTS Expert_lastActiveAt_idx ON Expert(lastActiveAt);
CREATE INDEX IF NOT EXISTS SearchResult_searchRunId_idx ON SearchResult(searchRunId);
CREATE INDEX IF NOT EXISTS ProjectCandidate_sourceType_idx ON ProjectCandidate(sourceType);
CREATE INDEX IF NOT EXISTS ProjectCandidate_sourceRunId_idx ON ProjectCandidate(sourceRunId);
CREATE INDEX IF NOT EXISTS AgentTaskRun_status_leaseExpiresAt_idx ON AgentTaskRun(status, leaseExpiresAt);
CREATE UNIQUE INDEX IF NOT EXISTS AgentTaskRun_workflowRunId_key ON AgentTaskRun(workflowRunId);
`;

execFileSync("sqlite3", [absoluteDbPath, postMigrationSql], { stdio: "inherit" });

console.log(`Initialized SQLite database at ${absoluteDbPath}`);

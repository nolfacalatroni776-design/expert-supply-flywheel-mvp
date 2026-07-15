-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rawDemand" TEXT NOT NULL,
    "domain" TEXT,
    "taskType" TEXT,
    "quantity" INTEGER,
    "budgetMin" DOUBLE PRECISION,
    "budgetMax" DOUBLE PRECISION,
    "languagesJson" TEXT NOT NULL DEFAULT '[]',
    "regionsJson" TEXT NOT NULL DEFAULT '[]',
    "riskLevel" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "personaJson" TEXT NOT NULL DEFAULT '{}',
    "searchQueriesJson" TEXT NOT NULL DEFAULT '[]',
    "supplyGoalJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expert" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "affiliation" TEXT,
    "domainTagsJson" TEXT NOT NULL DEFAULT '[]',
    "languagesJson" TEXT NOT NULL DEFAULT '[]',
    "region" TEXT,
    "contactJson" TEXT NOT NULL DEFAULT '{}',
    "sourceUrl" TEXT,
    "evidenceLevel" TEXT NOT NULL DEFAULT 'E0',
    "consentState" TEXT NOT NULL DEFAULT 'unknown',
    "riskFlagsJson" TEXT NOT NULL DEFAULT '[]',
    "expertType" TEXT NOT NULL DEFAULT 'external',
    "lastActiveAt" TIMESTAMP(3),
    "qualitySummaryJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectCandidate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'sourced',
    "fitScore" INTEGER,
    "scoringJson" TEXT NOT NULL DEFAULT '{}',
    "risksJson" TEXT NOT NULL DEFAULT '[]',
    "missingJson" TEXT NOT NULL DEFAULT '[]',
    "nextAction" TEXT,
    "humanReviewNeeded" BOOLEAN NOT NULL DEFAULT true,
    "sourceType" TEXT NOT NULL DEFAULT 'external',
    "sourceRunId" TEXT,
    "conversionProbability" DOUBLE PRECISION,
    "rankReasonJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchResult" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "searchRunId" TEXT,
    "query" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "domain" TEXT,
    "position" INTEGER,
    "sourceType" TEXT NOT NULL DEFAULT 'public_web',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchCache" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "resultsJson" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "expertId" TEXT NOT NULL,
    "candidateId" TEXT,
    "claim" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceTitle" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'public_web',
    "snippet" TEXT NOT NULL,
    "evidenceLevel" TEXT NOT NULL DEFAULT 'E1',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachDraft" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "replyTemplatesJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrialTask" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "rubricJson" TEXT NOT NULL DEFAULT '{}',
    "score" DOUBLE PRECISION,
    "outcome" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrialTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpertSignal" (
    "id" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidenceLevel" TEXT NOT NULL DEFAULT 'E1',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpertEngagementEvent" (
    "id" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "projectId" TEXT,
    "candidateId" TEXT,
    "eventType" TEXT NOT NULL,
    "channel" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertEngagementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpertQualityMetric" (
    "id" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "projectId" TEXT,
    "metricType" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpertQualityMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplySearchRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "goalJson" TEXT NOT NULL DEFAULT '{}',
    "queriesJson" TEXT NOT NULL DEFAULT '[]',
    "summaryJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplySearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplyGap" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "gapType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "requiredCount" INTEGER NOT NULL,
    "availableCount" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplyGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchSourceMetric" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "searchRunId" TEXT,
    "query" TEXT NOT NULL,
    "domain" TEXT,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "e2PlusCount" INTEGER NOT NULL DEFAULT 0,
    "approvedCount" INTEGER NOT NULL DEFAULT 0,
    "trialCount" INTEGER NOT NULL DEFAULT 0,
    "onboardedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchSourceMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpertMergeCandidate" (
    "id" TEXT NOT NULL,
    "primaryExpertId" TEXT NOT NULL,
    "duplicateExpertId" TEXT NOT NULL,
    "reasonJson" TEXT NOT NULL DEFAULT '{}',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpertMergeCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentOutcome" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL DEFAULT 0,
    "sourcedCount" INTEGER NOT NULL DEFAULT 0,
    "approvedCount" INTEGER NOT NULL DEFAULT 0,
    "contactedCount" INTEGER NOT NULL DEFAULT 0,
    "trialCount" INTEGER NOT NULL DEFAULT 0,
    "onboardedCount" INTEGER NOT NULL DEFAULT 0,
    "summaryJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitmentOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "objective" TEXT NOT NULL DEFAULT 'recruit_experts',
    "audienceJson" TEXT NOT NULL DEFAULT '[]',
    "channelsJson" TEXT NOT NULL DEFAULT '[]',
    "messageBrief" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingPost" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "hashtagsJson" TEXT NOT NULL DEFAULT '[]',
    "riskNotesJson" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTaskRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "planJson" TEXT NOT NULL DEFAULT '{}',
    "contextSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "reportJson" TEXT NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentTaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTaskStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "order" INTEGER NOT NULL,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "inputJson" TEXT NOT NULL DEFAULT '{}',
    "outputJson" TEXT NOT NULL DEFAULT '{}',
    "checksJson" TEXT NOT NULL DEFAULT '{}',
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTaskStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Expert_name_idx" ON "Expert"("name");

-- CreateIndex
CREATE INDEX "Expert_expertType_idx" ON "Expert"("expertType");

-- CreateIndex
CREATE INDEX "Expert_lastActiveAt_idx" ON "Expert"("lastActiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "Expert_sourceUrl_key" ON "Expert"("sourceUrl");

-- CreateIndex
CREATE INDEX "ProjectCandidate_stage_idx" ON "ProjectCandidate"("stage");

-- CreateIndex
CREATE INDEX "ProjectCandidate_sourceType_idx" ON "ProjectCandidate"("sourceType");

-- CreateIndex
CREATE INDEX "ProjectCandidate_sourceRunId_idx" ON "ProjectCandidate"("sourceRunId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectCandidate_projectId_expertId_key" ON "ProjectCandidate"("projectId", "expertId");

-- CreateIndex
CREATE INDEX "SearchResult_projectId_idx" ON "SearchResult"("projectId");

-- CreateIndex
CREATE INDEX "SearchResult_searchRunId_idx" ON "SearchResult"("searchRunId");

-- CreateIndex
CREATE INDEX "SearchResult_url_idx" ON "SearchResult"("url");

-- CreateIndex
CREATE UNIQUE INDEX "SearchResult_projectId_url_key" ON "SearchResult"("projectId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "SearchCache_query_key" ON "SearchCache"("query");

-- CreateIndex
CREATE INDEX "SearchCache_expiresAt_idx" ON "SearchCache"("expiresAt");

-- CreateIndex
CREATE INDEX "EvidenceItem_expertId_idx" ON "EvidenceItem"("expertId");

-- CreateIndex
CREATE INDEX "EvidenceItem_candidateId_idx" ON "EvidenceItem"("candidateId");

-- CreateIndex
CREATE INDEX "EvidenceItem_evidenceLevel_idx" ON "EvidenceItem"("evidenceLevel");

-- CreateIndex
CREATE INDEX "OutreachDraft_candidateId_idx" ON "OutreachDraft"("candidateId");

-- CreateIndex
CREATE INDEX "OutreachDraft_status_idx" ON "OutreachDraft"("status");

-- CreateIndex
CREATE INDEX "TrialTask_candidateId_idx" ON "TrialTask"("candidateId");

-- CreateIndex
CREATE INDEX "TrialTask_outcome_idx" ON "TrialTask"("outcome");

-- CreateIndex
CREATE INDEX "ExpertSignal_expertId_idx" ON "ExpertSignal"("expertId");

-- CreateIndex
CREATE INDEX "ExpertSignal_type_idx" ON "ExpertSignal"("type");

-- CreateIndex
CREATE INDEX "ExpertSignal_evidenceLevel_idx" ON "ExpertSignal"("evidenceLevel");

-- CreateIndex
CREATE INDEX "ExpertEngagementEvent_expertId_idx" ON "ExpertEngagementEvent"("expertId");

-- CreateIndex
CREATE INDEX "ExpertEngagementEvent_projectId_idx" ON "ExpertEngagementEvent"("projectId");

-- CreateIndex
CREATE INDEX "ExpertEngagementEvent_candidateId_idx" ON "ExpertEngagementEvent"("candidateId");

-- CreateIndex
CREATE INDEX "ExpertEngagementEvent_eventType_idx" ON "ExpertEngagementEvent"("eventType");

-- CreateIndex
CREATE INDEX "ExpertQualityMetric_expertId_idx" ON "ExpertQualityMetric"("expertId");

-- CreateIndex
CREATE INDEX "ExpertQualityMetric_projectId_idx" ON "ExpertQualityMetric"("projectId");

-- CreateIndex
CREATE INDEX "ExpertQualityMetric_metricType_idx" ON "ExpertQualityMetric"("metricType");

-- CreateIndex
CREATE INDEX "SupplySearchRun_projectId_idx" ON "SupplySearchRun"("projectId");

-- CreateIndex
CREATE INDEX "SupplySearchRun_runType_idx" ON "SupplySearchRun"("runType");

-- CreateIndex
CREATE INDEX "SupplySearchRun_status_idx" ON "SupplySearchRun"("status");

-- CreateIndex
CREATE INDEX "SupplyGap_projectId_idx" ON "SupplyGap"("projectId");

-- CreateIndex
CREATE INDEX "SupplyGap_severity_idx" ON "SupplyGap"("severity");

-- CreateIndex
CREATE INDEX "SupplyGap_status_idx" ON "SupplyGap"("status");

-- CreateIndex
CREATE INDEX "SearchSourceMetric_projectId_idx" ON "SearchSourceMetric"("projectId");

-- CreateIndex
CREATE INDEX "SearchSourceMetric_searchRunId_idx" ON "SearchSourceMetric"("searchRunId");

-- CreateIndex
CREATE INDEX "SearchSourceMetric_domain_idx" ON "SearchSourceMetric"("domain");

-- CreateIndex
CREATE INDEX "ExpertMergeCandidate_status_idx" ON "ExpertMergeCandidate"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ExpertMergeCandidate_primaryExpertId_duplicateExpertId_key" ON "ExpertMergeCandidate"("primaryExpertId", "duplicateExpertId");

-- CreateIndex
CREATE INDEX "RecruitmentOutcome_projectId_idx" ON "RecruitmentOutcome"("projectId");

-- CreateIndex
CREATE INDEX "RecruitmentOutcome_createdAt_idx" ON "RecruitmentOutcome"("createdAt");

-- CreateIndex
CREATE INDEX "MarketingCampaign_projectId_idx" ON "MarketingCampaign"("projectId");

-- CreateIndex
CREATE INDEX "MarketingCampaign_status_idx" ON "MarketingCampaign"("status");

-- CreateIndex
CREATE INDEX "MarketingPost_projectId_idx" ON "MarketingPost"("projectId");

-- CreateIndex
CREATE INDEX "MarketingPost_campaignId_idx" ON "MarketingPost"("campaignId");

-- CreateIndex
CREATE INDEX "MarketingPost_channel_idx" ON "MarketingPost"("channel");

-- CreateIndex
CREATE INDEX "MarketingPost_status_idx" ON "MarketingPost"("status");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

-- CreateIndex
CREATE INDEX "AgentTaskRun_projectId_idx" ON "AgentTaskRun"("projectId");

-- CreateIndex
CREATE INDEX "AgentTaskRun_intent_idx" ON "AgentTaskRun"("intent");

-- CreateIndex
CREATE INDEX "AgentTaskRun_status_idx" ON "AgentTaskRun"("status");

-- CreateIndex
CREATE INDEX "AgentTaskRun_createdAt_idx" ON "AgentTaskRun"("createdAt");

-- CreateIndex
CREATE INDEX "AgentTaskStep_runId_idx" ON "AgentTaskStep"("runId");

-- CreateIndex
CREATE INDEX "AgentTaskStep_status_idx" ON "AgentTaskStep"("status");

-- CreateIndex
CREATE INDEX "AgentTaskStep_stepKey_idx" ON "AgentTaskStep"("stepKey");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTaskStep_runId_stepKey_key" ON "AgentTaskStep"("runId", "stepKey");

-- AddForeignKey
ALTER TABLE "ProjectCandidate" ADD CONSTRAINT "ProjectCandidate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCandidate" ADD CONSTRAINT "ProjectCandidate_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectCandidate" ADD CONSTRAINT "ProjectCandidate_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "SupplySearchRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchResult" ADD CONSTRAINT "SearchResult_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchResult" ADD CONSTRAINT "SearchResult_searchRunId_fkey" FOREIGN KEY ("searchRunId") REFERENCES "SupplySearchRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceItem" ADD CONSTRAINT "EvidenceItem_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ProjectCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ProjectCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrialTask" ADD CONSTRAINT "TrialTask_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ProjectCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertSignal" ADD CONSTRAINT "ExpertSignal_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertEngagementEvent" ADD CONSTRAINT "ExpertEngagementEvent_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertEngagementEvent" ADD CONSTRAINT "ExpertEngagementEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertEngagementEvent" ADD CONSTRAINT "ExpertEngagementEvent_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ProjectCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertQualityMetric" ADD CONSTRAINT "ExpertQualityMetric_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertQualityMetric" ADD CONSTRAINT "ExpertQualityMetric_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplySearchRun" ADD CONSTRAINT "SupplySearchRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyGap" ADD CONSTRAINT "SupplyGap_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchSourceMetric" ADD CONSTRAINT "SearchSourceMetric_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchSourceMetric" ADD CONSTRAINT "SearchSourceMetric_searchRunId_fkey" FOREIGN KEY ("searchRunId") REFERENCES "SupplySearchRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertMergeCandidate" ADD CONSTRAINT "ExpertMergeCandidate_primaryExpertId_fkey" FOREIGN KEY ("primaryExpertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpertMergeCandidate" ADD CONSTRAINT "ExpertMergeCandidate_duplicateExpertId_fkey" FOREIGN KEY ("duplicateExpertId") REFERENCES "Expert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentOutcome" ADD CONSTRAINT "RecruitmentOutcome_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPost" ADD CONSTRAINT "MarketingPost_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTaskRun" ADD CONSTRAINT "AgentTaskRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTaskStep" ADD CONSTRAINT "AgentTaskStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentTaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

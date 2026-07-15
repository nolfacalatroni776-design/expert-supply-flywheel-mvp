CREATE TABLE "AgentToolReceipt" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argumentDigest" TEXT NOT NULL,
    "approvalId" TEXT,
    "idempotencyClass" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "provider" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "resultSummaryJson" TEXT NOT NULL DEFAULT '{}',
    "errorCategory" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentToolReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentToolReceipt_toolCallId_key" ON "AgentToolReceipt"("toolCallId");
CREATE INDEX "AgentToolReceipt_runId_idx" ON "AgentToolReceipt"("runId");
CREATE INDEX "AgentToolReceipt_stepId_idx" ON "AgentToolReceipt"("stepId");
CREATE INDEX "AgentToolReceipt_status_idx" ON "AgentToolReceipt"("status");
CREATE INDEX "AgentToolReceipt_approvalId_idx" ON "AgentToolReceipt"("approvalId");
CREATE INDEX "AgentToolReceipt_provider_idx" ON "AgentToolReceipt"("provider");

ALTER TABLE "AgentToolReceipt" ADD CONSTRAINT "AgentToolReceipt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentTaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentToolReceipt" ADD CONSTRAINT "AgentToolReceipt_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "AgentTaskStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

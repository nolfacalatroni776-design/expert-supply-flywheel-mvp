ALTER TABLE "AgentTaskRun" ADD COLUMN "workflowRunId" TEXT;

ALTER TABLE "AgentTaskStep" ADD COLUMN "confirmationDecision" TEXT;
ALTER TABLE "AgentTaskStep" ADD COLUMN "confirmationReason" TEXT;
ALTER TABLE "AgentTaskStep" ADD COLUMN "decidedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AgentTaskRun_workflowRunId_key" ON "AgentTaskRun"("workflowRunId");

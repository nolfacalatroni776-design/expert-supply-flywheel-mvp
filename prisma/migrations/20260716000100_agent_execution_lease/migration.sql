-- Add execution ownership and recovery metadata for durable Agent task runs.
ALTER TABLE "AgentTaskRun" ADD COLUMN "executionToken" TEXT;
ALTER TABLE "AgentTaskRun" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "AgentTaskRun" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
ALTER TABLE "AgentTaskRun" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AgentTaskStep" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "AgentTaskRun_status_leaseExpiresAt_idx" ON "AgentTaskRun"("status", "leaseExpiresAt");

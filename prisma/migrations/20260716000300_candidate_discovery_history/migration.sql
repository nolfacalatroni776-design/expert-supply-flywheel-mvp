CREATE TABLE "CandidateDiscovery" (
    "id" TEXT NOT NULL,
    "searchRunId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "evidenceLevel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateDiscovery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CandidateDiscovery_searchRunId_candidateId_key"
ON "CandidateDiscovery"("searchRunId", "candidateId");

CREATE INDEX "CandidateDiscovery_searchRunId_idx" ON "CandidateDiscovery"("searchRunId");
CREATE INDEX "CandidateDiscovery_candidateId_idx" ON "CandidateDiscovery"("candidateId");

ALTER TABLE "CandidateDiscovery"
ADD CONSTRAINT "CandidateDiscovery_searchRunId_fkey"
FOREIGN KEY ("searchRunId") REFERENCES "SupplySearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CandidateDiscovery"
ADD CONSTRAINT "CandidateDiscovery_candidateId_fkey"
FOREIGN KEY ("candidateId") REFERENCES "ProjectCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "CandidateDiscovery" ("id", "searchRunId", "candidateId", "sourceUrl", "evidenceLevel", "createdAt")
SELECT
    'disc_' || md5(candidate."sourceRunId" || ':' || candidate."id"),
    candidate."sourceRunId",
    candidate."id",
    expert."sourceUrl",
    expert."evidenceLevel",
    candidate."createdAt"
FROM "ProjectCandidate" candidate
JOIN "Expert" expert ON expert."id" = candidate."expertId"
WHERE candidate."sourceRunId" IS NOT NULL
ON CONFLICT ("searchRunId", "candidateId") DO NOTHING;

INSERT INTO "CandidateDiscovery" ("id", "searchRunId", "candidateId", "sourceUrl", "evidenceLevel", "createdAt")
SELECT DISTINCT
    'disc_' || md5((step."outputJson"::jsonb ->> 'runId') || ':' || (preview.item ->> 'candidateId')),
    step."outputJson"::jsonb ->> 'runId',
    preview.item ->> 'candidateId',
    NULLIF(preview.item ->> 'sourceUrl', ''),
    NULLIF(preview.item ->> 'evidenceLevel', ''),
    step."createdAt"
FROM "AgentTaskStep" step
CROSS JOIN LATERAL jsonb_array_elements(
    CASE
        WHEN jsonb_typeof(step."outputJson"::jsonb -> 'candidatePreview') = 'array'
        THEN step."outputJson"::jsonb -> 'candidatePreview'
        ELSE '[]'::jsonb
    END
) AS preview(item)
JOIN "SupplySearchRun" search_run ON search_run."id" = step."outputJson"::jsonb ->> 'runId'
JOIN "ProjectCandidate" candidate ON candidate."id" = preview.item ->> 'candidateId'
WHERE step."stepKey" IN ('external_research', 'search_candidates')
  AND NULLIF(step."outputJson"::jsonb ->> 'runId', '') IS NOT NULL
ON CONFLICT ("searchRunId", "candidateId") DO NOTHING;

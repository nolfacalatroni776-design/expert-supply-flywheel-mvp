CREATE TABLE "SearchResultOccurrence" (
    "id" TEXT NOT NULL,
    "searchRunId" TEXT NOT NULL,
    "searchResultId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchResultOccurrence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SearchResultOccurrence_searchRunId_searchResultId_query_key" ON "SearchResultOccurrence"("searchRunId", "searchResultId", "query");
CREATE INDEX "SearchResultOccurrence_searchRunId_idx" ON "SearchResultOccurrence"("searchRunId");
CREATE INDEX "SearchResultOccurrence_searchResultId_idx" ON "SearchResultOccurrence"("searchResultId");
CREATE INDEX "SearchResultOccurrence_provider_idx" ON "SearchResultOccurrence"("provider");

ALTER TABLE "SearchResultOccurrence" ADD CONSTRAINT "SearchResultOccurrence_searchRunId_fkey" FOREIGN KEY ("searchRunId") REFERENCES "SupplySearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SearchResultOccurrence" ADD CONSTRAINT "SearchResultOccurrence_searchResultId_fkey" FOREIGN KEY ("searchResultId") REFERENCES "SearchResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

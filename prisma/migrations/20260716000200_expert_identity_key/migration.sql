ALTER TABLE "Expert" ADD COLUMN "identityKey" TEXT;

UPDATE "Expert"
SET "identityKey" = CASE
  WHEN "sourceUrl" IS NULL OR BTRIM("sourceUrl") = '' THEN 'expert:' || "id"
  WHEN "sourceUrl" ~* '^https?://(www\.)?github\.com/[^/]+/?$'
    OR "sourceUrl" ~* '^https?://([^/]+\.)?linkedin\.com/in/[^/?#]+/?$'
    THEN LOWER(RTRIM("sourceUrl", '/'))
  ELSE LOWER(RTRIM("sourceUrl", '/')) || '#person=' || LOWER(REGEXP_REPLACE("name", '\s+', '', 'g'))
END;

ALTER TABLE "Expert" ALTER COLUMN "identityKey" SET NOT NULL;

DROP INDEX "Expert_sourceUrl_key";
CREATE UNIQUE INDEX "Expert_identityKey_key" ON "Expert"("identityKey");
CREATE INDEX "Expert_sourceUrl_idx" ON "Expert"("sourceUrl");

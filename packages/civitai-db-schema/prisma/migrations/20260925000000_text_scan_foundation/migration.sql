-- Text scan foundation. Additive only. Apply by hand BEFORE any deploy of a branch containing it:
-- the regenerated client selects "nsfwLevel" on every full-row EntityModeration return.
-- No prompt rows are seeded here: policy text is inserted through the text-scan harness.
-- Nullable, no default: catalog-only, but the ALTER still needs an ACCESS EXCLUSIVE lock. The timeout
-- stops it queueing behind a long transaction and stalling every EntityModeration read; re-run on timeout.
SET lock_timeout = '3s';
ALTER TABLE "EntityModeration" ADD COLUMN IF NOT EXISTS "nsfwLevel" INTEGER;
RESET lock_timeout;

CREATE TABLE IF NOT EXISTS "TextScanPrompt" (
  "id" SERIAL PRIMARY KEY,
  "key" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "note" TEXT,
  "createdById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "TextScanPrompt_key_id_idx" ON "TextScanPrompt" ("key", "id" DESC);

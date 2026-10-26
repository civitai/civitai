-- Idempotent: applied by hand, possibly more than once.
--
-- Who took a Creator Services deal file, and when. Apply BEFORE deploying: the moderator deal-files
-- read selects from this table.

DO $$ BEGIN
  CREATE TYPE "ServiceDealAccessRole" AS ENUM ('Buyer', 'Seller', 'Moderator');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ServiceDealAccessKind" AS ENUM ('Download', 'PreviewView', 'ModeratorFetch');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ServiceDealFileAccess" (
  "id" SERIAL PRIMARY KEY,
  "dealId" INTEGER NOT NULL,
  "fileId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "role" "ServiceDealAccessRole" NOT NULL,
  "kind" "ServiceDealAccessKind" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ServiceDealFileAccess_dealId_role_createdAt_idx"
  ON "ServiceDealFileAccess" ("dealId", "role", "createdAt");
CREATE INDEX IF NOT EXISTS "ServiceDealFileAccess_fileId_idx" ON "ServiceDealFileAccess" ("fileId");

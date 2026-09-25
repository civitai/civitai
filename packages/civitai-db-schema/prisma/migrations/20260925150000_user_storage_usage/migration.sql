-- Creator storage usage rollups, read by Creator Studio's /analytics/storage page.
--
-- 🔴 APPLY THIS BEFORE THE PR THAT ADDS `storage-usage-*` JOBS MERGES. The main app deploys on
-- merge and those jobs write these tables from their first tick.
--
-- No foreign key to "User": adding one locks "User" while the constraint validates, and a row for a
-- deleted user is harmless — the nightly job prunes them.
--
-- Timestamps are UTC wall-clock, written as timezone('UTC', now()), so no session TimeZone can skew them.

CREATE TABLE "UserStorageUsage" (
  "userId" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "publicStatus" TEXT NOT NULL,
  "baseModel" TEXT NOT NULL DEFAULT '',
  "month" DATE NOT NULL,
  "fileCount" INTEGER NOT NULL,
  "bytes" BIGINT NOT NULL,
  "computedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),
  CONSTRAINT "UserStorageUsage_pkey" PRIMARY KEY ("userId", "kind", "publicStatus", "baseModel", "month")
);

CREATE TABLE "UserStorageRollup" (
  "userId" INTEGER NOT NULL,
  "imagesRequestedAt" TIMESTAMP(3),
  "imagesStartedAt" TIMESTAMP(3),
  "imagesComputedAt" TIMESTAMP(3),
  CONSTRAINT "UserStorageRollup_pkey" PRIMARY KEY ("userId")
);

-- Partial, so the every-minute claim reads only pending rows, not every creator who ever opened the
-- page. The claim query repeats this predicate verbatim; the planner uses the index only if it does.
CREATE INDEX "UserStorageRollup_pending_idx" ON "UserStorageRollup" ("imagesRequestedAt")
  WHERE "imagesComputedAt" IS NULL OR "imagesRequestedAt" > "imagesComputedAt";

CREATE TABLE "UserStorageSnapshot" (
  "userId" INTEGER NOT NULL,
  "date" DATE NOT NULL,
  "kind" TEXT NOT NULL,
  "fileCount" INTEGER NOT NULL,
  "bytes" BIGINT NOT NULL,
  CONSTRAINT "UserStorageSnapshot_pkey" PRIMARY KEY ("userId", "date", "kind")
);

-- The nightly change-only snapshot reads each creator's latest row per kind.
CREATE INDEX "UserStorageSnapshot_userId_kind_date_idx" ON "UserStorageSnapshot" ("userId", "kind", "date" DESC);

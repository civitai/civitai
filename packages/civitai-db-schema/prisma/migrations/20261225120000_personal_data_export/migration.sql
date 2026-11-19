-- Personal-data export requests: one row per request, kept as the log after the archive expires.
--
-- Apply this BEFORE deploying the code: the moderator app inserts into it and the
-- build-personal-data-exports job reads it.

CREATE TABLE "PersonalDataExport" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "requestedById" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "modNotesMode" TEXT NOT NULL DEFAULT 'text-redacted-separate-file',
  "holdReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "archiveKey" TEXT,
  "modNotesKey" TEXT,
  "manifest" JSONB,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "builtAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "linkExpiresAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releasedById" INTEGER,
  CONSTRAINT "PersonalDataExport_status_check"
    CHECK ("status" IN ('queued', 'building', 'built', 'held', 'failed', 'released')),
  CONSTRAINT "PersonalDataExport_modNotesMode_check"
    CHECK ("modNotesMode" IN ('text-redacted-separate-file', 'count')),
  -- A release is a logged act: who and when, together.
  CONSTRAINT "PersonalDataExport_release_logged_check"
    CHECK (("status" = 'released') = ("releasedAt" IS NOT NULL AND "releasedById" IS NOT NULL))
);

CREATE INDEX "PersonalDataExport_userId_idx" ON "PersonalDataExport" ("userId");
CREATE INDEX "PersonalDataExport_status_idx" ON "PersonalDataExport" ("status");

-- At most one export in flight per user: a second queue while one is queued or building fails on
-- this index, which is what the moderator app's "already queued" answer relies on.
CREATE UNIQUE INDEX "PersonalDataExport_userId_in_flight_key"
  ON "PersonalDataExport" ("userId")
  WHERE "status" IN ('queued', 'building');

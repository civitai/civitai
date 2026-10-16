-- Text-scan verdicts held for a moderator (first label: csam). The text-scan callback inserts a Pending
-- row per (entity, label, scanned text), unless an earlier chat hold already covers the window.
-- A moderator dismisses or confirms it in the moderator app.
--
-- HAND-APPLIED. Apply before the csam label mode is set to `review`: the callback writes here only in
-- that mode, and a missing table fails the callback (the retry cron then rescans).

DO $$ BEGIN
  CREATE TYPE "TextScanHoldStatus" AS ENUM ('Pending', 'Dismissed', 'Confirmed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "TextScanHold" (
  "id"           SERIAL PRIMARY KEY,
  "entityType"   TEXT NOT NULL,
  "entityId"     INTEGER NOT NULL,
  "label"        TEXT NOT NULL,
  "textHash"     TEXT NOT NULL,
  "status"       "TextScanHoldStatus" NOT NULL DEFAULT 'Pending',
  "userId"       INTEGER,
  "text"         TEXT NOT NULL,
  "reason"       TEXT NOT NULL,
  "workflowId"   TEXT,
  "promptId"     INTEGER,
  "contentAt"    TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  "decidedAt"    TIMESTAMP(3),
  "decidedById"  INTEGER,
  "decisionNote" TEXT,
  "hiddenAt"     TIMESTAMP(3),
  "restoredAt"   TIMESTAMP(3),
  "meta"         JSONB
);

-- A rescan of unchanged text must not reopen a decided hold or queue a second pending one.
CREATE UNIQUE INDEX IF NOT EXISTS "TextScanHold_entityType_entityId_label_textHash_key"
  ON "TextScanHold" ("entityType", "entityId", "label", "textHash");
CREATE INDEX IF NOT EXISTS "TextScanHold_status_createdAt_idx"
  ON "TextScanHold" ("status", "createdAt");
-- Partial: decided rows accumulate and the queue never reads them.
CREATE INDEX IF NOT EXISTS "TextScanHold_pending_createdAt_idx"
  ON "TextScanHold" ("createdAt") WHERE "status" = 'Pending';

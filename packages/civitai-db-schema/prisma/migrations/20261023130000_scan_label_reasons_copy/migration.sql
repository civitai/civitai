-- Block reasons on scan label votes, and bookkeeping for the copy of reviewed images.
--
-- Apply before the build that ships it: the vote action writes "reasonComment" and the copy job writes
-- the copy columns. Which items may be copied is decided by the "ScanLabelCopyEligibility" view, which
-- is applied separately and is not part of this repository; until it exists the copy job copies nothing.
--
-- The two vote constraints are NOT VALID: votes cast before reasons existed have none, and only
-- rows written from now on are checked. NOT VALID skips the table scan but still takes a brief
-- ACCESS EXCLUSIVE lock.

ALTER TABLE "ScanLabelVote"
  ADD COLUMN IF NOT EXISTS "reasonComment" TEXT;

-- 🔴 Mirrors BLOCK_REASONS in apps/moderator/src/lib/scan-labels.ts; change both together.
ALTER TABLE "ScanLabelVote" DROP CONSTRAINT IF EXISTS "ScanLabelVote_reason_check";
ALTER TABLE "ScanLabelVote" ADD CONSTRAINT "ScanLabelVote_reason_check" CHECK (
  "reason" IS NULL OR "reason" IN (
    'minor-sexual', 'minor-photoreal', 'minor-violence', 'real-person',
    'bestiality', 'non-consent', 'graphic-violence', 'other'
  )
) NOT VALID;

ALTER TABLE "ScanLabelVote" DROP CONSTRAINT IF EXISTS "ScanLabelVote_reason_required_check";
ALTER TABLE "ScanLabelVote" ADD CONSTRAINT "ScanLabelVote_reason_required_check" CHECK (
  ("block" = ("reason" IS NOT NULL))
  AND ("reason" IS DISTINCT FROM 'other' OR length(btrim("reasonComment")) > 0)
) NOT VALID;

ALTER TABLE "ScanLabelItem"
  ADD COLUMN IF NOT EXISTS "copyState" TEXT CHECK ("copyState" IN ('copied', 'skipped', 'failed')),
  ADD COLUMN IF NOT EXISTS "copyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "copiedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "copyError" TEXT;

-- Appends "reasons"; CREATE OR REPLACE VIEW may only add columns at the end.
CREATE OR REPLACE VIEW "ScanLabelExport" AS
SELECT
  i."id"          AS "itemId",
  i."imageId",
  img."url"       AS "mediaKey",
  img."pHash",
  i."lane",
  i."outcome",
  i."votes",
  i."blockVotes",
  i."unanimous",
  i."decidedAt",
  i."actionedAt",
  f."workflowIds",
  f."flaggerVersions",
  f."flags",
  i."actionResult",
  r."reasons"
FROM "ScanLabelItem" i
JOIN "Image" img ON img."id" = i."imageId"
CROSS JOIN LATERAL (
  SELECT
    array_agg(fl."workflowId" ORDER BY fl."flaggedAt")                  AS "workflowIds",
    array_agg(DISTINCT fl."flaggerVersion")                             AS "flaggerVersions",
    jsonb_agg(
      jsonb_build_object(
        'source', fl."source",
        'flaggerVersion', fl."flaggerVersion",
        'workflowId', fl."workflowId",
        'flaggedAt', fl."flaggedAt",
        'snapshot', fl."snapshot"
      )
      ORDER BY fl."flaggedAt"
    )                                                                   AS "flags"
  FROM "ScanLabelFlag" fl
  WHERE fl."itemId" = i."id"
) f
CROSS JOIN LATERAL (
  SELECT jsonb_agg(
    jsonb_build_object('reason', v."reason", 'comment', v."reasonComment")
    ORDER BY v."createdAt"
  ) FILTER (WHERE v."block")                                            AS "reasons"
  FROM "ScanLabelVote" v
  WHERE v."itemId" = i."id"
) r
WHERE i."status" = 'decided';

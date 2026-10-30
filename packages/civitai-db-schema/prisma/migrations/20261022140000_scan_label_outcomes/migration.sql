-- Majority-block bookkeeping and the label view.
--
-- Apply any time after 20261022130000_scan_label_queue, and before the build that ships the
-- majority-block sweep: it writes both new columns.

ALTER TABLE "ScanLabelItem"
  ADD COLUMN IF NOT EXISTS "actionStartedAt" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "actionResult" TEXT
    CHECK ("actionResult" IN ('blocked', 'already-blocked', 'image-missing'));

-- Rows disappear with the image (FK cascade); this is not a durable archive.
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
  i."actionResult"
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
WHERE i."status" = 'decided';

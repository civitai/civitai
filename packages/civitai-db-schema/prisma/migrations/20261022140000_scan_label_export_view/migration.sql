-- One row per decided scan label item: the label, plus what identifies the image and every flag on
-- it. Labels only; nothing here copies media. Rows disappear with the image (FK cascade).
--
-- Apply any time after 20261022130000_scan_label_queue. CREATE OR REPLACE VIEW takes no lock on the
-- underlying tables beyond the catalog update.

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
  f."flags"
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

-- Collapse the workflowId-keyed ScannerScanReview + ScannerReview into a
-- single (contentHash, version, label)-keyed ScannerLabelReview, matching
-- the AggregatingMergeTree dedup unit on the ClickHouse side. A mod now
-- verdicts a *decision* once instead of each duplicate scan.
--
-- ClickHouse-side change is hand-applied:
--   DROP TABLE scanner_label_results;
--   CREATE TABLE scanner_label_results (...AggregatingMergeTree...);
-- See docs/features/scanner-prompt-tuning.md for the new table definition.

DROP TABLE IF EXISTS "ScannerReview";
DROP TABLE IF EXISTS "ScannerScanReview";

CREATE TABLE "ScannerLabelReview" (
  "id"          SERIAL          PRIMARY KEY,
  "contentHash" TEXT            NOT NULL,
  "version"     TEXT            NOT NULL,
  "label"       TEXT            NOT NULL,
  "reviewedBy"  INTEGER         NOT NULL,
  "reviewedAt"  TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verdict"     "ReviewVerdict" NOT NULL,
  "note"        TEXT
);

CREATE UNIQUE INDEX "ScannerLabelReview_contentHash_version_label_reviewedBy_key"
  ON "ScannerLabelReview"("contentHash", "version", "label", "reviewedBy");

CREATE INDEX "ScannerLabelReview_verdict_label_idx"
  ON "ScannerLabelReview"("verdict", "label");

CREATE INDEX "ScannerLabelReview_reviewedAt_idx"
  ON "ScannerLabelReview"("reviewedAt");

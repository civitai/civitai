-- Scanner Audit / Prompt-Tuning review tables.
--
-- Stores per-label moderator verdicts (FP/FN/TP/TN/Unsure) on scanner results
-- and per-scan review-completion markers. Joins to ClickHouse
-- `scanner_label_results` by workflowId (string FK, not enforced).

CREATE TYPE "ReviewVerdict" AS ENUM (
  'TruePositive',
  'FalsePositive',
  'TrueNegative',
  'FalseNegative',
  'Unsure'
);

CREATE TABLE "ScannerScanReview" (
  "id"         SERIAL       PRIMARY KEY,
  "workflowId" TEXT         NOT NULL,
  "reviewedBy" INTEGER      NOT NULL,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"       TEXT
);

CREATE UNIQUE INDEX "ScannerScanReview_workflowId_reviewedBy_key"
  ON "ScannerScanReview"("workflowId", "reviewedBy");

CREATE INDEX "ScannerScanReview_reviewedAt_idx"
  ON "ScannerScanReview"("reviewedAt");

CREATE TABLE "ScannerReview" (
  "id"         SERIAL          PRIMARY KEY,
  "workflowId" TEXT            NOT NULL,
  "label"      TEXT            NOT NULL,
  "reviewedBy" INTEGER         NOT NULL,
  "reviewedAt" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verdict"    "ReviewVerdict" NOT NULL,
  "note"       TEXT
);

CREATE UNIQUE INDEX "ScannerReview_workflowId_label_reviewedBy_key"
  ON "ScannerReview"("workflowId", "label", "reviewedBy");

CREATE INDEX "ScannerReview_workflowId_idx"
  ON "ScannerReview"("workflowId");

CREATE INDEX "ScannerReview_verdict_label_idx"
  ON "ScannerReview"("verdict", "label");

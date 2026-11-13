-- The 'csam-realistic' block reason and the 'csam-held' action result.
--
-- Apply before the build that ships it, with 20261230140100_scan_label_csam_hold_label_store: the vote
-- action writes the new reason and the hold sweep writes the new action result. Both constraints are
-- NOT VALID: only rows written from now on are checked. NOT VALID skips the table scan but still takes
-- a brief ACCESS EXCLUSIVE lock.

-- 🔴 Mirrors BLOCK_REASONS in apps/moderator/src/lib/scan-labels.ts; change both together.
ALTER TABLE "ScanLabelVote" DROP CONSTRAINT IF EXISTS "ScanLabelVote_reason_check";
ALTER TABLE "ScanLabelVote" ADD CONSTRAINT "ScanLabelVote_reason_check" CHECK (
  "reason" IS NULL OR "reason" IN (
    'minor-sexual', 'csam-realistic', 'minor-photoreal', 'minor-violence', 'real-person',
    'bestiality', 'non-consent', 'graphic-violence', 'other'
  )
) NOT VALID;

ALTER TABLE "ScanLabelItem" DROP CONSTRAINT IF EXISTS "ScanLabelItem_actionResult_check";
ALTER TABLE "ScanLabelItem" ADD CONSTRAINT "ScanLabelItem_actionResult_check" CHECK (
  "actionResult" IN ('blocked', 'already-blocked', 'image-missing', 'csam-held')
) NOT VALID;

-- Adds 'school-nsfw' to ScanLabelVote_reason_check.
-- Apply before the build that ships it: a vote the CHECK refuses is not recorded.
-- Apply AFTER 20261230140000_scan_label_csam_hold, which sets this same constraint without
-- 'school-nsfw'; applying it later would drop the reason again.
-- NOT VALID skips the table scan but still takes a brief ACCESS EXCLUSIVE lock.

-- 🔴 Mirrors BLOCK_REASONS in apps/moderator/src/lib/scan-labels.ts; change both together.
ALTER TABLE "ScanLabelVote" DROP CONSTRAINT IF EXISTS "ScanLabelVote_reason_check";
ALTER TABLE "ScanLabelVote" ADD CONSTRAINT "ScanLabelVote_reason_check" CHECK (
  "reason" IS NULL OR "reason" IN (
    'minor-sexual', 'minor-photoreal', 'minor-violence', 'real-person', 'bestiality', 'non-consent',
    'graphic-violence', 'other', 'school-nsfw', 'csam-realistic'
  )
) NOT VALID;

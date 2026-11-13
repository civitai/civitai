-- The access request a personal-data export answers: its help-desk ticket, when it came from one,
-- and the date the user asked, which starts the response deadline. Both are set when the export is
-- queued; a refusal for a held account reports them to Legal.
--
-- Apply AFTER 20261225120000_personal_data_export, and BEFORE deploying the code that writes these
-- columns. Hand-applied. Nullable with no default: no backfill, and no table rewrite.
-- Dry run: the whole file inside BEGIN; ... ROLLBACK;.

ALTER TABLE "PersonalDataExport"
  ADD COLUMN "ticketId" INTEGER,
  ADD COLUMN "requestedAt" DATE;

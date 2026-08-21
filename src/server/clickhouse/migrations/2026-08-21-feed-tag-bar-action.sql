-- Feed tag bar click-through — ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the app code that emits `Feed_TagBar_Click` is deployed. We do
-- not auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 ORDER IS LOAD-BEARING AND THE FAILURE IS SILENT. `actions.type` is an Enum16. The app
-- POSTs to the tracker service, which inserts; a value the column does not carry is rejected
-- THERE, so the browser sees a successful beacon, the app logs nothing, and the row simply
-- never exists. The bar would ship looking instrumented and produce zero rows to judge it by
-- — which is the one outcome the 10%-click-through deal cannot survive.
--
-- 21 is the last index in use ('Generator_JobLinked'), so this appends at 22. Appending at an
-- unused index is a metadata-only ALTER: no data is rewritten and no mutation is scheduled. Do
-- NOT renumber or rename any existing value; that WOULD rewrite the whole table.
--
-- `actions` has no dependent materialized view (verified 2026-08-21 against
-- `system.tables`), so unlike the `views` widening there is no MV whose SELECT also has to be
-- updated with MODIFY QUERY. If that ever changes, a widened source column with a stale MV
-- query drops the new value at the MV instead — same silent shape, different place.

ALTER TABLE default.actions
  MODIFY COLUMN `type` Enum16(
    'AddToBounty_Click' = 1,
    'AddToBounty_Confirm' = 2,
    'AwardBounty_Click' = 3,
    'AwardBounty_Confirm' = 4,
    'Tip_Click' = 5,
    'Tip_Confirm' = 6,
    'TipInteractive_Click' = 7,
    'TipInteractive_Cancel' = 8,
    'NotEnoughFunds' = 9,
    'PurchaseFunds_Cancel' = 10,
    'PurchaseFunds_Confirm' = 11,
    'LoginRedirect' = 12,
    'Membership_Cancel' = 13,
    'CSAM_Help_Triggered' = 14,
    'Membership_Downgrade' = 15,
    'ProfanitySearch' = 16,
    'BuzzLimit_Set' = 17,
    'Model_Create_Click' = 18,
    'Image_Remix_Click' = 19,
    'Generator_Submit' = 20,
    'Generator_JobLinked' = 21,
    'Feed_TagBar_Click' = 22
  );

-- Verify the value landed before deploying. This must return 1 row:
--
--   SELECT 1 FROM system.columns
--   WHERE database = 'default' AND table = 'actions' AND name = 'type'
--     AND position(type, 'Feed_TagBar_Click') > 0;
--
-- And after the deploy, that rows are actually arriving:
--
--   SELECT count() FROM actions WHERE type = 'Feed_TagBar_Click' AND time > now() - INTERVAL 1 HOUR;

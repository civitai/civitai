-- Creator announcement analytics — ClickHouse DDL (link clicks + mute/unmute).
--
-- Apply this MANUALLY, BEFORE the app code that emits `Announcement_Click` is deployed. We do
-- not auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 ORDER IS LOAD-BEARING AND THE FAILURE IS SILENT. `actions.type` is an Enum16. The app
-- POSTs to the tracker service, which inserts; a value the column does not carry is rejected
-- THERE, so the browser sees a successful beacon, the app logs nothing, and the row simply
-- never exists. The click half of the creator's analytics page would then read a permanent
-- zero that is indistinguishable from "nobody clicked".
--
-- 22 is the last index in use ('Feed_TagBar_Click'), so these append at 23-25. Appending at an
-- unused index is a metadata-only ALTER: no data is rewritten and no mutation is scheduled. Do
-- NOT renumber or rename any existing value; that WOULD rewrite the whole table.
--
-- `actions` still has no dependent materialized view (re-verified 2026-09-04 against
-- `system.tables`), and this change deliberately does not add one: an MV over `actions` would
-- put a MODIFY QUERY obligation on every future widening of this column, and the read this
-- feeds does not need it. `actions` is 92.8M rows all-time / 590,896 in the last day, ordered
-- (time, type), and the per-creator read filters on `type` over ~100 announcements site-wide.

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
    'Feed_TagBar_Click' = 22,
    'Announcement_Click' = 23,
    'Announcement_Mute' = 24,
    'Announcement_Unmute' = 25
  );

-- Verify the value landed before deploying. This must return 1 row:
--
--   SELECT 1 FROM system.columns
--   WHERE database = 'default' AND table = 'actions' AND name = 'type'
--     AND position(type, 'Announcement_Click') > 0
--     AND position(type, 'Announcement_Mute') > 0
--     AND position(type, 'Announcement_Unmute') > 0;
--
-- 🔴 And after the deploy, check that rows arrive with a CONTROL that can fail. A bare count of
-- the new type returns 0 both when the ALTER never ran and when nobody has clicked yet — the
-- same observation, two different causes. Pair it with a type that is known to be flowing, over
-- the same window, so a zero on BOTH means "the window is empty" rather than "this is broken":
--
--   SELECT countIf(type = 'Announcement_Click') AS announcement,
--          countIf(type = 'Generator_Submit')   AS control
--   FROM actions WHERE time > now() - INTERVAL 1 HOUR;

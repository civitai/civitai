-- `/apps/build` developer funnel — ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the app code that emits `AppsBuild_Action` is deployed. We do
-- not auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 ORDER IS LOAD-BEARING AND THE FAILURE IS SILENT. `actions.type` is an Enum16. The app
-- POSTs to `/api/track/batch`, which hands the row to the tracker service; a value the column
-- does not carry is rejected THERE, so the browser sees a 200, the app logs nothing, and the
-- row simply never exists. Deployed before this runs, the funnel reads a permanent zero that
-- is indistinguishable from "nobody clicked" — which is the exact reading this arc exists to
-- stop anyone making, since the funnel's whole purpose is to tell a dead step from an unused
-- one.
--
-- 26 is the last index in use ('App_Open'), so this appends at 27. Appending at an unused
-- index is a metadata-only ALTER: no data is rewritten and no mutation is scheduled. Do NOT
-- renumber or rename any existing value; that WOULD rewrite the whole table.
--
-- 🔴 RE-VERIFY that `actions` still has no dependent materialized view before applying,
-- rather than trusting this line. It had none as of 2026-09-05
-- (2026-09-04-announcement-click-action.sql checked `system.tables` directly), but an MV
-- added since would put a `MODIFY QUERY` obligation on this widening. This change adds none.
--
-- ONE TYPE, FOUR STEPS. The funnel step lives in `details.action`
-- ('view' | 'request_access' | 'cli_copy' | 'create_entry') and the page state in
-- `details.state` ('pitch' | 'first-app' | 'workbench'), both closed `z.enum`s in
-- `src/server/schema/track.schema.ts`. `details` is a `String` column, so a FIFTH funnel step
-- later is a zod change with NO DDL — which is the reason this is one enum value and not
-- four. `Feed_TagBar_Click` (= 22) is the existing precedent for a type whose `details`
-- carries the discriminator.

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
    'Announcement_Unmute' = 25,
    'App_Open' = 26,
    'AppsBuild_Action' = 27
  );

-- Verification, AFTER applying (the widening is metadata-only, so this returns immediately):
--
--   SHOW CREATE TABLE default.actions;
--     -- must show 'AppsBuild_Action' = 27, and every value 1..26 unchanged.
--
-- Positive control once the app is deployed — load /apps/build, then:
--
--   SELECT details, count() FROM default.actions
--    WHERE type = 'AppsBuild_Action' AND time > now() - INTERVAL 1 HOUR
--    GROUP BY details;
--     -- must be non-zero, and must show at least one `"action":"view"` row. A zero here
--     -- after a real page load means the EMITTER is not wired, NOT that the enum is
--     -- missing: this file is what rules the enum out. Read the pair, never the zero alone.

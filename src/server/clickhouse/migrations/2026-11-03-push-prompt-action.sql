-- Push opt-in funnel — ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the app code that emits `Push_Prompt` is deployed. We do not
-- auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 THE FAILURE IS SILENT. `actions.type` is an Enum16, and a value the column does not carry
-- is rejected at the tracker service, so the browser sees a 200, the app logs nothing, and the
-- row never exists: the opt-in rate would read a permanent zero. Only the new type is lost.
--
-- 28 is the last index in use ('UserMenu_Click', 2026-10-21-user-menu-click-action.sql), so this
-- appends at 29. Appending at an unused index is a metadata-only ALTER. Do NOT renumber or rename
-- any existing value; that WOULD rewrite the whole table. Re-read `SHOW CREATE TABLE
-- default.actions` first: if prod already carries a value at 29, renumber this one, not that.
--
-- Re-check for a dependent materialized view before applying (`system.tables`
-- `dependencies_table`): one added since would need a `MODIFY QUERY` alongside this.
--
-- ONE TYPE. The funnel step, surface, variant and platform live in `details` as closed `z.enum`s
-- in `src/server/schema/track.schema.ts`, so a new step later needs no DDL.
--
-- 🔴 APPLYING THE DDL IS HALF THE OPERATION. `civitai-clickhouse-tracker` reads the column
-- schema when its pods connect and never again, so until they restart it still rejects the new
-- value. See ./README.md.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.

-- Verify, AFTER applying:
--
--   SHOW CREATE TABLE default.actions;
--     -- must show 'Push_Prompt' = 29, and every value 1..28 unchanged.
--
-- Positive control once the tracker is restarted and the app deployed: as a user who never
-- pressed "Not now", open /user/account on a browser that was never asked about notifications
-- (the settings card records `shown`), wait for the batch to flush, then:
--
--   SELECT countIf(type = 'Push_Prompt') AS push,
--          countIf(type = 'Generator_Submit') AS control
--   FROM default.actions WHERE time > now() - INTERVAL 1 HOUR;
--     -- push must be non-zero beside a non-zero control.

-- No trailing semicolon and nothing after the statement: ClickHouse rejects the file as a
-- multi-statement query otherwise, so it can be run as-is.
--
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
    'AppsBuild_Action' = 27,
    'UserMenu_Click' = 28,
    'Push_Prompt' = 29
  )

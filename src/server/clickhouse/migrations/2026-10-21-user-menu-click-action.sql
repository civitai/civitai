-- User menu v2 item opens — ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the app code that emits `UserMenu_Click` is deployed. We do not
-- auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 THE FAILURE IS SILENT. `actions.type` is an Enum16, and a value the column does not carry
-- is rejected at the tracker service, so the browser sees a 200, the app logs nothing, and the
-- row never exists: the menu would read a permanent zero, indistinguishable from "nobody
-- clicked". Only the new type is lost. Measured: while `Announcement_Click` was being rejected
-- (2026-09-04 to 09-07), `Generator_Submit` and `Model_Create_Click` kept their usual daily
-- counts, so an early deploy costs this type's rows and breaks nothing else.
--
-- 27 is the last index in use ('AppsBuild_Action', read from prod `system.columns` on
-- 2026-10-21), so this appends at 28. Appending at an unused index is a metadata-only ALTER: no
-- data is rewritten and no mutation is scheduled. Do NOT renumber or rename any existing value;
-- that WOULD rewrite the whole table.
--
-- `actions` had no dependent materialized view on 2026-10-21 (`system.tables`
-- `dependencies_table` empty; the same read on `views` lists its seven). Re-check before
-- applying: an MV added since would need a `MODIFY QUERY` alongside this.
--
-- ONE TYPE. The item id, its group, whether it was opened from the Pinned section and the
-- surface live in `details` as closed `z.enum`s in `src/server/schema/track.schema.ts`, so a new
-- menu item later needs no DDL.
--
-- 🔴 APPLYING THE DDL IS HALF THE OPERATION. `civitai-clickhouse-tracker` reads the column
-- schema when its pods connect and never again, so until they restart it still rejects the new
-- value and the type collects ZERO rows. Measured twice (`Announcement_Click`, `App_Open`). See
-- ./README.md.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.

-- Verify, AFTER applying (metadata-only, returns immediately):
--
--   SHOW CREATE TABLE default.actions;
--     -- must show 'UserMenu_Click' = 28, and every value 1..27 unchanged.
--
-- Positive control once the tracker is RESTARTED and the app deployed: open an item from the
-- user menu (v2 flag on), wait for the batch to flush (3s, or leave the page), then:
--
--   SELECT countIf(type = 'UserMenu_Click') AS menu,
--          countIf(type = 'Generator_Submit') AS control
--   FROM default.actions WHERE time > now() - INTERVAL 1 HOUR;
--     -- menu must be non-zero. A zero beside a non-zero control after a real click means the
--     -- emitter or the tracker restart is missing; a zero on both means the window is empty.

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
    'UserMenu_Click' = 28
  )

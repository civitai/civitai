-- Image upload actions — ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE the app code that emits `ImageUpload` is deployed. We do not
-- auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 THE FAILURE IS SILENT. `actions.type` is an Enum16, and a value the column does not carry
-- is rejected at the tracker service: the upload succeeds and the row never exists. See
-- 2026-10-21-user-menu-click-action.sql for the measured precedent.
--
-- 28 is the last index in use ('UserMenu_Click', read from prod `system.columns` on
-- 2026-10-28), so this appends at 29. Appending at an unused index is a metadata-only ALTER: no
-- data is rewritten and no mutation is scheduled. Do NOT renumber or rename any existing value.
--
-- Re-check `system.tables` `dependencies_table` for `actions` before applying: a materialized view
-- added since 2026-10-21 would need a `MODIFY QUERY` alongside this.
--
-- One row per upload key the server mints (presign, multipart and relay routes), carrying the
-- requesting user and IP; `details` is `{"key": "<the key that becomes Image.url>"}`.
--
-- 🔴 APPLYING THE DDL IS HALF THE OPERATION. `civitai-clickhouse-tracker` reads the column
-- schema when its pods connect and never again, so restart it after applying. See ./README.md.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.

-- Verify, AFTER applying (metadata-only, returns immediately):
--
--   SHOW CREATE TABLE default.actions;
--     -- must show 'ImageUpload' = 29, and every value 1..28 unchanged.
--
-- Positive control once the tracker is RESTARTED and the app deployed: upload an image, then:
--
--   SELECT countIf(type = 'ImageUpload') AS uploads,
--          countIf(type = 'Generator_Submit') AS control
--   FROM default.actions WHERE time > now() - INTERVAL 1 HOUR;
--     -- uploads must be non-zero. A zero beside a non-zero control after a real upload means the
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
    'UserMenu_Click' = 28,
    'ImageUpload' = 29
  )

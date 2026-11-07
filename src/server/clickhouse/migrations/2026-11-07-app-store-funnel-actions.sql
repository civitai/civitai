-- App store acquisition funnel — ClickHouse DDL.
--
-- 🔴 MANUAL. Apply this by hand, BEFORE the app code that emits `AppStore_Action` or `App_Visit` is
-- deployed, then restart `civitai-clickhouse-tracker` (pod delete). We do not auto-run DDL. Until
-- both are done the tracker rejects the new values SILENTLY: the browser sees a 200, the app logs
-- nothing, the off-site redirect still redirects (its insert is fire-and-forget), and every funnel
-- query reads zero. See ./README.md.
--
-- ORDER: apply AFTER 2026-11-04-experiment-exposure-hat-turf-actions.sql, which takes 30
-- ('Experiment_Exposure') and 31 ('HatTurf_Action'). This file restates every value 1..31 and
-- appends 32 and 33. MODIFY COLUMN replaces the whole definition, so this file must restate every
-- live value; applied first, the 2026-11-04 ALTER would drop 32 and 33.
--
-- 🔴 BEFORE APPLYING, re-read prod: `SELECT type FROM system.columns WHERE database = 'default' AND
-- table = 'actions' AND name = 'type'`. It must list exactly 1..31 as below. Any other value (a
-- type another PR applied since) must be added here at its live index first, and 32/33 moved past
-- it, or this ALTER drops it. Appending at unused indices is a metadata-only ALTER: no data is
-- rewritten and no mutation is scheduled. Do NOT renumber or rename an existing value; that WOULD
-- rewrite the whole table.
--
-- Re-check before applying: `system.tables` `dependencies_table` for `actions` must still be empty.
-- A materialized view added since would need a `MODIFY QUERY` alongside this.
--
-- Both types keep actor metadata (userId / ip / userAgent) like `App_Open`: `App_Visit` rows are
-- de-duplicated per user (or IP) per day at read time the same way plays are. Their fields live in
-- `details` (src/server/schema/track.schema.ts and app-listing-visit.service.ts), so a new funnel
-- step needs no DDL.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.

-- Verify, AFTER applying (metadata-only, returns immediately):
--
--   SHOW CREATE TABLE default.actions;
--     -- must show 'AppStore_Action' = 32 and 'App_Visit' = 33, and every value 1..31 unchanged.
--
-- Positive control once the tracker is RESTARTED and the app deployed: open the app store, let a
-- card sit on screen for a second, click a card, then follow an off-site listing's "Visit", wait
-- for the batch to flush (3s, or leave the page), then:
--
--   SELECT countIf(toString(type) = 'AppStore_Action') AS store_actions,
--          countIf(toString(type) = 'App_Visit') AS visits,
--          countIf(toString(type) = 'App_Open') AS control
--   FROM default.actions WHERE time > now() - INTERVAL 1 HOUR;
--     -- store_actions and visits must be non-zero. A zero beside a non-zero control after a real
--     -- click means the tracker restart is missing.

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
    'Push_Prompt' = 29,
    'Experiment_Exposure' = 30,
    'HatTurf_Action' = 31,
    'AppStore_Action' = 32,
    'App_Visit' = 33
  )

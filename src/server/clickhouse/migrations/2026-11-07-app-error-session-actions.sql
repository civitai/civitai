-- App Blocks in-app telemetry (`App_Error`, `App_Session`) — ClickHouse DDL.
--
-- 🔴 MANUAL. Apply this by hand, then restart `civitai-clickhouse-tracker` (pod delete). We do not
-- auto-run DDL. Until both are done the tracker rejects the two new values SILENTLY: the browser
-- sees a 200, the app logs nothing, and the in-app error and session readouts read zero,
-- indistinguishable from "no errors" and "nobody used it". Nothing else breaks while it is missing:
-- the emitting code is fire-and-forget and other action rows in the same batch are unaffected.
-- See ./README.md.
--
-- ORDER: apply AFTER 2026-11-04-experiment-exposure-hat-turf-actions.sql, which takes 30
-- ('Experiment_Exposure') and 31 ('HatTurf_Action'). This file restates every live value and
-- appends 32 and 33; applied first, that file's ALTER would drop these two. MODIFY COLUMN replaces
-- the whole definition, so this file must restate every live value.
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
-- Both types are written without ip and userAgent (`ACTOR_META_FREE_ACTION_TYPES` in
-- src/server/clickhouse/tracker.ts). Their fields live in `details`
-- (src/server/schema/track.schema.ts): App_Error {appBlockId, reason, stage}, App_Session
-- {appBlockId, host, durationMs, submits, messagesToHost}.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.

-- Verify, AFTER applying (metadata-only, returns immediately):
--
--   SHOW CREATE TABLE default.actions;
--     -- must show 'App_Error' = 32 and 'App_Session' = 33, and every value 1..31 unchanged.
--
-- Positive control once the tracker is RESTARTED and the app deployed: open any app at
-- /apps/run/<slug>, leave the page (navigate away or close the tab), then:
--
--   SELECT countIf(type = 'App_Session') AS sessions,
--          countIf(type = 'Generator_Submit') AS control
--   FROM default.actions WHERE time > now() - INTERVAL 1 HOUR;
--     -- sessions must be non-zero. A zero beside a non-zero control after a real visit means the
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
    'Push_Prompt' = 29,
    'Experiment_Exposure' = 30,
    'HatTurf_Action' = 31,
    'App_Error' = 32,
    'App_Session' = 33
  )

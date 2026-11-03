-- UI experiment exposures and Hat Turf interactions — ClickHouse DDL.
--
-- 🔴 MANUAL. Apply this by hand, BEFORE the app code that emits `Experiment_Exposure` or
-- `HatTurf_Action` is deployed, then restart `civitai-clickhouse-tracker` (pod delete). We do not
-- auto-run DDL. Until both are done the tracker rejects the new values SILENTLY: the browser sees a
-- 200, the app logs nothing, and the experiment readout reads zero exposures, indistinguishable
-- from "nobody saw it". See ./README.md.
--
-- ORDER: apply AFTER 2026-11-03-push-prompt-action.sql (civitai/civitai#7584), which takes 29
-- ('Push_Prompt'). This file restates it and appends 30 and 31; applied first, the push-prompt
-- ALTER would drop these two. Prod's last index on 2026-11-03 was 28 ('UserMenu_Click'), read from
-- `system.columns`. Appending at unused indices is a metadata-only ALTER: no data is
-- rewritten and no mutation is scheduled. Do NOT renumber or rename an existing value; that WOULD
-- rewrite the whole table.
--
-- Re-check before applying: `system.tables` `dependencies_table` for `actions` must still be empty.
-- A materialized view added since would need a `MODIFY QUERY` alongside this.
--
-- Both types are written without ip and userAgent (`ACTOR_META_FREE_ACTION_TYPES` in
-- src/server/clickhouse/tracker.ts): `actions` has no TTL. Their fields live in `details`
-- (src/server/schema/track.schema.ts), so a new experiment or Hat Turf action needs no DDL.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.

-- Verify, AFTER applying (metadata-only, returns immediately):
--
--   SHOW CREATE TABLE default.actions;
--     -- must show 'Push_Prompt' = 29, 'Experiment_Exposure' = 30 and 'HatTurf_Action' = 31, and
--     -- every value 1..28 unchanged.
--
-- Positive control once the tracker is RESTARTED and the app deployed: as a signed-in user, open
-- a page whose experimental UI is on screen (or a moderator with the `civ-exp` preview cookie),
-- wait for the batch to flush (3s, or leave the page), then:
--
--   SELECT countIf(type = 'Experiment_Exposure') AS exposures,
--          countIf(type = 'Generator_Submit') AS control
--   FROM default.actions WHERE time > now() - INTERVAL 1 HOUR;
--     -- exposures must be non-zero. A zero beside a non-zero control after a real view means the
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
    'HatTurf_Action' = 31
  )

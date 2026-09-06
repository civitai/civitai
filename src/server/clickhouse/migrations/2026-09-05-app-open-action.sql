-- App store play count — ClickHouse DDL (on-site app launches).
--
-- Apply this MANUALLY, BEFORE the app code that emits `App_Open` is deployed. We do not
-- auto-run DDL (same policy as the Postgres migrations).
--
-- 🔴 ORDER IS LOAD-BEARING AND THE FAILURE IS SILENT. `actions.type` is an Enum16. The app
-- POSTs to the tracker service, which inserts; a value the column does not carry is rejected
-- THERE, so the caller sees a successful send, the app logs nothing, and the row simply never
-- exists. The store card's play count would then read a permanent zero that is
-- indistinguishable from "nobody opened this app" — and unlike a chart nobody reads, that
-- zero is printed on a public marketplace card next to the review count.
--
-- 25 is the last index in use ('Announcement_Unmute'), so this appends at 26. Appending at an
-- unused index is a metadata-only ALTER: no data is rewritten and no mutation is scheduled. Do
-- NOT renumber or rename any existing value; that WOULD rewrite the whole table.
--
-- `actions` still has no dependent materialized view (asserted by the same reasoning as
-- 2026-09-04-announcement-click-action.sql, which re-verified it against `system.tables`;
-- 🔴 RE-VERIFY BEFORE APPLYING rather than trusting this line — an MV added since would put a
-- MODIFY QUERY obligation on this widening). This change deliberately does not add one: the
-- rollup that consumes these rows is the `AppListing` metric processor, which queries
-- `actions` directly on the same batched schedule as every other ClickHouse-derived counter.
--
-- WHY `actions` RATHER THAN A NEW TABLE: a play is a low-volume, id-only interaction, and
-- `actions` already carries the actor columns (userId/ip/userAgent) plus no TTL — so the rows
-- outlive the rollup that reads them, which is what makes `open_count` RECOMPUTABLE rather
-- than a ±1 counter that can drift with nothing to repair it from. That property is the
-- reason this arc uses an event stream at all; see the ownership contract in
-- src/server/metrics/appListing.metrics.ts.
--
-- The emitted `details` carries `{ appBlockId }` — a pure id, never author text — and the
-- rollup joins it to `app_listings.app_block_id` (which is `@unique`).

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
    'App_Open' = 26
  );

-- Verification, AFTER applying (the widening is metadata-only, so this returns immediately):
--
--   SHOW CREATE TABLE default.actions;
--     -- must show 'App_Open' = 26, and every value 1..25 unchanged.
--
-- Positive control once the app is deployed — open an on-site app at /apps/run/<slug>, then:
--
--   SELECT count() FROM default.actions WHERE type = 'App_Open' AND time > now() - INTERVAL 1 HOUR;
--     -- must be non-zero. A zero here after a real launch means the emitter is not wired,
--     -- NOT that the enum is missing: this file is what rules the enum out.

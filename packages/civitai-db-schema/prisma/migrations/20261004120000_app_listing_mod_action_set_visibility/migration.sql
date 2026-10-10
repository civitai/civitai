-- ============================================================
-- Per-listing VISIBILITY LEVEL: widen the app_listing_moderation_events action CHECK
-- ============================================================
-- Adds ONE moderation action:
--   * 'set-visibility' — a MODERATOR set another owner's per-listing visibility LEVEL
--     (`setListingVisibilityAsModerator`). Like 'message-owner' and 'purge-user-storage'
--     it changes NO listing state: `app_listings.status` is untouched and the act is
--     confined to the `visibility` column, so it must never displace the event that
--     explains a removal (which is what `republishOwnListing`'s last-event guard reads).
--
--     `reason`  — the moderator's required rationale (3..1000 chars). Surfaced in the
--                 OWNER's own history, which is the whole point: a moderator changing who
--                 can find someone's app must not be silent to them.
--     `before`  — { visibility: <level|null> }, the pre-state.
--                 🔴 `null` IS A REAL VALUE HERE and means "no choice expressed" — it is
--                 NOT the `private` level. Recording an unset level as `private` would
--                 misreport what the moderator actually changed.
--     `after`   — { visibility: <level> }.
--
--     🔴 NEITHER SNAPSHOT CARRIES `status`, deliberately. Every sibling action records a
--     status transition because that is what it changed; this one changes none, so a
--     `status` key would describe a transition that did not happen.
--
-- 🔴 WITHOUT THIS WIDEN THE FAILURE MODE IS THE GOOD ONE — THE SAME ONE AS THE MIGRATION
-- THIS FILE FOLLOWS, and this comment asserted the OPPOSITE until round 4 of the audit.
-- `purge-user-storage` writes its audit row BEFORE deleting anything, so a missing widen
-- means the rows are never purged. This action reaches the same place by a different route:
-- `setListingVisibilityAsModerator` runs the level `UPDATE` and the event INSERT on ONE
-- interactive transaction, so a 23514 on the event ABORTS that transaction and the `UPDATE`
-- rolls back with it. A missing widen therefore means every moderator visibility change 500s
-- and NOTHING is written — no level change, no audit row, and no retry asymmetry (the level
-- is unchanged, so a retry is simply the first attempt again).
--
-- ⚠️ THE RETRACTED VERSION READ: "the level write COMMITS FIRST (`applyVisibility`'s raw
-- `UPDATE` plus a catalog-cache bust) and the event is written after, so a missing widen
-- means the listing's discoverability changed and NO audit row exists. The retry is worse
-- than the first attempt: the level now already equals the requested one, so
-- `applyVisibility` short-circuits `changed: false` and the proc returns 200." That was an
-- accurate description of the code as it shipped — the level write and the event WERE two
-- round trips, and that is the incident the write service's own docblocks record — and it
-- outlived the round-1 fix that put both on one transaction (and moved the bust to AFTER the
-- commit, so the bust cannot precede the event either). ⚠️ It is NOT the same event as the
-- hand probe MEASURED below, which only establishes that the constraint is live and lacks
-- this action. It is recorded rather than deleted because the
-- wrong version inverts the remediation: a maintainer deploying without this DDL would plan
-- a data reconciliation over `app_listings.visibility` for orphaned level changes that
-- cannot exist. Correcting a comment here changes NO DDL; the statements below are untouched.
--
-- MEASURED on the prod nvme0 primary 2026-10-04, before this file existed: inserting a
-- 'set-visibility' row was rejected with 23514 against
-- `app_listing_mod_events_action_check`, while the same INSERT with 'delist' succeeded
-- (both rolled back) — i.e. the constraint is live and this action is not in it. That
-- probe also showed the CHECK there still allows only the TEN actions through
-- 'message-owner': the 20260912 'purge-user-storage' widen has NOT been applied to prod
-- yet. This file's IN-list is a strict superset of BOTH, so applying it is additive either
-- way and brings that pending action along.
--
-- Postgres cannot modify a CHECK in place -> DROP then ADD. ADDITIVE: the new IN-list is a
-- strict SUPERSET of the old one, so no existing row can violate it (nothing to backfill or
-- re-validate).
--
-- ⚠️ MANUAL APPLY — per datapacket-talos CLAUDE.md DB rule #8 the main civitai CNPG nvme0
-- DB does NOT auto-apply migrations (no `prisma migrate deploy`). This file is committed for
-- HISTORY ONLY; a HUMAN applies the SQL below per environment (psql/retool). CI / deploy do
-- NOT run it. ✅ BOTH TARGETS APPLIED 2026-10-05 — the evidence is the block immediately
-- below; this list is retained because it is what a REPROVISIONED environment must still do:
--   1. prod nvme0    (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- ============================================================
-- ✅ APPLIED 2026-10-05 TO BOTH ENVIRONMENTS — EVIDENCE, NOT AN UNDATED ASSERTION
-- ============================================================
-- The ORDERING bullets below are kept as HISTORY (they record why the sequencing was
-- timing-sharp) and are marked DONE rather than deleted. This block is the apply record;
-- an undated "it has been applied" sentence is the same unscoped-state-claim defect this
-- file corrected elsewhere, so the evidence is here with the date.
--
--   WHAT RAN: this file's COMMITTED BYTES piped into `psql -v ON_ERROR_STOP=1` on each
--   primary — the PROD nvme0 primary (resolved by role at apply time, not from a doc) and
--   the DEV CLONE primary. Both returned `BEGIN / ALTER TABLE / ALTER TABLE / COMMIT`.
--   🔴 Instance names are deliberately NOT recorded here: this is a PUBLIC repository, and
--   naming which instance holds the production primary is an infrastructure detail the
--   evidence does not need. Resolve the primary by role at apply time instead.
--
--   LIVE CONSTRAINT ON BOTH, read back after the commit: **12 actions**, `set-visibility`
--   present, `purge-user-storage` present — the pending 20260912 widen rode along exactly
--   as the superset IN-list intended.
--
--   VERIFIED BY REPRODUCING THE ORIGINAL SYMPTOM, WITH A NEGATIVE CONTROL, BOTH ROLLED
--   BACK: `action='set-visibility'` → `INSERT 0 1` (this exact insert raised 23514 before
--   the apply), and `action='zz-bogus'` → rejected, 23514, against the same constraint —
--   i.e. the CHECK is still enforcing and the success is the widen, not a dropped
--   constraint. Row counts unchanged either side: prod 23, dev 61.
--
--   PRE-FLIGHT, measured before applying: 0 existing rows would violate the new IN-list,
--   0 conflicting locks, 0 transactions older than 30s. The table is small enough on prod
--   that the ACCESS EXCLUSIVE validation scan was effectively instantaneous — MEASURE it
--   rather than assuming, because that lock blocks reads and writes for the scan's duration
--   and a queued exclusive lock piles every later reader up behind it.
--
--   THE DEV-REFRESH WARNING NO LONGER APPLIES TO THIS WIDEN. The dev clone is re-created
--   weekly from prod backups, and the refresh preceding this apply ran 2026-10-04.
--   Because PROD now carries
--   the widen, the next refresh INHERITS it rather than wiping it — the bullet below is
--   retained because it is still the correct rule for the NEXT hand-applied dev-only DDL.
--
-- 🔴 ORDERING — timing-sharp, and sharper than its predecessors for the reason above.
-- ✅ BOTH BULLETS SATISFIED by the apply recorded above; kept as the reasoning, not as a
-- to-do:
--   * ✅ DONE — Apply to the DEV CLONE **before** a PR preview exercises
--     `appListings.setListingVisibilityAsModerator`, or the mod proc 500s on the constraint
--     for every moderator visibility CHANGE (preview-DB-drift -> smoke-500 trap). ⚠️ This
--     read "the preview changes a level and 500s on the constraint with no audit row", the
--     same retracted claim as above: the transaction rolls the level back, so the preview is
--     broken but not inconsistent. The ordering requirement is unchanged either way.
--     ⚠️ AND IT READ "for every call", WHICH IS WIDER THAN THE CODE — corrected in round 5
--     to match the header's own wording above. `setListingVisibilityAsModerator` returns at
--     the `if (!applied.changed) return applied;` short-circuit, so an IDEMPOTENT NO-OP
--     (the requested level already stored) never reaches the event INSERT, never hits 23514,
--     and returns 200 whether or not this DDL is applied.
--     🔴 SO A NO-OP IS NOT A VALID SMOKE PROBE FOR THIS WIDEN — and that point stands
--     whatever the apply state. As of the 2026-10-05 apply recorded above, "the mod proc
--     500s" is no longer a live observable either, so a reader using it as the check would
--     read a 200 off a no-op as proof the DDL landed. Probe by reading the constraint itself
--     (`\d+ app_listing_moderation_events` / `pg_get_constraintdef`), not by calling the
--     proc — that is what the apply record above did.
--   * ✅ DONE — Apply to PROD nvme0 **before** this ships (main -> release). The OWNER path
--     is unaffected — it writes no event — so only the moderator proc is gated on this.
--   * ⚠️ STILL THE RULE FOR THE NEXT DEV-ONLY DDL, no longer a risk to THIS one: the dev
--     clone is re-created weekly from prod barman backups, so a hand-applied widen THERE
--     is wiped on the next
--     refresh while one applied to PROD propagates to dev for free. Prefer prod-first.
--     Because prod carries this widen, the next refresh inherits it.
--
-- The migration-agreement unit test
-- (src/server/services/blocks/__tests__/app-listing-mod-action.constants.test.ts) parses
-- the LATEST action-CHECK migration `.sql` (this file, by sorted dir name) and asserts its
-- IN-list equals the code tuple APP_LISTING_MODERATION_ACTIONS, catching code/DDL drift at
-- CI time — but it does NOT apply the DDL. The human apply above is still required.
--
-- Idempotent: DROP IF EXISTS then ADD, so a manual re-run is a no-op.
--
-- Wrapped in a single transaction so the DROP+ADD swap is ATOMIC: without it there is a
-- sub-ms window between DROP and ADD where the table has NO action CHECK and a concurrent
-- bad write could slip through.
BEGIN;
ALTER TABLE "app_listing_moderation_events"
  DROP CONSTRAINT IF EXISTS "app_listing_mod_events_action_check";
ALTER TABLE "app_listing_moderation_events"
  ADD  CONSTRAINT "app_listing_mod_events_action_check"
  CHECK ("action" IN (
    'delist',
    'relist',
    'claim',
    'purge',
    'report-resolve',
    'report-dismiss',
    'reset-to-pending',
    'owner-unpublish',
    'owner-republish',
    'message-owner',
    'purge-user-storage',
    'set-visibility'
  ));
COMMIT;

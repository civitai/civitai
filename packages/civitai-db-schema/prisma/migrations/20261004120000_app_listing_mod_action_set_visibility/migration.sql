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
-- NOT run it. Apply to BOTH:
--   1. prod nvme0    (the live civitai DB)
--   2. the dev clone (cnpg-cluster-dev, ns cnpg-database-dev, db civitai)
--
-- 🔴 ORDERING — timing-sharp, and sharper than its predecessors for the reason above:
--   * Apply to the DEV CLONE **before** a PR preview exercises
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
--     🔴 SO A NO-OP IS NOT A VALID SMOKE PROBE FOR THIS WIDEN. Now that the widen HAS been
--     applied to both environments, "the mod proc 500s" is no longer a live observable
--     either — and a reader using it as the check would read a 200 off a no-op as proof the
--     DDL landed. Probe by reading the constraint itself (`\d+ app_listing_moderation_events`
--     / `pg_get_constraintdef`), not by calling the proc.
--   * Apply to PROD nvme0 **before** this ships (main -> release). The OWNER path is
--     unaffected — it writes no event — so only the moderator proc is gated on this.
--   * ⚠️ The dev clone is re-created weekly from prod barman backups
--     (`cnpg-cluster-dev-refresh`, Sun 03:00 UTC), so a hand-applied widen THERE is wiped
--     on the next refresh while one applied to PROD propagates to dev for free. Prefer
--     prod-first; apply to dev by hand only if a preview needs it before the next refresh.
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

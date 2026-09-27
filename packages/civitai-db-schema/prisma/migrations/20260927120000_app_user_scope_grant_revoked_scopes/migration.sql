-- App Blocks per-scope consent REVOCATION — the suppression list a user's "withdraw
-- this permission" writes, plus the timestamp of the most recent such event.
--
-- 🔴 APPLIED BY HAND, PER ENVIRONMENT. Nothing in CI or the deploy runs migrations in
-- this project, so the image and the schema are never deployed atomically and BOTH
-- orders happen in practice:
--   * Migration first  → a no-op for the running code. Both columns are additive; the
--                        array defaults to empty and the timestamp to NULL, which is
--                        exactly "nothing has been revoked", and no shipped code reads
--                        either column until the new image lands.
--   * Deploy first     → every READ of these columns is P2022-guarded and degrades to
--                        "no revocations recorded", which is the ONLY state a database
--                        without the columns can be in — the true answer, not a guess.
--                        Every WRITE of them THROWS, loudly, naming this migration:
--                        `revokeScopes` (scope-grant.service.ts) catches P2022 and
--                        rethrows with the migration name, because a revoke that
--                        reports success without persisting is the worst available
--                        outcome on a consent surface. The revoke MUTATION is
--                        therefore unavailable until this lands; nothing else is.
--
-- WHY A SUPPRESSION LIST RATHER THAN REMOVAL FROM `granted_scopes`. Removal does not
-- hold: `BlockRegistry.recordInstallConsent` passes the app's whole consent-gated
-- effective set into `recordScopeGrant`, which UNIONS it into `granted_scopes`. A
-- revoke expressed as removal is silently undone by that user's next install or
-- subscribe of the app, with no consent prompt. `revoked_scopes` survives the union,
-- and `getGrantedScopes` subtracts it on every read.
--
-- WHY NOT NULLABLE, AND WHY NO BACKFILL IS NEEDED. An empty array IS the semantic
-- default ("nothing revoked"), so there is no third state a NULL would carry, and a
-- NOT NULL DEFAULT '{}' makes every pre-existing row correct without touching it.
--
-- `ADD COLUMN ... NOT NULL DEFAULT <non-volatile>` is metadata-only in Postgres 11+
-- (the default is stored in the catalog; no table rewrite), as is a NULL column with no
-- default, so both statements take only the brief ACCESS EXCLUSIVE lock for the catalog
-- update. Safe to apply while the site is up.
--
-- DELIBERATELY NO CHECK CONSTRAINT. The sibling `buzz_budget_per_day` migration added
-- one because that column is a NUMBER with a meaningful range the app also enforces in
-- zod. These are scope-string sets: the vocabulary lives in
-- `src/shared/constants/block-scope.constants.ts` and moves with the product (scopes
-- have been added AND removed), so a database-level enum/check would have to be migrated
-- in lockstep with every registry change, and a stale one would refuse a legitimate
-- revoke of a scope the user really holds. Unknown strings are harmless here — a
-- suppression entry that matches no scope suppresses nothing.
ALTER TABLE "app_user_scope_grants"
  ADD COLUMN IF NOT EXISTS "revoked_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "app_user_scope_grants"
  ADD COLUMN IF NOT EXISTS "revoked_scopes_at" TIMESTAMPTZ(6);

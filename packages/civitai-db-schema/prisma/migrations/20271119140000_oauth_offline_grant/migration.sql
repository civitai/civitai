-- ============================================================
-- OAuth offline access as a separate grant (auth hub, flag `oauth-offline-grant`)
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database): a
-- human runs this file against each writable environment, dev first, then production.
--
-- APPLY IT BEFORE turning on the `oauth-offline-grant` flag. The code does not need it before
-- then: all three columns are `@no-type` in `schema.full.prisma`, so neither the Prisma client nor
-- the Kysely types name them, and only flag-on code reads or writes them. The deploy and this
-- migration can land in either order.
--
--   "OauthConsent"."offlineGrantedAt"  When the user approved "stay connected while you're away"
--                                      for this app. NULL = no offline grant. Deleting the consent
--                                      (disconnecting the app) removes it with the row.
--   "ApiKey"."mintOrigin"              How an OAuth `Access` row was minted: 'app_token',
--                                      'auth_code', 'refresh', 'device_code' or
--                                      'client_credentials'. On a `Refresh` row, the grant that
--                                      started its chain ('auth_code' or 'device_code'). NULL on
--                                      rows written before the flag, and on non-OAuth keys.
--   "ApiKey"."refreshFamilyId"         On a `Refresh` row: the id every rotation of one chain
--                                      shares, for reuse detection. NULL on rows written before
--                                      the flag; the first rotation under the flag assigns one.
--
-- Additive and idempotent (`IF NOT EXISTS`): nullable columns with no default, so Postgres adds
-- them without rewriting either table. No backfill. No index: a family is revoked by
-- (userId, clientId, refreshFamilyId), and the existing "ApiKey_userId_idx" narrows that to one
-- user's keys.
--
-- ROLLBACK: turn the flag off. The columns are then never read; dropping them is safe after that.

-- Part 1 — the columns and the CHECK (NOT VALID, so adding it takes no full scan under the lock).
BEGIN;

SET LOCAL lock_timeout = '1s';

ALTER TABLE "OauthConsent" ADD COLUMN IF NOT EXISTS "offlineGrantedAt" TIMESTAMP(3) NULL;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "mintOrigin" TEXT NULL;
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "refreshFamilyId" TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApiKey_mintOrigin_check') THEN
    ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_mintOrigin_check"
      CHECK ("mintOrigin" IS NULL OR "mintOrigin" IN
        ('app_token', 'auth_code', 'refresh', 'device_code', 'client_credentials'))
      NOT VALID;
  END IF;
END $$;

COMMIT;

-- Part 2 — after Part 1 has committed. Idempotent: validating a valid constraint is a no-op. Every
-- existing row is NULL, so it passes; it scans "ApiKey" under a SHARE UPDATE EXCLUSIVE lock, which
-- does not block reads or writes.
ALTER TABLE "ApiKey" VALIDATE CONSTRAINT "ApiKey_mintOrigin_check";

-- ------------------------------------------------------------
-- Verification (read-only). Expect columns = 3, and one constraint with convalidated = t.
-- ------------------------------------------------------------
-- SELECT count(*) AS columns
--   FROM information_schema.columns
--  WHERE table_schema = current_schema()
--    AND ((table_name = 'OauthConsent' AND column_name = 'offlineGrantedAt')
--      OR (table_name = 'ApiKey' AND column_name IN ('mintOrigin', 'refreshFamilyId')));
-- SELECT conname, convalidated
--   FROM pg_constraint
--  WHERE conrelid = '"ApiKey"'::regclass
--    AND conname = 'ApiKey_mintOrigin_check';

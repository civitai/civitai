-- ============================================================
-- App Blocks — DROP the legacy 5-star MARKETPLACE REVIEWS table
-- ============================================================
-- Reverses 20260621120000_app_block_reviews. The 5-star `AppBlockReview`
-- system is superseded by the thumbs-based `AppListingReview`
-- (`app_listing_reviews` + the `app_listing_metrics` rollup), which is what
-- the live store reads and sorts on.
--
-- WHY IT IS SAFE TO DROP RATHER THAN MIGRATE:
--   - The 5-star WRITE form (`<AppBlockReviews>`) had exactly two hosts, and
--     both were unreachable: the `/apps/[appBlockId]` detail route now
--     redirects to the store detail, and `AppDetailsModal` is opened only from
--     `AppBlockCard`, which renders only inside `MarketplaceBody` — a component
--     with no importer in app code since `/apps` swapped to the unified store.
--   - The table is empty in production (the surface never had a lit entry
--     point), so there are no rows to migrate into `app_listing_reviews`.
--
-- ⚠️ MANUAL-APPLY, AND NOT YET APPLIED ANYWHERE. The main civitai DB does NOT
-- run `prisma migrate deploy` — this file is committed for HISTORY only and is
-- applied BY HAND (psql) per environment by a human. Nothing in CI or the
-- deploy pipeline will run it. Apply to:
--   1. prod   (the live civitai DB)
--   2. the dev clone
--
-- ORDERING: apply this AFTER the code change ships. The application no longer
-- references `app_block_reviews` in any query, so the drop is inert once the
-- new image is serving; running it BEFORE the deploy would 500 the THREE legacy
-- marketplace read paths that queried the table at base — `blocks.listAvailable`,
-- `blocks.getAppDetail` AND `blocks.getFeaturedBlocks` (all three projected
-- `avg_rating` off it; listAvailable additionally built the Bayesian `rating`
-- sort key from it). All three are dark but still callable.
--
-- 🔴 APPLYING THIS SPENDS THE REVERT OPTION — IT IS A ONE-WAY DOOR AT THE PR
-- LEVEL. There is no down migration and no backup of the rows. Once the DROP
-- has run, `git revert`ing this PR restores application code that queries a
-- table that no longer exists, so the three read paths above would 500 rather
-- than return to their previous behaviour. Rolling back after the DROP means
-- rolling FORWARD (a new commit), not reverting. Do not conflate this with the
-- store-grid rollback note in `src/pages/apps/index.tsx` — that one stays safe
-- and is unaffected by this file, because it does not depend on the table.
--
-- 🔴 CONFIRM BEFORE RUNNING. This is destructive and there is no undo:
--     SELECT COUNT(*) FROM "app_block_reviews";
--   Expect 0. If it is NOT 0, STOP and migrate the rows into
--   "app_listing_reviews" first — do not drop data on the strength of this
--   comment. That precondition is ENFORCED below rather than left to the
--   operator: the guard block raises and aborts the transaction on a non-empty
--   table, so a mistaken apply cannot silently destroy rows.
--
-- IF-EXISTS guards so a manual re-run is a no-op.

-- ENFORCED PRECONDITION. The "expect 0" check above is a comment, and a comment
-- cannot stop an irreversible DROP — so assert it in SQL instead.
--
-- 🔴 THE EXPLICIT `BEGIN;`/`COMMIT;` BELOW IS LOAD-BEARING — DO NOT REMOVE IT,
-- and do not assume the RAISE alone is enough. A raised exception only stops the
-- rest of the FILE when psql was invoked with `-1`/`--single-transaction` or
-- `-v ON_ERROR_STOP=1`. Under a plain `psql -f migration.sql` — an entirely
-- reasonable way for a human to apply a hand-applied migration — psql runs each
-- statement in its own implicit transaction and CONTINUES PAST AN ERROR: the
-- guard raises, and then the DROPs below execute anyway. Measured: the table and
-- all 3 of its rows were destroyed and psql still exited 0, so the failure is
-- both total and silent. Wrapping the guard and the DROPs in one explicit
-- transaction closes that: the RAISE poisons the transaction, every later
-- statement is rejected with `current transaction is aborted`, and the COMMIT
-- degrades to a ROLLBACK. The guard then holds under EVERY psql invocation
-- rather than only the careful ones.
--
-- Verified on PostgreSQL 17.10 across all 9 combinations of {plain `-f`, `-1`,
-- `-v ON_ERROR_STOP=1`} × {3 rows, empty, already dropped}: the table and its
-- rows survive every non-empty case, and the empty/absent cases drop and no-op
-- as intended. PREFER `psql -v ON_ERROR_STOP=1 -f <this file>` — the data is
-- safe either way, but WITHOUT it psql exits 0 even when the guard refused, so
-- the exit code is not a usable success signal; read the output.
--
-- The existence check is REQUIRED, not belt-and-braces: PL/pgSQL prepares a
-- statement only when control actually reaches it, so the inner COUNT is never
-- planned when the table is already gone. Without the IF, a re-run against an
-- already-dropped table would raise `relation does not exist` and break the
-- no-op re-run property the IF EXISTS guards below are there to provide.
-- `to_regclass` is resolved through `search_path`, exactly like the unqualified
-- names in the DROPs, so the guard and the DROPs can never disagree about which
-- table they mean.
BEGIN;

DO $$
DECLARE
  row_count bigint;
BEGIN
  IF to_regclass('"app_block_reviews"') IS NULL THEN
    RAISE NOTICE 'app_block_reviews already absent — nothing to drop.';
    RETURN;
  END IF;

  EXECUTE 'SELECT COUNT(*) FROM "app_block_reviews"' INTO row_count;

  IF row_count > 0 THEN
    RAISE EXCEPTION
      'REFUSING TO DROP "app_block_reviews": % row(s) present, expected 0.', row_count
      USING HINT =
        'This DROP is irreversible and there is no down migration. Migrate the '
        'rows into "app_listing_reviews" first, then re-run this file.';
  END IF;
END
$$;

-- The two indexes go with the table, but drop them explicitly so a partially
-- applied state (table already gone, indexes somehow left) still converges.
DROP INDEX IF EXISTS "app_block_reviews_app_agg_idx";
DROP INDEX IF EXISTS "app_block_reviews_app_user_uniq";

DROP TABLE IF EXISTS "app_block_reviews";

COMMIT;

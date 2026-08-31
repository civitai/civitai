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
--   operator: on a non-empty table the guard raises, which aborts the entire
--   `DO` block — the DROPs live inside it — so a mistaken apply cannot silently
--   destroy rows.
--
-- IF-EXISTS guards so a manual re-run is a no-op.

-- ENFORCED PRECONDITION. The "expect 0" check above is a comment, and a comment
-- cannot stop an irreversible DROP — so assert it in SQL instead.
--
-- 🔴 THE DROPs LIVE INSIDE THE `DO` BLOCK ON PURPOSE — DO NOT LIFT THEM BACK
-- OUT TO TOP LEVEL, and do not "helpfully" wrap this file in `BEGIN;`/`COMMIT;`.
-- Two separate hazards, and the fix for the first must not reintroduce the
-- second:
--
--   (1) A RAISE does not stop the rest of the FILE. A raised exception only
--       aborts the remaining statements when psql was invoked with
--       `-1`/`--single-transaction` or `-v ON_ERROR_STOP=1`. Under a plain
--       `psql -f migration.sql` — an entirely reasonable way for a human to
--       apply a hand-applied migration — psql runs each statement in its own
--       implicit transaction and CONTINUES PAST AN ERROR, so top-level DROPs
--       after the guard execute anyway. Measured against that shape: the table
--       and all 3 of its rows were destroyed and psql still exited 0, so the
--       failure was both total and silent.
--
--   (2) A file that COMMITs a transaction it did not open hijacks the caller's
--       transaction state, and that fails DESTRUCTIVELY in two shapes an
--       operator is likely to use — both measured:
--         * `BEGIN; \i this-file; \i next-file; COMMIT;` under
--           `ON_ERROR_STOP=1` (the batch shape a multi-file manual apply
--           naturally takes). This file's own COMMIT ends the operator's
--           transaction early, so when the SECOND file fails the DROP is
--           ALREADY COMMITTED: the batch aborts, the table is gone anyway, and
--           the rollback the operator thinks they got does not exist.
--         * `\set AUTOCOMMIT off` — the pgAdmin/DBeaver/Retool posture, and
--           Retool is a documented apply path for this database. No explicit
--           `BEGIN` is needed: psql opens the transaction implicitly, this
--           file's COMMIT closes it, and the operator's subsequent `ROLLBACK;`
--           prints only `WARNING: there is no transaction in progress`. The
--           DROP stands, and anything else pending in that session is committed
--           as a side effect of OUR commit. Two non-fatal warnings, exit 0.
--       It also silently defeated `psql -1`: the file's COMMIT closed psql's own
--       single transaction mid-file, and psql's closing COMMIT then warned
--       `there is no transaction in progress`, on all three fixtures.
--
-- A single `DO` block is ONE statement, so it is atomic on its own: the RAISE
-- aborts the whole block and the DROPs inside it never ran, under every psql
-- invocation rather than only the careful ones. That is hazard (1) closed
-- WITHOUT this file issuing any transaction-control statement at all, which is
-- what keeps hazard (2) closed too. Whatever transaction the caller is in stays
-- theirs to commit or roll back.
--
-- Verified on PostgreSQL 18.3 — the PRODUCTION server version, read off the
-- live primary (`server_version_num` 180003), NOT the 17.10 an earlier draft of
-- this header cited — across all 15 combinations of {plain `-f`, `-1`,
-- `-v ON_ERROR_STOP=1`, a `BEGIN; \i this; \i failing-file; COMMIT;` batch, and
-- `\set AUTOCOMMIT off` + `ROLLBACK;`} × {3 rows, empty, already dropped}: the
-- table and its rows survive every non-empty case, the empty/absent cases drop
-- and no-op as intended, and no case leaves the caller's transaction in a state
-- it did not choose. The matrix is observing the guard rather than running blind:
-- on the same server, a negative control with the guard stripped out destroys
-- all 3 rows under `-f`, `-1` and `ON_ERROR_STOP=1` (the two nested shapes are
-- saved by the OPERATOR's rollback there, not by the file), and the earlier
-- `BEGIN;`/`COMMIT;`-wrapped draft leaves the table dropped-and-committed with
-- the operator's own pending row committed alongside it in BOTH nested shapes.
-- PREFER `psql -v ON_ERROR_STOP=1 -f <this file>` — the data is safe either
-- way, but WITHOUT it psql exits 0 even when the guard refused, so the exit
-- code is not a usable success signal; read the output.
--
-- The existence check is REQUIRED, not belt-and-braces: PL/pgSQL prepares a
-- statement only when control actually reaches it, so the inner COUNT is never
-- planned when the table is already gone. Without the IF, a re-run against an
-- already-dropped table would raise `relation does not exist` and break the
-- no-op re-run property the IF EXISTS guards below are there to provide.
-- `to_regclass` is resolved through `search_path`, exactly like the unqualified
-- names in the DROPs, so the guard and the DROPs can never disagree about which
-- table they mean.
DO $$
DECLARE
  row_count bigint;
BEGIN
  IF to_regclass('"app_block_reviews"') IS NULL THEN
    RAISE NOTICE 'app_block_reviews already absent — nothing to drop.';
  ELSE
    EXECUTE 'SELECT COUNT(*) FROM "app_block_reviews"' INTO row_count;

    IF row_count > 0 THEN
      RAISE EXCEPTION
        'REFUSING TO DROP "app_block_reviews": % row(s) present, expected 0.', row_count
        USING HINT =
          'This DROP is irreversible and there is no down migration. Migrate the '
          'rows into "app_listing_reviews" first, then re-run this file.';
    END IF;
  END IF;

  -- The two indexes go with the table, but drop them explicitly so a partially
  -- applied state (table already gone, indexes somehow left) still converges.
  -- They are EXECUTEd (like the COUNT above) rather than written as plain
  -- PL/pgSQL statements for the same reason: nothing in this block should be
  -- planned against objects that may not exist on a re-run.
  EXECUTE 'DROP INDEX IF EXISTS "app_block_reviews_app_agg_idx"';
  EXECUTE 'DROP INDEX IF EXISTS "app_block_reviews_app_user_uniq"';

  EXECUTE 'DROP TABLE IF EXISTS "app_block_reviews"';
END
$$;

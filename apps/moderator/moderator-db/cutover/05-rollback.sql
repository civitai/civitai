-- Rollback for the Retool -> moderator-database cutover. RUN AGAINST THE MODERATOR DATABASE.
--
-- Plan and reasoning: docs/moderator-app/retool-db-cutover.md
--
--   psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 05-rollback.sql
--
-- Removes exactly what step 3 inserted, using the pre-merge id snapshot step 2 captured. Anything whose
-- id was already present before the merge is left alone, so this cannot touch a row the moderator app
-- wrote here.
--
-- 🔴 ONLY valid while the app is still pointed at RETOOL. Once the app writes to this database, its new
-- rows have ids that are also absent from `cutover.preexisting`, and this script would delete them.
-- The guard below refuses to run if it finds rows newer than the merge; clear that only if you are
-- certain no post-cutover write has landed.
--
-- Sequences are NOT rewound. A sequence that has issued ids cannot be safely lowered, and leaving it
-- high costs nothing but a gap.

\set ON_ERROR_STOP on
\timing on

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('cutover.preexisting') IS NULL THEN
    RAISE EXCEPTION 'cutover.preexisting is missing — cannot roll back precisely. Do not guess.';
  END IF;
  SELECT count(*) INTO n FROM cutover.preexisting;
  IF n = 0 THEN
    RAISE EXCEPTION 'cutover.preexisting is empty — step 2 did not capture the pre-merge state.';
  END IF;
  RAISE NOTICE 'pre-merge snapshot holds % ids', n;
END $$;

-- Refuse to run if anything looks like a post-cutover write: a row absent from both the snapshot and
-- the staged Retool data is something neither Retool nor the merge put there.
DO $$
DECLARE r record; n bigint; total bigint := 0;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'User','UserNotes','UserStrikes','ModelNotes','RatingChanges','ReToolActions',
      'Mods_TaskTimers','FrontPageTimers','FrontPageTimers_catchup','ModerationImageHelp',
      'ModerationSHA','TimedMutes'
    ]) AS tbl
  LOOP
    EXECUTE format($f$
      SELECT count(*) FROM public.%I t
      WHERE NOT EXISTS (SELECT 1 FROM cutover.preexisting p
                         WHERE p.table_name = %L AND p.id = t."id")
        AND NOT EXISTS (SELECT 1 FROM cutover.%I s WHERE s."id" = t."id")
        AND NOT EXISTS (SELECT 1 FROM cutover.id_remap m
                         WHERE m.table_name = %L AND m.new_id = t."id")
    $f$, r.tbl, r.tbl, r.tbl, r.tbl) INTO n;
    IF n > 0 THEN
      RAISE WARNING 'public.% holds % rows this rollback cannot account for', r.tbl, n;
      total := total + n;
    END IF;
  END LOOP;
  IF total > 0 THEN
    RAISE EXCEPTION
      'REFUSING: % rows were written after the merge. Rolling back would delete them.', total;
  END IF;
  RAISE NOTICE 'OK: nothing was written after the merge';
END $$;

DO $$
DECLARE r record; n bigint;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'User','UserNotes','UserStrikes','ModelNotes','RatingChanges','ReToolActions',
      'Mods_TaskTimers','FrontPageTimers','FrontPageTimers_catchup','ModerationImageHelp',
      'ModerationSHA','TimedMutes'
    ]) AS tbl
  LOOP
    EXECUTE format($f$
      DELETE FROM public.%I t
      WHERE NOT EXISTS (SELECT 1 FROM cutover.preexisting p
                         WHERE p.table_name = %L AND p.id = t."id")
    $f$, r.tbl, r.tbl);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE 'public.%: deleted % merged rows', r.tbl, n; END IF;
  END LOOP;
END $$;

DELETE FROM cutover.id_remap;
DELETE FROM cutover.conflict_review;

\echo ''
\echo '=== ROLLBACK COMPLETE — the moderator database is back to its pre-merge state. ==='
\echo '=== The staging schema is left in place. DROP SCHEMA cutover CASCADE; when finished. ==='

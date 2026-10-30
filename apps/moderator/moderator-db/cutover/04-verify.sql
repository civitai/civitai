-- Step 4 of the Retool -> moderator-database cutover. RUN AGAINST THE MODERATOR DATABASE. READ-ONLY.
--
-- Plan and reasoning: docs/moderator-app/retool-db-cutover.md
--
--   psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f 04-verify.sql
--
-- RAISEs on anything that would make the cutover unsafe to complete, so a non-zero exit is the gate --
-- do not repoint the app at this database until this file runs clean.
--
-- Checksums are deliberately NOT compared whole-table. The target legitimately holds rows Retool never
-- had (writes the moderator app already made here) and rows under different ids (the remap), so equal
-- checksums would be the wrong assertion. What is asserted instead is one-directional and is the thing
-- that actually matters: every Retool row is represented here.

\set ON_ERROR_STOP on
\timing on

SET default_transaction_read_only = on;

-- --- A. nothing left for a human to resolve ---------------------------------------------------------
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM cutover.conflict_review;
  IF n > 0 THEN
    RAISE EXCEPTION 'FAIL: % unresolved id conflicts. Inspect cutover.conflict_review.', n;
  END IF;
  RAISE NOTICE 'OK: no unresolved id conflicts';
END $$;

-- --- B. every staged row landed, by id or by remap --------------------------------------------------
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
      SELECT count(*) FROM cutover.%I s
      WHERE NOT EXISTS (SELECT 1 FROM public.%I t WHERE t."id" = s."id")
        AND NOT EXISTS (SELECT 1 FROM cutover.id_remap m
                         WHERE m.table_name = %L AND m.retool_id = s."id")
    $f$, r.tbl, r.tbl, r.tbl) INTO n;
    IF n > 0 THEN
      RAISE WARNING 'FAIL: % staged rows missing from public.%', n, r.tbl;
      total := total + n;
    END IF;
  END LOOP;
  IF total > 0 THEN
    RAISE EXCEPTION 'FAIL: % staged rows are neither present by id nor remapped', total;
  END IF;
  RAISE NOTICE 'OK: every staged row is present by id or accounted for by a remap';
END $$;

-- --- C. every remapped row is really there, with its content intact ---------------------------------
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM cutover.id_remap m
  JOIN cutover."UserNotes" s ON s."id" = m.retool_id
  WHERE m.table_name = 'UserNotes'
    AND NOT EXISTS (
      SELECT 1 FROM public."UserNotes" t
       WHERE t."id" = m.new_id
         AND t."userId"       IS NOT DISTINCT FROM s."userId"
         AND t."notes"        IS NOT DISTINCT FROM s."notes"
         AND t."lastUpdate"   IS NOT DISTINCT FROM s."lastUpdate"
         AND t."lastUpdateBy" IS NOT DISTINCT FROM s."lastUpdateBy"
    );
  IF n > 0 THEN
    RAISE EXCEPTION 'FAIL: % remapped UserNotes rows are missing or altered at their new id', n;
  END IF;
  RAISE NOTICE 'OK: every remapped row is present and unaltered at its new id';
END $$;

-- --- D. User rows skipped by the userId unique constraint -------------------------------------------
-- Step 3 refuses a staged User row whose `userId` is already held by a different local row, because the
-- UNIQUE constraint would reject it. That is a silent skip, so it is asserted here rather than trusted.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
  FROM cutover."User" s
  WHERE NOT EXISTS (SELECT 1 FROM public."User" t WHERE t."userId" = s."userId");
  IF n > 0 THEN
    RAISE EXCEPTION 'FAIL: % staged User rows have no local row for their userId', n;
  END IF;
  RAISE NOTICE 'OK: every staged User row has a local row for its userId';
END $$;

-- --- E. sequences cannot re-issue a live id ---------------------------------------------------------
DO $$
DECLARE r record; seq text; lv bigint; mx bigint; rv bigint; bad int := 0;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'User','UserNotes','UserStrikes','ModelNotes','RatingChanges','ReToolActions',
      'Mods_TaskTimers','FrontPageTimers','FrontPageTimers_catchup','ModerationImageHelp',
      'ModerationSHA','TimedMutes'
    ]) AS tbl
  LOOP
    seq := pg_get_serial_sequence('public.' || quote_ident(r.tbl), 'id');
    CONTINUE WHEN seq IS NULL;
    SELECT s.last_value INTO lv FROM pg_sequences s
      WHERE s.schemaname = 'public' AND s.sequencename = r.tbl || '_id_seq';
    EXECUTE format('SELECT coalesce(max("id"), 0) FROM public.%I', r.tbl) INTO mx;
    SELECT c.last_value INTO rv FROM cutover.sequences c WHERE c.sequencename = r.tbl || '_id_seq';

    IF lv IS NULL OR lv < mx OR lv < coalesce(rv, 0) THEN
      RAISE WARNING 'FAIL: %_id_seq at % but local max is % and retool was %', r.tbl, lv, mx, rv;
      bad := bad + 1;
    END IF;
  END LOOP;
  IF bad > 0 THEN
    RAISE EXCEPTION 'FAIL: % sequences are behind and would re-issue a live id', bad;
  END IF;
  RAISE NOTICE 'OK: every sequence is past both the local max and Retool''s position';
END $$;

-- --- F. reconciliation, for the record --------------------------------------------------------------
-- `local_excess` is rows this database holds that Retool never did: writes the moderator app already
-- made here. It should equal the number of such writes you expect, and never be negative.
WITH local_counts AS (
  SELECT 'User' AS t, count(*) AS local FROM public."User"
  UNION ALL SELECT 'UserNotes', count(*) FROM public."UserNotes"
  UNION ALL SELECT 'UserStrikes', count(*) FROM public."UserStrikes"
  UNION ALL SELECT 'ModelNotes', count(*) FROM public."ModelNotes"
  UNION ALL SELECT 'RatingChanges', count(*) FROM public."RatingChanges"
  UNION ALL SELECT 'ReToolActions', count(*) FROM public."ReToolActions"
  UNION ALL SELECT 'Mods_TaskTimers', count(*) FROM public."Mods_TaskTimers"
  UNION ALL SELECT 'FrontPageTimers', count(*) FROM public."FrontPageTimers"
),
staged_counts AS (
  SELECT 'User' AS t, count(*) AS staged FROM cutover."User"
  UNION ALL SELECT 'UserNotes', count(*) FROM cutover."UserNotes"
  UNION ALL SELECT 'UserStrikes', count(*) FROM cutover."UserStrikes"
  UNION ALL SELECT 'ModelNotes', count(*) FROM cutover."ModelNotes"
  UNION ALL SELECT 'RatingChanges', count(*) FROM cutover."RatingChanges"
  UNION ALL SELECT 'ReToolActions', count(*) FROM cutover."ReToolActions"
  UNION ALL SELECT 'Mods_TaskTimers', count(*) FROM cutover."Mods_TaskTimers"
  UNION ALL SELECT 'FrontPageTimers', count(*) FROM cutover."FrontPageTimers"
)
SELECT c.t                                   AS table_name,
       c.rows                                AS retool_rows,
       sc.staged                             AS staged_rows,
       lc.local                              AS local_rows_now,
       lc.local - c.rows                     AS local_excess,
       coalesce(rm.remapped, 0)              AS remapped,
       coalesce(pe.before, 0)                AS local_rows_before_merge
FROM cutover.retool_checksums c
JOIN staged_counts sc ON sc.t = c.t
JOIN local_counts  lc ON lc.t = c.t
LEFT JOIN LATERAL (SELECT count(*) AS remapped FROM cutover.id_remap  m WHERE m.table_name = c.t) rm ON true
LEFT JOIN LATERAL (SELECT count(*) AS before   FROM cutover.preexisting p WHERE p.table_name = c.t) pe ON true
ORDER BY 1;

SELECT table_name, retool_id, new_id, remapped_at FROM cutover.id_remap ORDER BY 1, 2;

\echo ''
\echo '=== VERIFY PASSED — every Retool row is represented in the moderator database. ==='
\echo '=== The app can now be repointed. See docs/moderator-app/retool-db-cutover.md step 5. ==='

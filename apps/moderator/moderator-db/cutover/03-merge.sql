-- Step 3 of the Retool -> moderator-database cutover. RUN AGAINST THE MODERATOR DATABASE.
--
-- Plan and reasoning: docs/moderator-app/retool-db-cutover.md
--
--   psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f 03-merge.sql
--
-- This is the only step that writes to `public`. Run it in one transaction so a failure leaves nothing
-- half-applied. Sequences are the exception -- nextval does not roll back -- but a rolled-back run only
-- burns ids, it does not corrupt anything.
--
-- Idempotent: every insert is an anti-join on the primary key, and the remap skips anything already in
-- cutover.id_remap. Re-running after a partial failure is safe and is the intended recovery.
--
-- Order per table:
--   1. insert rows whose id is free, keeping Retool's id
--   2. advance the sequence past both sides
--   3. re-id anything that could not keep its id, recording the remap
--   4. record whatever the merge would not decide on its own, for a human
--
-- Step 2 must precede step 3: the remap draws fresh ids from the sequence, so the sequence has to be
-- past the ids just inserted or it hands out one of them.

\set ON_ERROR_STOP on
\timing on

-- ---------------------------------------------------------------------------------------------------
-- 1. Insert rows whose id is free
-- ---------------------------------------------------------------------------------------------------

INSERT INTO public."User" ("id","deservedMute","spamWhitelist","userId")
SELECT s."id", s."deservedMute", s."spamWhitelist", s."userId"
FROM cutover."User" s
WHERE NOT EXISTS (SELECT 1 FROM public."User" t WHERE t."id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM public."User" t WHERE t."userId" = s."userId");

INSERT INTO public."UserNotes" ("id","userId","notes","lastUpdate","lastUpdateBy","spamWhitelist","deservedMute")
SELECT s."id", s."userId", s."notes", s."lastUpdate", s."lastUpdateBy", s."spamWhitelist", s."deservedMute"
FROM cutover."UserNotes" s
WHERE NOT EXISTS (SELECT 1 FROM public."UserNotes" t WHERE t."id" = s."id");

INSERT INTO public."UserStrikes" ("id","userId","createdAt","createdBy","reason")
SELECT s."id", s."userId", s."createdAt", s."createdBy", s."reason"
FROM cutover."UserStrikes" s
WHERE NOT EXISTS (SELECT 1 FROM public."UserStrikes" t WHERE t."id" = s."id");

INSERT INTO public."ModelNotes" ("id","modelId","createdBy","createdAt","content")
SELECT s."id", s."modelId", s."createdBy", s."createdAt", s."content"
FROM cutover."ModelNotes" s
WHERE NOT EXISTS (SELECT 1 FROM public."ModelNotes" t WHERE t."id" = s."id");

INSERT INTO public."RatingChanges" ("id","imageId","createdAt","updatedBy","rating","originalRating")
SELECT s."id", s."imageId", s."createdAt", s."updatedBy", s."rating", s."originalRating"
FROM cutover."RatingChanges" s
WHERE NOT EXISTS (SELECT 1 FROM public."RatingChanges" t WHERE t."id" = s."id");

INSERT INTO public."ReToolActions" ("id","Event","User","App","ActionType")
SELECT s."id", s."Event", s."User", s."App", s."ActionType"
FROM cutover."ReToolActions" s
WHERE NOT EXISTS (SELECT 1 FROM public."ReToolActions" t WHERE t."id" = s."id");

INSERT INTO public."Mods_TaskTimers" ("id","lastUpdateBy","lastUpdate","task")
SELECT s."id", s."lastUpdateBy", s."lastUpdate", s."task"
FROM cutover."Mods_TaskTimers" s
WHERE NOT EXISTS (SELECT 1 FROM public."Mods_TaskTimers" t WHERE t."id" = s."id");

INSERT INTO public."FrontPageTimers" ("id","nsfw","lastCheckedAt","username","buttonPressedTime","numberOfImages")
SELECT s."id", s."nsfw", s."lastCheckedAt", s."username", s."buttonPressedTime", s."numberOfImages"
FROM cutover."FrontPageTimers" s
WHERE NOT EXISTS (SELECT 1 FROM public."FrontPageTimers" t WHERE t."id" = s."id");

INSERT INTO public."FrontPageTimers_catchup" ("id","nsfw","lastCheckedAt","buttonPressedTime","username","numberOfImages")
SELECT s."id", s."nsfw", s."lastCheckedAt", s."buttonPressedTime", s."username", s."numberOfImages"
FROM cutover."FrontPageTimers_catchup" s
WHERE NOT EXISTS (SELECT 1 FROM public."FrontPageTimers_catchup" t WHERE t."id" = s."id");

INSERT INTO public."ModerationImageHelp" ("id","createdBy","imageIds","type","createdAt","isHandled","handledBy","handledAt")
SELECT s."id", s."createdBy", s."imageIds", s."type", s."createdAt", s."isHandled", s."handledBy", s."handledAt"
FROM cutover."ModerationImageHelp" s
WHERE NOT EXISTS (SELECT 1 FROM public."ModerationImageHelp" t WHERE t."id" = s."id");

INSERT INTO public."ModerationSHA" ("id","SHA256","ModelVersionId")
SELECT s."id", s."SHA256", s."ModelVersionId"
FROM cutover."ModerationSHA" s
WHERE NOT EXISTS (SELECT 1 FROM public."ModerationSHA" t WHERE t."id" = s."id");

INSERT INTO public."TimedMutes" ("id","userId","muteStart","muteEnd","createdBy","createdAt","muteReason","isMuted")
SELECT s."id", s."userId", s."muteStart", s."muteEnd", s."createdBy", s."createdAt", s."muteReason", s."isMuted"
FROM cutover."TimedMutes" s
WHERE NOT EXISTS (SELECT 1 FROM public."TimedMutes" t WHERE t."id" = s."id");

-- ---------------------------------------------------------------------------------------------------
-- 2. Advance every sequence past both sides
--
-- GREATEST of the local max and Retool's own position. Retool's position can exceed the local max (it
-- has spent ids on rows it later deleted) and the local max can exceed Retool's (a remap, below, or a
-- write the moderator app already made here). Taking the larger is the only value that cannot re-issue
-- a live id.
-- ---------------------------------------------------------------------------------------------------

DO $$
DECLARE
  r        record;
  seq_name text;
  local_mx bigint;
  retool_v bigint;
  target   bigint;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'User','UserNotes','UserStrikes','ModelNotes','RatingChanges','ReToolActions',
      'Mods_TaskTimers','FrontPageTimers','FrontPageTimers_catchup','ModerationImageHelp',
      'ModerationSHA','TimedMutes'
    ]) AS tbl
  LOOP
    seq_name := pg_get_serial_sequence('public.' || quote_ident(r.tbl), 'id');
    CONTINUE WHEN seq_name IS NULL;

    EXECUTE format('SELECT coalesce(max("id"), 0) FROM public.%I', r.tbl) INTO local_mx;
    SELECT s.last_value INTO retool_v
      FROM cutover.sequences s
     WHERE s.sequencename = r.tbl || '_id_seq';

    target := GREATEST(local_mx, coalesce(retool_v, 0), 1);
    PERFORM setval(seq_name, target, true);
    RAISE NOTICE 'sequence % -> % (local max %, retool %)', seq_name, target, local_mx, retool_v;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- 3. Re-id the Retool rows that could not keep their id
--
-- Only UserNotes has a known case: two ids were spent locally on notes about DIFFERENT users while
-- Retool independently spent the same two ids. A differing `userId` is what makes these two distinct
-- records rather than two versions of one, so the Retool row is kept as a NEW note and the local row is
-- left alone. Anything that does NOT differ by userId is a same-record disagreement -- the merge will
-- not guess at those, and step 4 routes them to a human.
-- ---------------------------------------------------------------------------------------------------

WITH conflict AS MATERIALIZED (
  SELECT s."id" AS retool_id, s."userId", s."notes", s."lastUpdate", s."lastUpdateBy",
         s."spamWhitelist", s."deservedMute",
         nextval(pg_get_serial_sequence('public."UserNotes"', 'id'))::int AS new_id
  FROM cutover."UserNotes" s
  JOIN public."UserNotes" t ON t."id" = s."id"
  WHERE t."userId" IS DISTINCT FROM s."userId"
    AND NOT EXISTS (
      SELECT 1 FROM cutover.id_remap m
       WHERE m.table_name = 'UserNotes' AND m.retool_id = s."id"
    )
),
inserted AS (
  INSERT INTO public."UserNotes" ("id","userId","notes","lastUpdate","lastUpdateBy","spamWhitelist","deservedMute")
  SELECT new_id, "userId", "notes", "lastUpdate", "lastUpdateBy", "spamWhitelist", "deservedMute"
  FROM conflict
  RETURNING "id"
)
INSERT INTO cutover.id_remap (table_name, retool_id, new_id)
SELECT 'UserNotes', retool_id, new_id FROM conflict;

-- ---------------------------------------------------------------------------------------------------
-- 4. Record what the merge would not decide
--
-- Any staged row whose id is present locally but whose content differs, and which was not remapped
-- above. Step 4 fails while this table has rows: an unreviewed entry means the two databases disagree
-- about a record neither side can be assumed to own.
-- ---------------------------------------------------------------------------------------------------

DO $$
DECLARE
  r   record;
  sql text;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'User','UserNotes','UserStrikes','ModelNotes','RatingChanges','ReToolActions',
      'Mods_TaskTimers','FrontPageTimers','FrontPageTimers_catchup','ModerationImageHelp',
      'ModerationSHA','TimedMutes'
    ]) AS tbl
  LOOP
    sql := format($f$
      INSERT INTO cutover.conflict_review (table_name, id, local_row, retool_row)
      SELECT %L, s."id", t.*::text, s.*::text
      FROM cutover.%I s
      JOIN public.%I t ON t."id" = s."id"
      WHERE t.*::text IS DISTINCT FROM s.*::text
        AND NOT EXISTS (
          SELECT 1 FROM cutover.id_remap m WHERE m.table_name = %L AND m.retool_id = s."id"
        )
      ON CONFLICT (table_name, id) DO NOTHING
    $f$, r.tbl, r.tbl, r.tbl, r.tbl);
    EXECUTE sql;
  END LOOP;
END $$;

SELECT table_name, count(*) AS unresolved
FROM cutover.conflict_review GROUP BY 1 ORDER BY 1;

SELECT table_name, retool_id, new_id FROM cutover.id_remap ORDER BY 1, 2;

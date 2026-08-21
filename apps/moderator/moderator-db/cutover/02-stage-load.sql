-- Step 2 of the Retool -> moderator-database cutover. RUN AGAINST THE MODERATOR DATABASE.
--
-- Plan and reasoning: docs/moderator-app/retool-db-cutover.md
--
--   psql "$MODERATOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f 02-stage-load.sql
--
-- Creates a `cutover` schema holding an unconstrained copy of what Retool currently has, plus the
-- bookkeeping tables the merge needs. Nothing in `public` is touched here -- this step is safe to run,
-- inspect, and re-run before committing to step 3.
--
-- Staging tables carry no primary key and no defaults on purpose: they must accept Retool's rows
-- verbatim, including ids that already exist in `public`. Detecting those is the merge's job.

\set ON_ERROR_STOP on
\timing on

BEGIN;

DROP SCHEMA IF EXISTS cutover CASCADE;
CREATE SCHEMA cutover;

CREATE TABLE cutover."User" (
  "id" integer, "deservedMute" boolean, "spamWhitelist" boolean, "userId" integer
);
CREATE TABLE cutover."UserNotes" (
  "id" integer, "userId" integer, "notes" text, "lastUpdate" timestamptz,
  "lastUpdateBy" text, "spamWhitelist" boolean, "deservedMute" boolean
);
CREATE TABLE cutover."UserStrikes" (
  "id" integer, "userId" integer, "createdAt" timestamptz, "createdBy" text, "reason" text
);
CREATE TABLE cutover."ModelNotes" (
  "id" integer, "modelId" integer, "createdBy" text, "createdAt" timestamptz, "content" text
);
CREATE TABLE cutover."RatingChanges" (
  "id" integer, "imageId" integer, "createdAt" timestamptz, "updatedBy" text,
  "rating" integer, "originalRating" integer
);
CREATE TABLE cutover."ReToolActions" (
  "id" integer, "Event" timestamptz, "User" text, "App" text, "ActionType" text
);
CREATE TABLE cutover."Mods_TaskTimers" (
  "id" integer, "lastUpdateBy" text, "lastUpdate" timestamptz, "task" task_enum_0648e184
);
CREATE TABLE cutover."FrontPageTimers" (
  "id" integer, "nsfw" text, "lastCheckedAt" timestamptz, "username" text,
  "buttonPressedTime" timestamptz, "numberOfImages" integer
);
CREATE TABLE cutover."FrontPageTimers_catchup" (
  "id" integer, "nsfw" text, "lastCheckedAt" timestamptz, "buttonPressedTime" timestamptz,
  "username" text, "numberOfImages" integer
);
CREATE TABLE cutover."ModerationImageHelp" (
  "id" integer, "createdBy" text, "imageIds" jsonb, "type" type_enum_cf5f15bb,
  "createdAt" timestamptz, "isHandled" boolean, "handledBy" text, "handledAt" timestamptz
);
CREATE TABLE cutover."ModerationSHA" (
  "id" integer, "SHA256" text, "ModelVersionId" integer
);
CREATE TABLE cutover."TimedMutes" (
  "id" integer, "userId" text, "muteStart" timestamptz, "muteEnd" timestamptz,
  "createdBy" text, "createdAt" timestamptz, "muteReason" text, "isMuted" boolean
);

CREATE TABLE cutover.sequences (
  sequencename text PRIMARY KEY,
  last_value   bigint NOT NULL
);

CREATE TABLE cutover.retool_checksums (
  t     text PRIMARY KEY,
  rows  bigint NOT NULL,
  ck    text
);

-- Where a Retool row could not keep its own id because that id was already spent locally. This is the
-- audit trail for the remap: without it, "which Retool note is this" is unanswerable afterwards.
CREATE TABLE cutover.id_remap (
  table_name  text NOT NULL,
  retool_id   integer NOT NULL,
  new_id      integer NOT NULL,
  remapped_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, retool_id)
);

-- Collisions the merge refuses to resolve on its own. Step 4 fails while this has rows.
CREATE TABLE cutover.conflict_review (
  table_name text NOT NULL,
  id         integer NOT NULL,
  local_row  text,
  retool_row text,
  PRIMARY KEY (table_name, id)
);

-- Every id that exists in `public` BEFORE the merge. This is what makes the rollback exact rather than
-- approximate: anything not in here was put there by the merge, and only that is safe to remove.
CREATE TABLE cutover.preexisting (
  table_name text NOT NULL,
  id         integer NOT NULL,
  PRIMARY KEY (table_name, id)
);

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'User','UserNotes','UserStrikes','ModelNotes','RatingChanges','ReToolActions',
      'Mods_TaskTimers','FrontPageTimers','FrontPageTimers_catchup','ModerationImageHelp',
      'ModerationSHA','TimedMutes'
    ]) AS tbl
  LOOP
    EXECUTE format(
      'INSERT INTO cutover.preexisting (table_name, id) SELECT %L, "id" FROM public.%I',
      r.tbl, r.tbl
    );
  END LOOP;
END $$;

COMMIT;

\copy cutover."User" FROM 'User.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."UserNotes" FROM 'UserNotes.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."UserStrikes" FROM 'UserStrikes.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."ModelNotes" FROM 'ModelNotes.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."RatingChanges" FROM 'RatingChanges.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."ReToolActions" FROM 'ReToolActions.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."Mods_TaskTimers" FROM 'Mods_TaskTimers.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."FrontPageTimers" FROM 'FrontPageTimers.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."FrontPageTimers_catchup" FROM 'FrontPageTimers_catchup.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."ModerationImageHelp" FROM 'ModerationImageHelp.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."ModerationSHA" FROM 'ModerationSHA.csv' WITH (FORMAT csv, HEADER true)
\copy cutover."TimedMutes" FROM 'TimedMutes.csv' WITH (FORMAT csv, HEADER true)
\copy cutover.sequences FROM 'sequences.csv' WITH (FORMAT csv, HEADER true)
\copy cutover.retool_checksums FROM 'retool-checksums.csv' WITH (FORMAT csv, HEADER true)

-- What the merge is about to do, before it does it.
SELECT 'User' AS t, count(*) AS staged,
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."User" p WHERE p."id" = s."id")) AS to_insert
FROM cutover."User" s
UNION ALL SELECT 'UserNotes', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."UserNotes" p WHERE p."id" = s."id")) FROM cutover."UserNotes" s
UNION ALL SELECT 'UserStrikes', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."UserStrikes" p WHERE p."id" = s."id")) FROM cutover."UserStrikes" s
UNION ALL SELECT 'ModelNotes', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."ModelNotes" p WHERE p."id" = s."id")) FROM cutover."ModelNotes" s
UNION ALL SELECT 'RatingChanges', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."RatingChanges" p WHERE p."id" = s."id")) FROM cutover."RatingChanges" s
UNION ALL SELECT 'ReToolActions', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."ReToolActions" p WHERE p."id" = s."id")) FROM cutover."ReToolActions" s
UNION ALL SELECT 'Mods_TaskTimers', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."Mods_TaskTimers" p WHERE p."id" = s."id")) FROM cutover."Mods_TaskTimers" s
UNION ALL SELECT 'FrontPageTimers', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."FrontPageTimers" p WHERE p."id" = s."id")) FROM cutover."FrontPageTimers" s
UNION ALL SELECT 'FrontPageTimers_catchup', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."FrontPageTimers_catchup" p WHERE p."id" = s."id")) FROM cutover."FrontPageTimers_catchup" s
UNION ALL SELECT 'ModerationImageHelp', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."ModerationImageHelp" p WHERE p."id" = s."id")) FROM cutover."ModerationImageHelp" s
UNION ALL SELECT 'ModerationSHA', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."ModerationSHA" p WHERE p."id" = s."id")) FROM cutover."ModerationSHA" s
UNION ALL SELECT 'TimedMutes', count(*), count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public."TimedMutes" p WHERE p."id" = s."id")) FROM cutover."TimedMutes" s
ORDER BY 1;

-- Step 1 of the Retool -> moderator-database cutover. RUN AGAINST RETOOL. READ-ONLY.
--
-- Plan and reasoning: docs/moderator-app/retool-db-cutover.md
--
--   psql "$RETOOL_DATABASE_URL" -v ON_ERROR_STOP=1 -f 01-export-from-retool.sql
--
-- Writes one CSV per table into the current directory. Whole tables, not deltas: the delta is computed
-- inside the moderator database in step 3, by anti-joining on the primary key. That is what makes this
-- pipeline idempotent and what lets it survive Retool taking more writes between now and the merge.
-- Every table here is small; the largest is a few hundred thousand narrow rows.
--
-- Column lists are explicit so CSV field order cannot drift. FrontPageTimers and
-- FrontPageTimers_catchup have the same columns in a DIFFERENT physical order -- do not merge these
-- two statements.

\set ON_ERROR_STOP on
\timing on

SET default_transaction_read_only = on;

\copy (SELECT "id","deservedMute","spamWhitelist","userId" FROM "User" ORDER BY "id") TO 'User.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","userId","notes","lastUpdate","lastUpdateBy","spamWhitelist","deservedMute" FROM "UserNotes" ORDER BY "id") TO 'UserNotes.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","userId","createdAt","createdBy","reason" FROM "UserStrikes" ORDER BY "id") TO 'UserStrikes.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","modelId","createdBy","createdAt","content" FROM "ModelNotes" ORDER BY "id") TO 'ModelNotes.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","imageId","createdAt","updatedBy","rating","originalRating" FROM "RatingChanges" ORDER BY "id") TO 'RatingChanges.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","Event","User","App","ActionType" FROM "ReToolActions" ORDER BY "id") TO 'ReToolActions.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","lastUpdateBy","lastUpdate","task" FROM "Mods_TaskTimers" ORDER BY "id") TO 'Mods_TaskTimers.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","nsfw","lastCheckedAt","username","buttonPressedTime","numberOfImages" FROM "FrontPageTimers" ORDER BY "id") TO 'FrontPageTimers.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","nsfw","lastCheckedAt","buttonPressedTime","username","numberOfImages" FROM "FrontPageTimers_catchup" ORDER BY "id") TO 'FrontPageTimers_catchup.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","createdBy","imageIds","type","createdAt","isHandled","handledBy","handledAt" FROM "ModerationImageHelp" ORDER BY "id") TO 'ModerationImageHelp.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","SHA256","ModelVersionId" FROM "ModerationSHA" ORDER BY "id") TO 'ModerationSHA.csv' WITH (FORMAT csv, HEADER true)

\copy (SELECT "id","userId","muteStart","muteEnd","createdBy","createdAt","muteReason","isMuted" FROM "TimedMutes" ORDER BY "id") TO 'TimedMutes.csv' WITH (FORMAT csv, HEADER true)

-- Sequence positions travel with the data. The target sequence must end up at least here, or the first
-- write after cutover re-issues an id Retool already spent -- which is the failure this whole pipeline
-- exists to avoid.
\copy (SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' AND last_value IS NOT NULL ORDER BY sequencename) TO 'sequences.csv' WITH (FORMAT csv, HEADER true)

-- Parity evidence, compared against the same query on the target in step 4.
\copy (SELECT 'User' AS t, count(*) AS rows, md5(string_agg(x.r, '|' ORDER BY x.id)) AS ck FROM (SELECT "id" AS id, "User".*::text AS r FROM "User") x UNION ALL SELECT 'UserNotes', count(*), md5(string_agg(x.r,'|' ORDER BY x.id)) FROM (SELECT "id" AS id, "UserNotes".*::text AS r FROM "UserNotes") x UNION ALL SELECT 'UserStrikes', count(*), md5(string_agg(x.r,'|' ORDER BY x.id)) FROM (SELECT "id" AS id, "UserStrikes".*::text AS r FROM "UserStrikes") x UNION ALL SELECT 'ModelNotes', count(*), md5(string_agg(x.r,'|' ORDER BY x.id)) FROM (SELECT "id" AS id, "ModelNotes".*::text AS r FROM "ModelNotes") x UNION ALL SELECT 'RatingChanges', count(*), md5(string_agg(x.r,'|' ORDER BY x.id)) FROM (SELECT "id" AS id, "RatingChanges".*::text AS r FROM "RatingChanges") x UNION ALL SELECT 'ReToolActions', count(*), md5(string_agg(x.r,'|' ORDER BY x.id)) FROM (SELECT "id" AS id, "ReToolActions".*::text AS r FROM "ReToolActions") x UNION ALL SELECT 'Mods_TaskTimers', count(*), md5(string_agg(x.r,'|' ORDER BY x.id)) FROM (SELECT "id" AS id, "Mods_TaskTimers".*::text AS r FROM "Mods_TaskTimers") x UNION ALL SELECT 'FrontPageTimers', count(*), md5(string_agg(x.r,'|' ORDER BY x.id)) FROM (SELECT "id" AS id, "FrontPageTimers".*::text AS r FROM "FrontPageTimers") x ORDER BY 1) TO 'retool-checksums.csv' WITH (FORMAT csv, HEADER true)

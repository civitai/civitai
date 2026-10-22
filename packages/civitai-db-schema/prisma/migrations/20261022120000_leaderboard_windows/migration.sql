-- Leaderboard windows: the writer board scores the last 30 days, and every public board states its
-- own window in scoringDescription. Data rows, not schema. Apply by hand; this repo does not run
-- prisma migrate deploy.
--
-- APPLY BEFORE the deploy that removes the hard-coded "Only the last 30 days are considered" line
-- from the leaderboard page. Until then a board shows both lines, which is redundant on the 30-day
-- boards and briefly contradictory on the 90-day, 7-day and all-time ones.
--
-- Block 1 (writer query). The writer board summed ArticleMetric 'AllTime' over every article ever
-- written, while the page told readers only the last 30 days count. It now mirrors the model creator
-- boards: all-time metrics on articles PUBLISHED in the last 30 days. ArticleMetric's 'Month' rows are
-- not an option: only 'AllTime' is still written, the other timeframes stopped updating in January.
-- The upper bound (AND now()) keeps a future-dated publishedAt from scoring, as overall_90 does.
-- It also gains a.status = 'Published', which the creator boards already filter on: unpublished
-- articles stop scoring.
--
-- Block 2 (notes). Appends each board's window line to its scoringDescription, which the page shows
-- in the info popover. Boards that already state their window (crucible-*, stickers-*) are left alone.
--
-- Both blocks are idempotent: a re-run finds its text already present, changes nothing and passes
-- its post-checks. Each RAISEs instead of reporting a silent success when its anchor is missing.
-- Tallies change on the next prepare-leaderboard run.
--
-- Do not apply between 23:00 and 00:01 UTC (see prepare-leaderboard / isLeaderboardPopulated timing).
--
-- One transaction: if block 2 RAISEs, block 1's writer change rolls back with it.

BEGIN;

DO $$
DECLARE
  anchor constant text := 'am.timeframe = ''AllTime''';
  status_filter constant text := 'AND a.status = ''Published''';
  window_filter constant text := 'AND a."publishedAt" BETWEEN current_date - INTERVAL ''30 days'' AND now()';
  indent constant text := chr(13) || chr(10) || chr(9) || '  ';
  q text;
  has_status boolean;
  has_window boolean;
BEGIN
  SELECT query INTO q FROM "Leaderboard" WHERE id = 'writer';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'writer leaderboard row not found - nothing to update';
  END IF;

  has_status := position(status_filter IN q) > 0;
  has_window := position(window_filter IN q) > 0;

  IF has_status AND has_window THEN
    RAISE NOTICE 'writer query already has both filters - no change';
  ELSIF has_status OR has_window THEN
    RAISE EXCEPTION 'writer query has only one of the two filters (status: %, window: %) - an earlier partial edit; inspect SELECT query FROM "Leaderboard" WHERE id=''writer'' and apply by hand', has_status, has_window;
  ELSE
    IF (length(q) - length(replace(q, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION 'writer query must contain % exactly once, found % - the live query was edited; apply by hand', anchor, (length(q) - length(replace(q, anchor, ''))) / length(anchor);
    END IF;

    UPDATE "Leaderboard"
    SET query = replace(query, anchor, anchor || indent || status_filter || indent || window_filter)
    WHERE id = 'writer';
  END IF;

  SELECT query INTO q FROM "Leaderboard" WHERE id = 'writer';
  IF (length(q) - length(replace(q, status_filter, ''))) / length(status_filter) <> 1 THEN
    RAISE EXCEPTION 'writer query must contain the status filter exactly once after the update';
  END IF;
  IF (length(q) - length(replace(q, window_filter, ''))) / length(window_filter) <> 1 THEN
    RAISE EXCEPTION 'writer query must contain the 30-day window filter exactly once after the update';
  END IF;
END $$;

DO $$
DECLARE
  r record;
  d text;
  missing text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('anima', 'Models published in the last 30 days'),
      ('assets', 'Models published in the last 30 days'),
      ('backgrounds', 'Models published in the last 30 days'),
      ('base model', 'Models published in the last 30 days'),
      ('buildings', 'Models published in the last 30 days'),
      ('car', 'Models published in the last 30 days'),
      ('character', 'Models published in the last 30 days'),
      ('clothing', 'Models published in the last 30 days'),
      ('concept', 'Models published in the last 30 days'),
      ('flux', 'Models published in the last 30 days'),
      ('h3', 'Models published in the last 30 days'),
      ('krea2', 'Models published in the last 30 days'),
      ('overall', 'Models published in the last 30 days'),
      ('overall_nsfw', 'Models published in the last 30 days'),
      ('pony', 'Models published in the last 30 days'),
      ('poses', 'Models published in the last 30 days'),
      ('sdxl', 'Models published in the last 30 days'),
      ('style', 'Models published in the last 30 days'),
      ('tools', 'Models published in the last 30 days'),
      ('zimage', 'Models published in the last 30 days'),
      ('new_creators', 'Models published in the last 30 days'),
      ('new_creators-red', 'Models published in the last 30 days'),
      ('overall_90', 'Models published in the last 90 days'),
      ('writer', 'Articles published in the last 30 days'),
      ('images-new', 'Images posted in the last 30 days'),
      ('images-new-red', 'Images posted in the last 30 days'),
      ('images-overall', 'Last 30 days'),
      ('images-nsfw', 'Last 30 days'),
      ('images-funny', 'Last 30 days'),
      ('videos-overall', 'Last 30 days'),
      ('challenge', 'Last 30 days'),
      ('guardian', 'Last 30 days'),
      ('generators', 'Last 30 days'),
      ('trainers', 'Last 30 days'),
      ('generationTippers', 'Last 30 days'),
      ('knights-new-order', 'Last 7 days'),
      ('cosmeticCollectors', 'All time')
    ) AS v(id, line)
  LOOP
    SELECT "scoringDescription" INTO d FROM "Leaderboard" WHERE id = r.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'leaderboard % not found', r.id;
    END IF;
    IF d IS NULL THEN
      RAISE EXCEPTION 'leaderboard % has a NULL scoringDescription - set it by hand first', r.id;
    END IF;

    IF position(r.line IN d) = 0 THEN
      UPDATE "Leaderboard"
      SET "scoringDescription" = d
        || CASE WHEN position('---' IN d) > 0 THEN chr(10) ELSE chr(10) || '---' || chr(10) END
        || r.line
      WHERE id = r.id;
    END IF;

    SELECT "scoringDescription" INTO d FROM "Leaderboard" WHERE id = r.id;
    IF (length(d) - length(replace(d, r.line, ''))) / length(r.line) <> 1 THEN
      RAISE EXCEPTION 'leaderboard % must state "%" exactly once after the update', r.id, r.line;
    END IF;
  END LOOP;

  SELECT string_agg(id, ', ' ORDER BY id) INTO missing
  FROM "Leaderboard"
  WHERE public AND active
    AND coalesce("scoringDescription", '') !~* '(last [0-9]+ days|rolling [0-9]+ days|all time)';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'public active leaderboards with no window in scoringDescription: % - add them to this list', missing;
  END IF;
END $$;

COMMIT;

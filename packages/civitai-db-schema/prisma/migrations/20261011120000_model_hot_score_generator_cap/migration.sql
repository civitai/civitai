-- Cap the hot score's generation term by how many DISTINCT people generated.
--
-- A count of generations is a count of effort, and one person can supply all of it —
-- including the model's own owner. Without a divisor for that, a model with no likes
-- and no downloads can reach the top of the Hot feed on generations nobody else ran.
--
-- This surfaced because 20261010120000 moved the generation divisor from /114 to
-- /4.1. That correction was right, but weighting the signal higher also raised what
-- self-generating is worth by the same factor. The missing piece is division among
-- people, not a smaller weight.
--
--   generation term = least(generationCount / 4.1, uniqueGeneratorCount * 100)
--
-- 100 like-equivalents per generator is 410 generations each, chosen to sit above
-- the legitimate per-generator rate and well below the inflated one. Measurements
-- behind the constant, and what tighter caps cost:
-- docs/model-feed-hot-ranking.md.
--
-- 🔴 APPLY THIS FILE, THEN RUN THE BACKFILL. It cannot change a score on its own:
-- "uniqueGeneratorCount" starts at 0 and the cap is deliberately inert at 0, because
-- 0 means "not computed yet", not "nobody generated". The source is a ClickHouse
-- materialized view that Postgres cannot read, so the column is populated by
-- /api/admin/temp/backfill-unique-generators, and every row that writes recomputes
-- its own score through the trigger below.
--
-- 🔴 AND IT MUST GO FIRST. Not merely safe before the code — required before it.
-- The deploy adds "uniqueGeneratorCount" to modelMetricKeys, and bulkInsertMetrics
-- builds its INSERT column list from every key in that array unconditionally. Deploy
-- the code against a database without this column and every model-metrics batch
-- throws, taking down the whole job rather than just the new signal.
--
-- Unlike 20261010120000, this file is ordinary DDL: three statements, no CALL and no
-- CREATE INDEX CONCURRENTLY, so it is transaction-safe and wants the OPPOSITE lock
-- handling. ADD COLUMN with a non-volatile DEFAULT is metadata-only on PG 11+ (no
-- rewrite of a 3.6 GB table), but it still takes a brief ACCESS EXCLUSIVE lock on a
-- table the metrics job writes every minute. Run it behind a SHORT lock_timeout so it
-- fails fast instead of queueing behind a long read and blocking every writer behind
-- it in turn:
--
--   SET lock_timeout = '5s';
--
-- If it times out, retry — do not clear the timeout.

-- 1. The column ---------------------------------------------------------------

ALTER TABLE "ModelMetric"
    ADD COLUMN IF NOT EXISTS "uniqueGeneratorCount" INT NOT NULL DEFAULT 0;

-- 2. The score ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW."hotScore" := round(
        (
            log(
                1
                + NEW."thumbsUpCount"
                -- 6.4 and 4.1 are the MEDIAN per-model ratios of each signal to likes,
                -- not the site-wide SUM ratios. 20261010120000 has the reasoning.
                + NEW."downloadCount" / 6.4
                -- 0 is "not computed yet", so the cap stays inert rather than zeroing
                -- the generation term for every model between this file and the
                -- backfill. The footer's verification query is what closes that gap:
                -- afterwards no model has generations without a generator count.
                + CASE
                      WHEN NEW."uniqueGeneratorCount" > 0
                          THEN least(
                                   NEW."generationCount" / 4.1,
                                   NEW."uniqueGeneratorCount" * 100.0
                               )
                      ELSE NEW."generationCount" / 4.1
                  END
            )
            -- least(..., NOW()) clamps a future publish date. The coalesce falls back
            -- to the epoch, not NOW(): a row with no publish date is unpublished or
            -- orphaned, and "unknown" must sort LAST.
            + extract(epoch FROM least(coalesce(NEW."publishedAt", TIMESTAMP 'epoch'), NOW())) / 2592000
        ) * 10000
    )::int;

    RETURN NEW;
END
$function$;

-- 3. The trigger has to fire on the new column too -----------------------------
--
-- Without "uniqueGeneratorCount" in the UPDATE OF list the backfill would write the
-- count and never recompute the score, which is the whole point of the backfill.

CREATE OR REPLACE TRIGGER trg_model_metric_hot_score
    BEFORE INSERT OR UPDATE OF "thumbsUpCount", "downloadCount", "generationCount",
                               "uniqueGeneratorCount", "publishedAt"
    ON "ModelMetric"
    FOR EACH ROW
    EXECUTE FUNCTION public.model_metric_hot_score();

-- Verification -----------------------------------------------------------------
--
-- Straight after this file: not_computed should equal with_generations and capped
-- should be 0 — nothing has changed yet. After the backfill: not_computed must be 0,
-- or the models it counts still carry an uncapped score.
--
--   SELECT count(*) FILTER (WHERE "generationCount" > 0) AS with_generations,
--          count(*) FILTER (WHERE "generationCount" > 0
--                             AND "uniqueGeneratorCount" = 0) AS not_computed,
--          count(*) FILTER (WHERE "uniqueGeneratorCount" > 0
--                             AND "generationCount" / 4.1
--                                 > "uniqueGeneratorCount" * 100.0) AS capped
--     FROM "ModelMetric"
--    WHERE status = 'Published';
--
-- And that no model reaches the top of the feed on one person's generations —
-- expected to be 0 once the backfill has run:
--
--   SELECT count(*) AS single_generator_in_top_100
--     FROM (SELECT "uniqueGeneratorCount" AS g, "generationCount" AS n
--             FROM "ModelMetric"
--            WHERE status = 'Published' AND ("nsfwLevel" & 3) != 0
--              AND poi = false AND minor = false
--            ORDER BY "hotScore" DESC LIMIT 100) t
--    WHERE t.g <= 1 AND t.n >= 500;

-- Score a base-model-filtered feed on that base model's own engagement.
--
-- "ModelBaseModelMetric"."hotScore" has been a COPY of the whole-model score. For a
-- model with versions in several ecosystems that credits it, in every filter, for
-- engagement it earned somewhere else: filter to one base model and a model whose slice
-- there is small can outrank one whose every download is that base model. Testers found
-- this on the Anima filter, and it was a deliberate simplification when the mirror was
-- added in 20261010120000, not an accident.
--
-- So the mirror stops copying and starts computing, from the columns that already sit on
-- "ModelBaseModelMetric" per base model (thumbsUpCount, downloadCount) plus the three
-- added here. Same formula as the whole-model score, same cap:
--
--   least(generationCount / 4.1, uniqueGeneratorCount * 100)
--
-- THE TIME TERM IS THE EARLIEST PUBLISHED VERSION FOR THAT BASE MODEL, not the model's
-- first publish and not its newest version. That is the only choice here that is not
-- forced:
--
--   * The model's first publish date would make a brand-new Anima version on a two-year
--     old model read as two years old in the Anima feed, which is the complaint inverted.
--   * The newest version's date would re-open the version-spam incentive that
--     20261010120000 closes, inside every filtered feed.
--   * The earliest version FOR THAT BASE MODEL gets both right. A model's first Anima
--     version is new in the Anima feed and still old in the Illustrious feed. A second
--     Anima version later refreshes nothing, because the earliest is kept.
--
-- 🔴 APPLY THIS FILE, THEN RUN THE BACKFILL. It changes no score on its own.
-- All three columns are NULLABLE on purpose, and the trigger gates on
-- "uniqueGeneratorCount" specifically because it is the one that arrives LAST: generations
-- and the publish date are plain SQL aggregates, but the distinct-generator count has to
-- come from ClickHouse, which Postgres cannot read. Gating on the last arrival means a row
-- flips to its own score only with all three in hand, never on a partial formula. Until
-- then the trigger mirrors the whole-model score, which is exactly today's behaviour.
--
-- The backfill writes all three together: /api/admin/temp/backfill-base-model-hot-score.
--
-- Ordinary DDL, transaction-safe. Like 20261011120000 and unlike 20261010120000 it wants
-- a SHORT lock_timeout, because ADD COLUMN takes a brief ACCESS EXCLUSIVE lock on a table
-- the metrics job writes continuously:
--
--   SET lock_timeout = '5s';
--
-- If it times out, retry. Do not clear the timeout.
--
-- "mbmm_feed_hot" needs no change: it is already
-- ("baseModel", "hotScore" DESC, "modelId") INCLUDE (...), and only the values change.

-- 1. The columns --------------------------------------------------------------

ALTER TABLE "ModelBaseModelMetric"
    ADD COLUMN IF NOT EXISTS "generationCount" INT,
    ADD COLUMN IF NOT EXISTS "uniqueGeneratorCount" INT,
    ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);

-- 2. Compute instead of copy --------------------------------------------------

CREATE OR REPLACE FUNCTION public.base_model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- NULL "uniqueGeneratorCount" = this slice has not been measured. Keep mirroring the
    -- whole-model score rather than scoring on a partial formula.
    IF NEW."uniqueGeneratorCount" IS NULL THEN
        SELECT coalesce(mm."hotScore", 0) INTO NEW."hotScore"
          FROM "ModelMetric" mm
         WHERE mm."modelId" = NEW."modelId";
        -- coalesce twice: the SELECT assigns NULL when no ModelMetric row exists at all,
        -- and a NULL would sort to the TOP of this base model's feed.
        NEW."hotScore" := coalesce(NEW."hotScore", 0);
        RETURN NEW;
    END IF;

    -- Derived here rather than by the caller so any writer gets it right, and only on the
    -- first write of a measured row. "ModelVersion_modelId_baseModel_idx" serves it.
    IF NEW."publishedAt" IS NULL THEN
        SELECT min(mv."publishedAt") INTO NEW."publishedAt"
          FROM "ModelVersion" mv
         WHERE mv."modelId" = NEW."modelId"
           AND mv."baseModel" = NEW."baseModel"
           AND mv.status = 'Published';
    END IF;

    NEW."hotScore" := round(
        (
            log(
                1
                + NEW."thumbsUpCount"
                -- Divisors, the generator cap and the clamp: see 20261010120000 and
                -- 20261011120000. Deliberately identical, so a model's rank does not jump
                -- when a filter is applied.
                + NEW."downloadCount" / 6.4
                + CASE
                      WHEN NEW."uniqueGeneratorCount" > 0
                          THEN least(
                                   coalesce(NEW."generationCount", 0) / 4.1,
                                   NEW."uniqueGeneratorCount" * 100.0
                               )
                      ELSE coalesce(NEW."generationCount", 0) / 4.1
                  END
            )
            + extract(epoch FROM least(coalesce(NEW."publishedAt", TIMESTAMP 'epoch'), NOW())) / 2592000
        ) * 10000
    )::int;

    RETURN NEW;
END
$function$;

CREATE OR REPLACE TRIGGER trg_base_model_metric_hot_score
    BEFORE INSERT OR UPDATE OF "thumbsUpCount", "downloadCount", "generationCount",
                               "uniqueGeneratorCount", "publishedAt", "hotScore"
    ON "ModelBaseModelMetric"
    FOR EACH ROW
    EXECUTE FUNCTION public.base_model_metric_hot_score();

-- 3. Drop the fan-out, which has never fired ----------------------------------
--
-- 20261010120000 added trg_model_metric_hot_score_fanout AS
-- `AFTER UPDATE OF "hotScore"` to push the whole-model score down to every base-model row.
-- UPDATE OF fires on the columns named in the UPDATE statement's SET list, NOT on columns a
-- BEFORE trigger went on to change — and nothing ever SETs "hotScore" explicitly, because
-- trg_model_metric_hot_score computes it. So the fan-out has never run.
--
-- It did not matter: the pull side (trg_base_model_metric_hot_score, above) reads
-- "ModelMetric"."hotScore" whenever a base-model row is written, and the metrics job writes
-- those rows continuously, so the mirror stayed current by that route the whole time.
--
-- Rather than repair it, drop it. Once the backfill has run, every row computes its own
-- score and a push from the whole-model score is exactly what must NOT happen.

DROP TRIGGER IF EXISTS trg_model_metric_hot_score_fanout ON "ModelMetric";
DROP FUNCTION IF EXISTS public.model_metric_hot_score_fanout();

-- Verification -----------------------------------------------------------------
--
-- Straight after this file: measured = 0 and the feed is unchanged.
--
-- After the backfill: measured should be close to total, and divergence should be
-- non-zero — that number IS the fix. It counts rows whose per-base-model score differs
-- from the whole-model score they used to carry, which is the mis-ranking testers saw.
--
--   SELECT count(*) AS total,
--          count(bm."uniqueGeneratorCount") AS measured,
--          count(*) FILTER (WHERE bm."uniqueGeneratorCount" IS NOT NULL
--                             AND bm."hotScore" IS DISTINCT FROM mm."hotScore") AS divergence
--     FROM "ModelBaseModelMetric" bm
--     JOIN "ModelMetric" mm ON mm."modelId" = bm."modelId"
--    WHERE bm.status = 'Published';
--
-- And that a multi-ecosystem model no longer outranks a single-ecosystem one on borrowed
-- engagement. Pick any base model; the slice columns should explain the order:
--
--   SELECT bm."modelId", bm."hotScore", bm."thumbsUpCount", bm."downloadCount",
--          bm."generationCount", bm."publishedAt"::date,
--          mm."thumbsUpCount" AS whole_model_likes, mm."downloadCount" AS whole_model_dls
--     FROM "ModelBaseModelMetric" bm
--     JOIN "ModelMetric" mm ON mm."modelId" = bm."modelId"
--    WHERE bm."baseModel" = 'Anima' AND bm.status = 'Published'
--      AND (bm."nsfwLevel" & 3) != 0 AND bm.poi = false AND bm.minor = false
--    ORDER BY bm."hotScore" DESC LIMIT 20;

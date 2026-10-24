-- The first distinct generator earns nothing. One person is not evidence.
--
--   generation term = least(generationCount / 4.1, (uniqueGeneratorCount - 1) * 100)
--
-- 20261011120000's per-generator cap was calibrated on the whole-model feed; in the thin
-- base-model feeds 20261012120000 created, one generator's 100 like-equivalents alone
-- reached the top ten. A floor, not a minimum-count gate: a gate has a cliff at N, this is
-- monotonic and continuous, and the constant is unchanged so nothing is re-tuned.
--
-- 🔴 uniqueGeneratorCount = 0 NOW MEANS NO GENERATION CREDIT. 20261011120000 made 0
-- deliberately inert, because 0 meant "not computed yet" while its backfill ran, and that
-- left the signal uncapped for anything the backfill had not reached — including every
-- model published afterwards, since nothing maintained the column until the deploy.
--
--   THEREFORE THIS FILE MUST NOT BE APPLIED BEFORE 20261011120000's AND 20261012120000's
--   BACKFILLS HAVE RUN. Applied early it strips the generation term from every model whose
--   count has not been computed. On a fresh database, run them first:
--     /api/admin/temp/backfill-unique-generators
--     /api/admin/temp/backfill-base-model-hot-score
--
-- 🔴 APPLY WITHOUT --single-transaction. Section 3 is a CALL whose procedure COMMITs per
-- batch, which cannot run inside a transaction block.
--
-- No application change ships with this: the formula lives only in these two functions.
--
-- Measurements, per-feed bars and simulated before/after:
-- docs/model-feed-hot-ranking.md §16.

-- 1. The whole-model score ----------------------------------------------------

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
                -- Divisors: see 20261010120000.
                + NEW."downloadCount" / 6.4
                + least(
                      NEW."generationCount" / 4.1,
                      greatest(NEW."uniqueGeneratorCount" - 1, 0) * 100.0
                  )
            )
            -- Clamp and epoch fallback: see 20261010120000.
            + extract(epoch FROM least(coalesce(NEW."publishedAt", TIMESTAMP 'epoch'), NOW())) / 2592000
        ) * 10000
    )::int;

    RETURN NEW;
END
$function$;

-- 2. The per-base-model score -------------------------------------------------
--
-- Same term as above, so a model's rank does not jump when a filter is applied.

CREATE OR REPLACE FUNCTION public.base_model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- NULL = this slice has not been measured; keep mirroring. A slice nobody generated
    -- with is a measured 0, not NULL.
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
                + NEW."downloadCount" / 6.4
                + least(
                      coalesce(NEW."generationCount", 0) / 4.1,
                      greatest(NEW."uniqueGeneratorCount" - 1, 0) * 100.0
                  )
            )
            + extract(epoch FROM least(coalesce(NEW."publishedAt", TIMESTAMP 'epoch'), NOW())) / 2592000
        ) * 10000
    )::int;

    RETURN NEW;
END
$function$;

-- 3. Rescore what the floor actually moves ------------------------------------
--
-- Replacing a function does not touch a stored score, so without this the new formula
-- would only reach a row the next time the metrics job wrote it.
--
-- Only rows where the NEW cap binds can change, and the predicate below is exact rather
-- than conservative. Where the new cap does not bind, the term is generationCount / 4.1
-- under both formulas, because the old cap was strictly higher. Where it does bind, the
-- two differ. That covers 0 as well: the old formula's ELSE branch gave an uncapped term,
-- the new one gives nothing.
--
-- Each UPDATE assigns "uniqueGeneratorCount" to itself. The value does not change; being
-- in the SET list is what makes UPDATE OF fire, which is what recomputes the score.

CREATE OR REPLACE PROCEDURE public.rescore_hot_generator_floor(batch_size INT DEFAULT 250000)
LANGUAGE plpgsql
AS $procedure$
DECLARE
    lo INT;
    hi INT;
    touched INT;
BEGIN
    SELECT max("modelId") INTO hi FROM "ModelMetric";
    lo := 0;
    WHILE hi IS NOT NULL AND lo <= hi LOOP
        UPDATE "ModelMetric" mm
           SET "uniqueGeneratorCount" = mm."uniqueGeneratorCount"
         WHERE mm."modelId" >= lo
           AND mm."modelId" < lo + batch_size
           AND mm."generationCount" > 0
           AND mm."generationCount" / 4.1 > greatest(mm."uniqueGeneratorCount" - 1, 0) * 100.0;
        GET DIAGNOSTICS touched = ROW_COUNT;
        COMMIT;
        RAISE NOTICE 'ModelMetric ids %-%: % rescored', lo, lo + batch_size, touched;
        lo := lo + batch_size;
    END LOOP;

    SELECT max("modelId") INTO hi FROM "ModelBaseModelMetric";
    lo := 0;
    WHILE hi IS NOT NULL AND lo <= hi LOOP
        UPDATE "ModelBaseModelMetric" bm
           SET "uniqueGeneratorCount" = bm."uniqueGeneratorCount"
         WHERE bm."modelId" >= lo
           AND bm."modelId" < lo + batch_size
           AND bm."uniqueGeneratorCount" IS NOT NULL
           AND coalesce(bm."generationCount", 0) > 0
           AND coalesce(bm."generationCount", 0) / 4.1
               > greatest(bm."uniqueGeneratorCount" - 1, 0) * 100.0;
        GET DIAGNOSTICS touched = ROW_COUNT;
        COMMIT;
        RAISE NOTICE 'ModelBaseModelMetric ids %-%: % rescored', lo, lo + batch_size, touched;
        lo := lo + batch_size;
    END LOOP;

    -- Runs last: the mirror copies ModelMetric's score, which the first loop has just
    -- changed.
    lo := 0;
    WHILE hi IS NOT NULL AND lo <= hi LOOP
        UPDATE "ModelBaseModelMetric" bm
           SET "uniqueGeneratorCount" = bm."uniqueGeneratorCount"
         WHERE bm."modelId" >= lo
           AND bm."modelId" < lo + batch_size
           AND bm."uniqueGeneratorCount" IS NULL
           AND bm."hotScore" IS DISTINCT FROM coalesce(
                   (SELECT mm."hotScore" FROM "ModelMetric" mm WHERE mm."modelId" = bm."modelId"),
                   0
               );
        GET DIAGNOSTICS touched = ROW_COUNT;
        COMMIT;
        RAISE NOTICE 'ModelBaseModelMetric mirror ids %-%: % refreshed', lo, lo + batch_size, touched;
        lo := lo + batch_size;
    END LOOP;
END
$procedure$;

CALL public.rescore_hot_generator_floor();

DROP PROCEDURE public.rescore_hot_generator_floor(INT);

-- Verification -----------------------------------------------------------------
--
-- Both checks count rows at the top of a feed that one person's generations could carry.
-- Expect 0, or near it: the predicate tests count <= 1, so it also matches a model with no
-- generator data at all that is ranked on real likes and downloads. On the 2026-10-12
-- production run the second query returned 9, of which 8 were exactly that. Read the likes
-- and downloads of any row it returns before treating it as a finding.
--
-- Do NOT verify by recomputing the formula and comparing: a row whose publishedAt is in
-- the future is clamped to NOW(), so its score legitimately drifts from any later
-- recomputation. Compare with a tolerance, or restrict to status = 'Published'.
--
--   SELECT count(*) AS single_generator_in_whole_model_top_100
--     FROM (SELECT "uniqueGeneratorCount" g, "generationCount" n
--             FROM "ModelMetric"
--            WHERE status = 'Published' AND ("nsfwLevel" & 3) != 0
--              AND poi = false AND minor = false
--            ORDER BY "hotScore" DESC LIMIT 100) t
--    WHERE t.g <= 1 AND t.n >= 500;
--
--   SELECT bms."baseModel", count(*) AS single_generator_in_top_100
--     FROM (SELECT DISTINCT "baseModel" FROM "ModelBaseModelMetric"
--            WHERE status = 'Published') bms
--     CROSS JOIN LATERAL (
--          SELECT bm."uniqueGeneratorCount" g, bm."generationCount" n
--            FROM "ModelBaseModelMetric" bm
--           WHERE bm."baseModel" = bms."baseModel" AND bm.status = 'Published'
--             AND (bm."nsfwLevel" & 3) != 0 AND bm.poi = false AND bm.minor = false
--           ORDER BY bm."hotScore" DESC LIMIT 100) t
--    WHERE t.g <= 1 AND t.n >= 500
--    GROUP BY 1 ORDER BY 2 DESC;
--
-- And that the quiet feeds still have content at the top rather than having been emptied
-- of whatever was holding those slots. Generator counts should be spread, not 1:
--
--   SELECT bm."modelId", bm."hotScore", bm."thumbsUpCount", bm."downloadCount",
--          bm."generationCount", bm."uniqueGeneratorCount", bm."publishedAt"::date
--     FROM "ModelBaseModelMetric" bm
--    WHERE bm."baseModel" = 'SDXL 1.0' AND bm.status = 'Published'
--      AND (bm."nsfwLevel" & 3) != 0 AND bm.poi = false AND bm.minor = false
--    ORDER BY bm."hotScore" DESC LIMIT 10;

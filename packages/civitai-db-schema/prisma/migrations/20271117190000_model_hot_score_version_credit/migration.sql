-- Hot credits a model's newer versions, each on its own engagement, capped.
--
--   hotScore = greatest(model term, best Published version term)
--   model term   = unchanged: lifetime counts + the model's publishedAt
--   version term = least(log10(1 + that version's engagement), 2.0) + the version's publishedAt
--
-- A version never borrows the model's lifetime engagement: pairing that with a fresh date is
-- what docs/model-feed-hot-ranking.md §2 measured and rejected (39 of the top 50 became old
-- models that had just added a version). The 2.0 cap means a version can rank a model at most
-- like a brand-new model with 100 engagement published the same day, which sits below the top
-- 100 of the whole-model feed. Options and replica measurements: §18.
--
-- Version rows have no distinct-generator count, so a version's generation term is capped by
-- the model's (or the slice's) uniqueGeneratorCount, an upper bound on the version's own.
--
-- 🔴 APPLY WITHOUT --single-transaction: section 4 is a CALL whose procedure COMMITs per batch.
--
-- No application change ships with this: the formula lives only in these functions.

-- 1. The formula, in one place ------------------------------------------------
--
-- Both trigger functions call this, for the model term and the version term alike.
-- engagement_cap NULL = uncapped (LEAST ignores NULL). STABLE, not IMMUTABLE: it reads NOW().

CREATE OR REPLACE FUNCTION public.hot_score(
    likes numeric,
    downloads numeric,
    generations numeric,
    unique_generators int,
    published_at timestamp,
    engagement_cap numeric DEFAULT NULL
)
RETURNS int
LANGUAGE sql
STABLE
AS $function$
    SELECT round(
        (
            least(
                log(
                    1
                    + likes
                    -- Divisors: see 20261010120000. Generator floor: see 20261013120000.
                    + downloads / 6.4
                    + least(generations / 4.1, greatest(unique_generators - 1, 0) * 100.0)
                ),
                engagement_cap
            )
            -- Clamp and epoch fallback: see 20261010120000.
            + extract(epoch FROM least(coalesce(published_at, TIMESTAMP 'epoch'), NOW())) / 2592000
        ) * 10000
    )::int
$function$;

-- 2. The whole-model score ----------------------------------------------------

CREATE OR REPLACE FUNCTION public.model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    best_version int;
BEGIN
    -- "ModelVersion_modelId_idx" (hash) serves the lookup; most models have 1-3 versions.
    SELECT max(public.hot_score(
               mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
               NEW."uniqueGeneratorCount", mv."publishedAt", 2.0))
      INTO best_version
      FROM "ModelVersion" mv
      JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
     WHERE mv."modelId" = NEW."modelId"
       AND mv.status = 'Published'
       AND mv."publishedAt" IS NOT NULL;

    -- GREATEST ignores NULL: no Published version leaves the model term alone.
    NEW."hotScore" := greatest(
        public.hot_score(
            NEW."thumbsUpCount", NEW."downloadCount", NEW."generationCount",
            NEW."uniqueGeneratorCount", NEW."publishedAt"),
        best_version
    );

    RETURN NEW;
END
$function$;

-- "lastVersionAt" joins the list so a version publish rescores the model explicitly. Today it
-- also fires through "publishedAt", which sync_model_to_metric happens to SET alongside it.
CREATE OR REPLACE TRIGGER trg_model_metric_hot_score
    BEFORE INSERT OR UPDATE OF "thumbsUpCount", "downloadCount", "generationCount",
                               "uniqueGeneratorCount", "publishedAt", "lastVersionAt"
    ON "ModelMetric"
    FOR EACH ROW
    EXECUTE FUNCTION public.model_metric_hot_score();

-- 3. The per-base-model score -------------------------------------------------
--
-- Same terms, and a slice is credited only by versions of its own base model.

CREATE OR REPLACE FUNCTION public.base_model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    best_version int;
BEGIN
    -- NULL = this slice has not been measured; keep mirroring. A slice nobody generated
    -- with is a measured 0, not NULL. The mirrored score already carries the version credit.
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
    -- first write of a measured row.
    IF NEW."publishedAt" IS NULL THEN
        SELECT min(mv."publishedAt") INTO NEW."publishedAt"
          FROM "ModelVersion" mv
         WHERE mv."modelId" = NEW."modelId"
           AND mv."baseModel" = NEW."baseModel"
           AND mv.status = 'Published';
    END IF;

    SELECT max(public.hot_score(
               mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
               NEW."uniqueGeneratorCount", mv."publishedAt", 2.0))
      INTO best_version
      FROM "ModelVersion" mv
      JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
     WHERE mv."modelId" = NEW."modelId"
       AND mv."baseModel" = NEW."baseModel"
       AND mv.status = 'Published'
       AND mv."publishedAt" IS NOT NULL;

    NEW."hotScore" := greatest(
        public.hot_score(
            NEW."thumbsUpCount", NEW."downloadCount", coalesce(NEW."generationCount", 0),
            NEW."uniqueGeneratorCount", NEW."publishedAt"),
        best_version
    );

    RETURN NEW;
END
$function$;

-- 4. Rescore the rows a version can lift --------------------------------------
--
-- Replacing a function does not touch a stored score. The predicate is exact: the new score
-- differs from the stored one only where a version term beats it (the model term is
-- unchanged). Each UPDATE assigns "uniqueGeneratorCount" to itself; being in the SET list is
-- what makes UPDATE OF fire and recompute the score.

CREATE OR REPLACE PROCEDURE public.rescore_hot_version_credit(batch_size INT DEFAULT 250000)
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
           AND EXISTS (
                 SELECT 1
                   FROM "ModelVersion" mv
                   JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
                  WHERE mv."modelId" = mm."modelId"
                    AND mv.status = 'Published'
                    AND mv."publishedAt" IS NOT NULL
                    AND public.hot_score(
                          mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
                          mm."uniqueGeneratorCount", mv."publishedAt", 2.0)
                        > coalesce(mm."hotScore", 0));
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
           AND EXISTS (
                 SELECT 1
                   FROM "ModelVersion" mv
                   JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
                  WHERE mv."modelId" = bm."modelId"
                    AND mv."baseModel" = bm."baseModel"
                    AND mv.status = 'Published'
                    AND mv."publishedAt" IS NOT NULL
                    AND public.hot_score(
                          mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
                          bm."uniqueGeneratorCount", mv."publishedAt", 2.0)
                        > coalesce(bm."hotScore", 0));
        GET DIAGNOSTICS touched = ROW_COUNT;
        COMMIT;
        RAISE NOTICE 'ModelBaseModelMetric ids %-%: % rescored', lo, lo + batch_size, touched;
        lo := lo + batch_size;
    END LOOP;

    -- Runs last: the mirror copies ModelMetric's score, which the first loop has just changed.
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

CALL public.rescore_hot_version_credit();

DROP PROCEDURE public.rescore_hot_version_credit(INT);

-- Verification -----------------------------------------------------------------
--
-- 1. No version-lifted model in the whole-model top 100. Expect 0: a capped version term is
--    at most a same-day new model with 100 engagement, which ranked below the top 100 when the
--    cap was chosen (§18). A non-zero count means the 100th score has dropped; read the rows
--    before treating it as a finding.
--
--   SELECT count(*) AS version_lifted_in_top_100
--     FROM (SELECT mm."modelId", mm."hotScore",
--                  public.hot_score(mm."thumbsUpCount", mm."downloadCount", mm."generationCount",
--                                   mm."uniqueGeneratorCount", mm."publishedAt") AS model_term
--             FROM "ModelMetric" mm
--            WHERE mm.status = 'Published' AND (mm."nsfwLevel" & 3) != 0
--              AND NOT mm.poi AND NOT mm.minor
--            ORDER BY mm."hotScore" DESC LIMIT 100) t
--    WHERE t."hotScore" > t.model_term;
--
-- 2. A named row moved. Expect hotScore above its model term when it has a recent version:
--
--   SELECT mm."modelId", mm."hotScore",
--          public.hot_score(mm."thumbsUpCount", mm."downloadCount", mm."generationCount",
--                           mm."uniqueGeneratorCount", mm."publishedAt") AS model_term
--     FROM "ModelMetric" mm WHERE mm."modelId" = <id>;
--
-- Do NOT verify by recomputing and comparing exactly: a future-dated publishedAt is clamped to
-- NOW() at write time, so its score drifts from any later recomputation.

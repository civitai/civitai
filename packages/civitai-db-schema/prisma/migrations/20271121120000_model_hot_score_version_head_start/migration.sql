-- Hot gives a proven model's new version a small head start from the model's track record.
--
--   hotScore = greatest(model term, best Published version term)
--   model term   = unchanged
--   version term = qualifying: least(log10(1 + e_v + 0.01 * max(E - e_v, 0)), 2.2) + t_v
--                  otherwise:  least(log10(1 + e_v), 2.0) + t_v            (unchanged, #9397)
--
--   E   = the model's (or the slice's) lifetime engagement
--   e_v = the version's own engagement
--   qualifying = the version's own likes + downloads / 6.4 >= 25 (generations excluded: a
--                version's generation term is capped by the model's generator count, so the
--                creator's own generating could clear the bar), published in the last 60 days,
--                and publishedAt < initialPublishedAt + 1 day (a timed paid-access gate that ends
--                re-dates the version; that re-date earns no second head start).
--
-- This reverses the "a version never borrows the model's lifetime engagement" rule of
-- 20271117190000 on purpose: the borrowed share is 1%, capped, and only for a version with
-- engagement of its own. Paid-access versions qualify like free ones.
--
-- 🔴 APPLY WITHOUT --single-transaction: section 4 is a CALL whose procedure COMMITs per batch.
--
-- No application change ships with this: the formula lives only in these functions.

-- 1. The version term ----------------------------------------------------------
--
-- Both triggers and the rescore call this. Each term is rounded to the stored int scale before
-- the caller takes the max, as hot_score() does. The 60-day window reads NOW(), so a stored score
-- keeps its head start until the row's next metrics write; by then t_v is two months old.

CREATE OR REPLACE FUNCTION public.hot_version_score(
    likes numeric,
    downloads numeric,
    generations numeric,
    unique_generators int,
    published_at timestamp,
    initial_published_at timestamp,
    model_likes numeric,
    model_downloads numeric,
    model_generations numeric
)
RETURNS int
LANGUAGE sql
STABLE
AS $function$
    SELECT CASE
        WHEN likes + downloads / 6.4 >= 25
         AND published_at > NOW() - INTERVAL '60 days'
         AND published_at < coalesce(initial_published_at, published_at) + INTERVAL '1 day'
        THEN round(
            (
                least(log(1 + e.v + 0.01 * greatest(e.m - e.v, 0)), 2.2)
                + extract(epoch FROM least(published_at, NOW())) / 2592000
            ) * 10000
        )::int
        ELSE public.hot_score(likes, downloads, generations, unique_generators, published_at, 2.0)
    END
    FROM (
        SELECT likes + downloads / 6.4
                 + least(generations / 4.1, greatest(unique_generators - 1, 0) * 100.0) AS v,
               model_likes + model_downloads / 6.4
                 + least(model_generations / 4.1, greatest(unique_generators - 1, 0) * 100.0) AS m
    ) e
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
    SELECT max(public.hot_version_score(
               mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
               NEW."uniqueGeneratorCount", mv."publishedAt", mv."initialPublishedAt",
               NEW."thumbsUpCount", NEW."downloadCount", NEW."generationCount"))
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

-- 3. The per-base-model score -------------------------------------------------
--
-- Same terms; E is the slice's own engagement, and a slice is credited only by versions of its
-- own base model.

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

    SELECT max(public.hot_version_score(
               mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
               NEW."uniqueGeneratorCount", mv."publishedAt", mv."initialPublishedAt",
               NEW."thumbsUpCount", NEW."downloadCount", coalesce(NEW."generationCount", 0)))
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

-- 4. Rescore the rows a head start can lift -----------------------------------
--
-- Replacing a function does not touch a stored score. Only a qualifying version's term changed,
-- and every qualifying version was published in the last 60 days, so the candidates come from
-- one scan of those versions (ModelVersion has no publishedAt index: this is a sequential scan,
-- read-only). The UPDATE predicate is exact: a row is written only where a qualifying term beats
-- its stored score. Each UPDATE assigns "uniqueGeneratorCount" to itself; being in the SET list
-- is what makes UPDATE OF fire and recompute the score.
--
-- Batches are small (the per-minute metrics job writes these rows too), each COMMITs, and before
-- each batch the procedure waits while any streaming replica visible to this role is more than
-- max_lag_bytes behind. No visible replica = no wait; it says so once, so watch lag yourself.

CREATE OR REPLACE PROCEDURE public.rescore_hot_version_head_start(
    batch_size INT DEFAULT 2000,
    max_lag_bytes BIGINT DEFAULT 268435456
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
    ids INT[];
    batch INT[];
    i INT;
    touched INT;
    replica_lag NUMERIC;
    watch_lag BOOLEAN;
BEGIN
    ids := ARRAY(
        SELECT DISTINCT mv."modelId"
          FROM "ModelVersion" mv
          JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
         WHERE mv.status = 'Published'
           AND mv."publishedAt" > NOW() - INTERVAL '60 days'
           AND mv."publishedAt" < coalesce(mv."initialPublishedAt", mv."publishedAt") + INTERVAL '1 day'
           AND mvm."thumbsUpCount" + mvm."downloadCount" / 6.4 >= 25
         ORDER BY 1);
    RAISE NOTICE 'head start candidates: % models', coalesce(array_length(ids, 1), 0);

    SELECT count(replay_lsn) > 0 INTO watch_lag FROM pg_stat_replication;
    IF NOT watch_lag THEN
        RAISE NOTICE 'no replica lag visible to this role: lag watch is OFF, watch it yourself';
    END IF;

    i := 1;
    WHILE i <= coalesce(array_length(ids, 1), 0) LOOP
        batch := ids[i:i + batch_size - 1];
        LOOP
            EXIT WHEN NOT watch_lag;
            SELECT max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) INTO replica_lag
              FROM pg_stat_replication;
            EXIT WHEN coalesce(replica_lag, 0) <= max_lag_bytes;
            RAISE NOTICE 'replica % bytes behind, waiting', replica_lag;
            PERFORM pg_sleep(5);
        END LOOP;

        UPDATE "ModelMetric" mm
           SET "uniqueGeneratorCount" = mm."uniqueGeneratorCount"
         WHERE mm."modelId" = ANY (batch)
           AND EXISTS (
                 SELECT 1
                   FROM "ModelVersion" mv
                   JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
                  WHERE mv."modelId" = mm."modelId"
                    AND mv.status = 'Published'
                    AND mv."publishedAt" IS NOT NULL
                    AND public.hot_version_score(
                          mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
                          mm."uniqueGeneratorCount", mv."publishedAt", mv."initialPublishedAt",
                          mm."thumbsUpCount", mm."downloadCount", mm."generationCount")
                        > coalesce(mm."hotScore", 0));
        GET DIAGNOSTICS touched = ROW_COUNT;
        RAISE NOTICE 'ModelMetric batch from id %: % rescored', batch[1], touched;

        UPDATE "ModelBaseModelMetric" bm
           SET "uniqueGeneratorCount" = bm."uniqueGeneratorCount"
         WHERE bm."modelId" = ANY (batch)
           AND bm."uniqueGeneratorCount" IS NOT NULL
           AND EXISTS (
                 SELECT 1
                   FROM "ModelVersion" mv
                   JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
                  WHERE mv."modelId" = bm."modelId"
                    AND mv."baseModel" = bm."baseModel"
                    AND mv.status = 'Published'
                    AND mv."publishedAt" IS NOT NULL
                    AND public.hot_version_score(
                          mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
                          bm."uniqueGeneratorCount", mv."publishedAt", mv."initialPublishedAt",
                          bm."thumbsUpCount", bm."downloadCount", coalesce(bm."generationCount", 0))
                        > coalesce(bm."hotScore", 0));
        GET DIAGNOSTICS touched = ROW_COUNT;
        RAISE NOTICE 'ModelBaseModelMetric batch from id %: % rescored', batch[1], touched;

        -- After the ModelMetric update above: the mirror copies the score it has just changed.
        UPDATE "ModelBaseModelMetric" bm
           SET "uniqueGeneratorCount" = bm."uniqueGeneratorCount"
         WHERE bm."modelId" = ANY (batch)
           AND bm."uniqueGeneratorCount" IS NULL
           AND bm."hotScore" IS DISTINCT FROM coalesce(
                   (SELECT mm."hotScore" FROM "ModelMetric" mm WHERE mm."modelId" = bm."modelId"),
                   0
               );
        GET DIAGNOSTICS touched = ROW_COUNT;
        RAISE NOTICE 'ModelBaseModelMetric mirror batch from id %: % refreshed', batch[1], touched;

        COMMIT;
        i := i + batch_size;
    END LOOP;
END
$procedure$;

CALL public.rescore_hot_version_head_start();

DROP PROCEDURE public.rescore_hot_version_head_start(INT, BIGINT);

-- Verification: the read-back and the daily check are in the PR body, with their expected
-- values. Do NOT verify by recomputing and comparing exactly: a future-dated publishedAt is
-- clamped to NOW() at write time, so its score drifts from any later recomputation.

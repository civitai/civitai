-- Rollback for migration.sql: restores the 20271121120000 (#9928) bar, without buyers, and rescores
-- every model with an access row on a version published since `since`. The default, 2026-09-22, covers any
-- apply date; to narrow it, pass the apply date minus 61 days.
--
-- 🔴 APPLY WITH psql -X -v ON_ERROR_STOP=1 AND WITHOUT --single-transaction: the preflight must stop
-- the file on refusal, and the CALL COMMITs per batch. A re-run is safe; it starts the rescore over.

BEGIN;

-- Preflight (as migration.sql) -------------------------------------------------

DO $preflight$
BEGIN
    IF coalesce(current_setting('hot_rescore.lag_watch', true), 'on') <> 'off'
       AND NOT EXISTS (SELECT 1 FROM pg_stat_replication WHERE replay_lsn IS NOT NULL) THEN
        RAISE EXCEPTION 'no replica lag visible to this role: run as a role with pg_monitor, or SET hot_rescore.lag_watch = off; and watch lag yourself';
    END IF;
END
$preflight$;

-- The 20271121120000 functions, verbatim ---------------------------------------

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
-- One expression on purpose: a FROM clause stops the planner inlining it into the trigger's
-- version scan. The version's engagement is written out twice for that reason.
AS $function$
    SELECT CASE
        WHEN likes + downloads / 6.4 >= 25
         AND published_at > NOW() - INTERVAL '60 days'
         AND published_at < coalesce(initial_published_at, published_at) + INTERVAL '1 day'
        THEN round(
            (
                least(
                    log(
                        1
                        + (likes + downloads / 6.4
                           + least(generations / 4.1, greatest(unique_generators - 1, 0) * 100.0))
                        + 0.01 * greatest(
                            (model_likes + model_downloads / 6.4
                             + least(model_generations / 4.1, greatest(unique_generators - 1, 0) * 100.0))
                            - (likes + downloads / 6.4
                               + least(generations / 4.1, greatest(unique_generators - 1, 0) * 100.0)),
                            0)
                    ),
                    2.2
                )
                + extract(epoch FROM least(published_at, NOW())) / 2592000
            ) * 10000
        )::int
        ELSE public.hot_score(likes, downloads, generations, unique_generators, published_at, 2.0)
    END
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

DROP FUNCTION IF EXISTS public.hot_version_score(
    numeric, numeric, numeric, int, timestamp, timestamp, numeric, numeric, numeric, numeric);

-- Unconditional: buyers only ever raised a score, so a "beats the stored score" predicate would
-- match none of the rows to lower. Any status and any access row, purchase key or not: a version
-- unpublished, or a purchase refunded, since may have raised a row that has not been rewritten.
CREATE OR REPLACE PROCEDURE public.rescore_hot_version_buyer_bar_rollback(
    since TIMESTAMP DEFAULT TIMESTAMP '2026-09-22',
    batch_size INT DEFAULT 500,
    max_lag_bytes BIGINT DEFAULT 268435456,
    max_wait INTERVAL DEFAULT '15 minutes'
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
    ids INT[];
    batch INT[];
    i INT;
    touched INT;
    watch BOOLEAN := coalesce(current_setting('hot_rescore.lag_watch', true), 'on') <> 'off';
    waited_since TIMESTAMPTZ;
    visible INT;
    replica_lag NUMERIC;
BEGIN
    ids := ARRAY(
        SELECT DISTINCT mv."modelId"
          FROM "ModelVersion" mv
         -- initialPublishedAt too: making a model private sets its versions' publishedAt to NULL.
         WHERE coalesce(mv."publishedAt", mv."initialPublishedAt") >= since
           AND EXISTS (
                 SELECT 1
                   FROM "EntityAccess" ea
                  WHERE ea."accessToId" = mv.id
                    AND ea."accessToType" = 'ModelVersion'
                    AND ea."accessorType" = 'User')
         ORDER BY 1);
    RAISE NOTICE 'rollback candidates: % models', coalesce(array_length(ids, 1), 0);
    COMMIT;

    i := 1;
    WHILE i <= coalesce(array_length(ids, 1), 0) LOOP
        batch := ids[i:i + batch_size - 1];
        IF watch THEN
            waited_since := clock_timestamp();
            LOOP
                SELECT count(replay_lsn), max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn))
                  INTO visible, replica_lag
                  FROM pg_stat_replication;
                IF visible = 0 THEN
                    RAISE EXCEPTION 'no replica lag visible: stopping. Committed batches stay; re-run to resume';
                END IF;
                EXIT WHEN replica_lag <= max_lag_bytes;
                IF clock_timestamp() - waited_since > max_wait THEN
                    RAISE EXCEPTION 'a replica is still % bytes behind after %: stopping. Committed batches stay; re-run to resume', replica_lag, max_wait;
                END IF;
                RAISE NOTICE 'replica % bytes behind, waiting', replica_lag;
                COMMIT;
                PERFORM pg_sleep(5);
            END LOOP;
        END IF;

        UPDATE "ModelMetric" mm
           SET "uniqueGeneratorCount" = mm."uniqueGeneratorCount"
         WHERE mm."modelId" = ANY (batch);
        GET DIAGNOSTICS touched = ROW_COUNT;
        RAISE NOTICE 'ModelMetric batch from id %: % rescored', batch[1], touched;

        UPDATE "ModelBaseModelMetric" bm
           SET "uniqueGeneratorCount" = bm."uniqueGeneratorCount"
         WHERE bm."modelId" = ANY (batch)
           AND bm."uniqueGeneratorCount" IS NOT NULL;
        GET DIAGNOSTICS touched = ROW_COUNT;
        RAISE NOTICE 'ModelBaseModelMetric batch from id %: % rescored', batch[1], touched;

        COMMIT;
        IF NOT watch THEN
            PERFORM pg_sleep(1);
        END IF;
        i := i + batch_size;
    END LOOP;
END
$procedure$;

COMMIT;

CALL public.rescore_hot_version_buyer_bar_rollback();

DROP PROCEDURE public.rescore_hot_version_buyer_bar_rollback(TIMESTAMP, INT, BIGINT, INTERVAL);

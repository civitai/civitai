-- Rollback for migration.sql: restores the 20271117190000 (#9397) trigger functions and rescores,
-- in both directions, every model with a version published since `since`. Pass the apply date
-- minus 61 days (a qualifying version's initialPublishedAt can be a day before its publishedAt); the
-- default is 61 days before this migration was written, which covers any apply date. The pre-apply snapshot is for comparison only: restoring it would rewind real metric gains.
--
-- 🔴 APPLY WITH psql -v ON_ERROR_STOP=1 AND WITHOUT --single-transaction: the preflight must stop
-- the file on refusal, and the CALL COMMITs per batch. A re-run is safe; it starts the rescore over.

-- Everything up to the CALL runs as one transaction: if the preflight refuses and psql carries on anyway (no
-- ON_ERROR_STOP), every later statement in it fails and nothing is replaced. The CALL runs after.
BEGIN;

-- Preflight ------------------------------------------------------------
--
-- The rescore below must watch replica lag. Refuse before changing anything when this role cannot
-- see it (pg_stat_replication's replay columns need pg_monitor or superuser), unless the operator
-- opts out for the session with SET hot_rescore.lag_watch = off; and watches lag by hand.
-- Run with psql -v ON_ERROR_STOP=1 so a refusal stops the file here.

DO $preflight$
BEGIN
    IF coalesce(current_setting('hot_rescore.lag_watch', true), 'on') <> 'off'
       AND NOT EXISTS (SELECT 1 FROM pg_stat_replication WHERE replay_lsn IS NOT NULL) THEN
        RAISE EXCEPTION 'no replica lag visible to this role: run as a role with pg_monitor, or SET hot_rescore.lag_watch = off; and watch lag yourself';
    END IF;
END
$preflight$;


CREATE OR REPLACE FUNCTION public.model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    best_version int;
BEGIN
    SELECT max(public.hot_score(
               mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
               NEW."uniqueGeneratorCount", mv."publishedAt", 2.0))
      INTO best_version
      FROM "ModelVersion" mv
      JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
     WHERE mv."modelId" = NEW."modelId"
       AND mv.status = 'Published'
       AND mv."publishedAt" IS NOT NULL;

    NEW."hotScore" := greatest(
        public.hot_score(
            NEW."thumbsUpCount", NEW."downloadCount", NEW."generationCount",
            NEW."uniqueGeneratorCount", NEW."publishedAt"),
        best_version
    );

    RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.base_model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    best_version int;
BEGIN
    IF NEW."uniqueGeneratorCount" IS NULL THEN
        SELECT coalesce(mm."hotScore", 0) INTO NEW."hotScore"
          FROM "ModelMetric" mm
         WHERE mm."modelId" = NEW."modelId";
        NEW."hotScore" := coalesce(NEW."hotScore", 0);
        RETURN NEW;
    END IF;

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

DROP FUNCTION IF EXISTS public.hot_version_score(
    numeric, numeric, numeric, int, timestamp, timestamp, numeric, numeric, numeric);

-- Unconditional: a head start only ever raised a score, so the predicate migration.sql used
-- would match none of the rows to lower. Any status: a version unpublished since may have raised a
-- row that has not been rewritten. A re-run rewrites every candidate again: correct, not a resume.
CREATE OR REPLACE PROCEDURE public.rescore_hot_version_head_start_rollback(
    since TIMESTAMP DEFAULT TIMESTAMP '2026-09-21',
    batch_size INT DEFAULT 2000,
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
         ORDER BY 1);
    RAISE NOTICE 'rollback candidates: % models', coalesce(array_length(ids, 1), 0);
    -- Releases the candidate scan's snapshot and locks before the first wait.
    COMMIT;

    i := 1;
    WHILE i <= coalesce(array_length(ids, 1), 0) LOOP
        batch := ids[i:i + batch_size - 1];
        -- Waits on replica lag before each batch, committing between polls so no snapshot is held
        -- while it sleeps. Raises after max_wait: committed batches stay; a re-run starts over.
        IF watch THEN
            waited_since := clock_timestamp();
            LOOP
                SELECT count(replay_lsn), max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn))
                  INTO visible, replica_lag
                  FROM pg_stat_replication;
                IF visible = 0 THEN
                    RAISE EXCEPTION 'no replica lag visible: stopping. Committed batches stay; re-running is safe';
                END IF;
                EXIT WHEN replica_lag <= max_lag_bytes;
                IF clock_timestamp() - waited_since > max_wait THEN
                    RAISE EXCEPTION 'a replica is still % bytes behind after %: stopping. Committed batches stay; re-running is safe', replica_lag, max_wait;
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

        -- Measured slices first, then mirrors, which copy the ModelMetric score just rewritten.
        UPDATE "ModelBaseModelMetric" bm
           SET "uniqueGeneratorCount" = bm."uniqueGeneratorCount"
         WHERE bm."modelId" = ANY (batch)
           AND bm."uniqueGeneratorCount" IS NOT NULL;
        UPDATE "ModelBaseModelMetric" bm
           SET "uniqueGeneratorCount" = bm."uniqueGeneratorCount"
         WHERE bm."modelId" = ANY (batch)
           AND bm."uniqueGeneratorCount" IS NULL;

        COMMIT;
        -- Opted out of the watch: pace the batches for whoever is watching lag by hand.
        IF NOT watch THEN
            PERFORM pg_sleep(1);
        END IF;
        i := i + batch_size;
    END LOOP;
END
$procedure$;

COMMIT;

CALL public.rescore_hot_version_head_start_rollback();

DROP PROCEDURE public.rescore_hot_version_head_start_rollback(TIMESTAMP, INT, BIGINT, INTERVAL);

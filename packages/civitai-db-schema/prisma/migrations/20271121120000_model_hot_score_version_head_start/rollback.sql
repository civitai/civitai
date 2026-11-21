-- Rollback for migration.sql: restores the 20271117190000 (#9397) trigger functions and rescores,
-- in both directions, every model with a version published since `since`. Pass the apply date
-- minus 60 days; the default is 60 days before this migration was written, which covers any apply
-- date. The pre-apply snapshot is for comparison only: restoring it would rewind real metric gains.
--
-- 🔴 APPLY WITHOUT --single-transaction: the CALL COMMITs per batch.

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

DROP FUNCTION public.hot_version_score(
    numeric, numeric, numeric, int, timestamp, timestamp, numeric, numeric, numeric);

-- Waits while any streaming replica is more than max_lag_bytes behind. Refuses to run unwatched:
-- with no replica visible to this role (the replay columns need pg_monitor or superuser) it raises
-- unless require_watch is false. Raises after max_wait, so a stuck sender stops the run instead of
-- parking it; batches already committed stay, and re-running the file resumes.
CREATE OR REPLACE FUNCTION public.hot_rescore_wait_for_replicas(
    max_lag_bytes BIGINT,
    max_wait INTERVAL,
    require_watch BOOLEAN
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
    visible INT;
    replica_lag NUMERIC;
    started TIMESTAMPTZ := clock_timestamp();
BEGIN
    LOOP
        SELECT count(replay_lsn), max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn))
          INTO visible, replica_lag
          FROM pg_stat_replication;
        IF visible = 0 THEN
            IF require_watch THEN
                RAISE EXCEPTION 'no replica lag visible to this role: run as a role with pg_monitor, or pass require_lag_watch => false and watch lag yourself';
            END IF;
            RETURN;
        END IF;
        EXIT WHEN replica_lag <= max_lag_bytes;
        IF clock_timestamp() - started > max_wait THEN
            RAISE EXCEPTION 'a replica is still % bytes behind after %: stopping. Committed batches stay; re-run to resume', replica_lag, max_wait;
        END IF;
        RAISE NOTICE 'replica % bytes behind, waiting', replica_lag;
        PERFORM pg_sleep(5);
    END LOOP;
END
$function$;

-- Unconditional: a head start only ever raised a score, so the predicate migration.sql used
-- would match none of the rows to lower. Any status: a version unpublished since may have raised a
-- row that has not been rewritten. Re-running is safe.
CREATE OR REPLACE PROCEDURE public.rescore_hot_version_head_start_rollback(
    since TIMESTAMP DEFAULT TIMESTAMP '2026-09-22',
    batch_size INT DEFAULT 2000,
    max_lag_bytes BIGINT DEFAULT 268435456,
    require_lag_watch BOOLEAN DEFAULT true,
    max_wait INTERVAL DEFAULT '15 minutes'
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
    ids INT[];
    batch INT[];
    i INT;
    touched INT;
BEGIN
    ids := ARRAY(
        SELECT DISTINCT mv."modelId"
          FROM "ModelVersion" mv
         WHERE mv."publishedAt" >= since
         ORDER BY 1);
    RAISE NOTICE 'rollback candidates: % models', coalesce(array_length(ids, 1), 0);
    PERFORM public.hot_rescore_wait_for_replicas(max_lag_bytes, max_wait, require_lag_watch);

    i := 1;
    WHILE i <= coalesce(array_length(ids, 1), 0) LOOP
        batch := ids[i:i + batch_size - 1];
        PERFORM public.hot_rescore_wait_for_replicas(max_lag_bytes, max_wait, require_lag_watch);
        PERFORM 1 FROM "ModelMetric" WHERE "modelId" = ANY (batch) ORDER BY "modelId" FOR UPDATE;
        PERFORM 1 FROM "ModelBaseModelMetric" WHERE "modelId" = ANY (batch)
          ORDER BY "modelId", "baseModel" FOR UPDATE;

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
        i := i + batch_size;
    END LOOP;
END
$procedure$;

CALL public.rescore_hot_version_head_start_rollback();

DROP PROCEDURE public.rescore_hot_version_head_start_rollback(TIMESTAMP, INT, BIGINT, BOOLEAN, INTERVAL);
DROP FUNCTION public.hot_rescore_wait_for_replicas(BIGINT, INTERVAL, BOOLEAN);

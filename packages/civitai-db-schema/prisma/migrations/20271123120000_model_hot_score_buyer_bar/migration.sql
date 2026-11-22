-- A paid version's buyers count toward the head-start bar like likes.
--
-- 20271121120000 gives a version a head start once its own likes + downloads / 6.4 >= 25. A paid
-- early-access version sells to few people, and a buyer is a stronger signal than a download, so
-- the bar becomes:
--
--   likes + greatest(downloads - buyers, 0) / 6.4 + buyers >= 25
--
--   buyers = distinct users holding a live paid purchase of the version: an "EntityAccess" row for
--            the version whose meta has a download- or generation-purchase transaction key (the
--            keys of EARLY_ACCESS_PURCHASES in model-version-access.service.ts; a new purchase kind
--            there must be added to the three copies below). Not the model's owner, and not a gift
--            or a moderator grant (no purchase key). A refund or a moderator revoke removes the key,
--            so it stops counting.
--
-- Each buyer counts as 1 in place of one download, so a buyer who also downloaded is not counted
-- twice; when buyers outnumber downloads (generation-only purchases), the download share is 0. The
-- bar never falls: a version with no buyers is scored exactly as before. Only the bar changes: the
-- version term a qualifying version earns is the 20271121120000 term.
--
-- 🔴 APPLY WITH psql -X -v ON_ERROR_STOP=1 AND WITHOUT --single-transaction: section 0 must stop the
-- file on refusal, and section 4 is a CALL whose procedure COMMITs per batch.
--
-- No application change ships with this: the formula lives only in these functions.

BEGIN;

-- 0. Preflight (as 20271121120000) --------------------------------------------

DO $preflight$
BEGIN
    IF coalesce(current_setting('hot_rescore.lag_watch', true), 'on') <> 'off'
       AND NOT EXISTS (SELECT 1 FROM pg_stat_replication WHERE replay_lsn IS NOT NULL) THEN
        RAISE EXCEPTION 'no replica lag visible to this role: run as a role with pg_monitor, or SET hot_rescore.lag_watch = off; and watch lag yourself';
    END IF;
END
$preflight$;

-- 1. The version term, with buyers ----------------------------------------------
--
-- A new argument, so a new overload: the 9-argument one is dropped below, once nothing calls it.

CREATE OR REPLACE FUNCTION public.hot_version_score(
    likes numeric,
    downloads numeric,
    generations numeric,
    unique_generators int,
    published_at timestamp,
    initial_published_at timestamp,
    model_likes numeric,
    model_downloads numeric,
    model_generations numeric,
    buyers numeric
)
RETURNS int
LANGUAGE sql
STABLE
-- One expression on purpose: a FROM clause stops the planner inlining it into the trigger's
-- version scan. The version's engagement is written out twice for that reason, and the caller
-- counts the buyers.
AS $function$
    SELECT CASE
        WHEN likes + greatest(downloads - buyers, 0) / 6.4 + buyers >= 25
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
--
-- The buyer count is read only for a version inside the 60-day window and still under the bar
-- without buyers (one-time filters: other versions cost nothing, and buyers can only raise the
-- bar, so a version over it already scores the same with 0). It goes through the "EntityAccess"
-- primary key (accessToId, accessToType, ...), and runs only where it can change the score.

CREATE OR REPLACE FUNCTION public.model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    best_version int;
    owner_id int;
BEGIN
    SELECT m."userId" INTO owner_id FROM "Model" m WHERE m.id = NEW."modelId";

    -- "ModelVersion_modelId_idx" (hash) serves the lookup; most models have 1-3 versions.
    SELECT max(public.hot_version_score(
               mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
               NEW."uniqueGeneratorCount", mv."publishedAt", mv."initialPublishedAt",
               NEW."thumbsUpCount", NEW."downloadCount", NEW."generationCount", b.buyers))
      INTO best_version
      FROM "ModelVersion" mv
      JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
      CROSS JOIN LATERAL (
          SELECT count(*) AS buyers
            FROM "EntityAccess" ea
           WHERE ea."accessToId" = mv.id
             AND ea."accessToType" = 'ModelVersion'
             AND ea."accessorType" = 'User'
             -- IS DISTINCT FROM: a NULL owner must not zero the count.
             AND ea."accessorId" IS DISTINCT FROM owner_id
             AND ea.meta ?| array['download-buzzTransactionId', 'generation-buzzTransactionId']
             AND mv."publishedAt" > NOW() - INTERVAL '60 days'
             AND mvm."thumbsUpCount" + mvm."downloadCount" / 6.4 < 25
      ) b
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

CREATE OR REPLACE FUNCTION public.base_model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    best_version int;
    owner_id int;
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

    SELECT m."userId" INTO owner_id FROM "Model" m WHERE m.id = NEW."modelId";

    SELECT max(public.hot_version_score(
               mvm."thumbsUpCount", mvm."downloadCount", mvm."generationCount",
               NEW."uniqueGeneratorCount", mv."publishedAt", mv."initialPublishedAt",
               NEW."thumbsUpCount", NEW."downloadCount", coalesce(NEW."generationCount", 0),
               b.buyers))
      INTO best_version
      FROM "ModelVersion" mv
      JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
      CROSS JOIN LATERAL (
          SELECT count(*) AS buyers
            FROM "EntityAccess" ea
           WHERE ea."accessToId" = mv.id
             AND ea."accessToType" = 'ModelVersion'
             AND ea."accessorType" = 'User'
             AND ea."accessorId" IS DISTINCT FROM owner_id
             AND ea.meta ?| array['download-buzzTransactionId', 'generation-buzzTransactionId']
             AND mv."publishedAt" > NOW() - INTERVAL '60 days'
             AND mvm."thumbsUpCount" + mvm."downloadCount" / 6.4 < 25
      ) b
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

-- Dropped, not kept: a leftover 9-argument overload would silently score without buyers.
-- IF EXISTS: re-running this file is how a stopped rescore resumes.
DROP FUNCTION IF EXISTS public.hot_version_score(
    numeric, numeric, numeric, int, timestamp, timestamp, numeric, numeric, numeric);

-- 4. Rescore the models buyers lift over the bar ------------------------------
--
-- Candidates: a version inside the window, not a re-date, under the old bar and over the new one.
-- Every one of them now earns a head start it did not have, so each candidate's rows are rewritten
-- outright (a re-run rewrites them again, which is correct). Measured slices are written here;
-- unmeasured ones follow their ModelMetric row through trg_model_metric_hot_score_mirror
-- (20271122120000). Lag watch and batching as 20271121120000.

CREATE OR REPLACE PROCEDURE public.rescore_hot_version_buyer_bar(
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
          JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
          JOIN "Model" m ON m.id = mv."modelId"
          CROSS JOIN LATERAL (
              SELECT count(*) AS buyers
                FROM "EntityAccess" ea
               WHERE ea."accessToId" = mv.id
                 AND ea."accessToType" = 'ModelVersion'
                 AND ea."accessorType" = 'User'
                 AND ea."accessorId" IS DISTINCT FROM m."userId"
                 AND ea.meta ?| array['download-buzzTransactionId', 'generation-buzzTransactionId']
          ) b
         WHERE mv.status = 'Published'
           AND mv."publishedAt" > NOW() - INTERVAL '60 days'
           AND mv."publishedAt" < coalesce(mv."initialPublishedAt", mv."publishedAt") + INTERVAL '1 day'
           AND mvm."thumbsUpCount" + mvm."downloadCount" / 6.4 < 25
           AND mvm."thumbsUpCount" + greatest(mvm."downloadCount" - b.buyers, 0) / 6.4 + b.buyers >= 25
         ORDER BY 1);
    RAISE NOTICE 'buyer bar candidates: % models', coalesce(array_length(ids, 1), 0);

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

CALL public.rescore_hot_version_buyer_bar();

DROP PROCEDURE public.rescore_hot_version_buyer_bar(INT, BIGINT, INTERVAL);

-- A paid version's buyer counts toward the head-start bar by what they paid, on a log curve capped
-- at 3, in place of 1 each (20271123120000):
--
--   likes + greatest(downloads - buyers, 0) / 6.4 + sum(buyer weight) >= 25
--   buyer weight = least(1 + log2(greatest(price, 100) / 100) / 3, 3)
--                  100 Buzz or less = 1, 800 = 2, 6,400 and up = 3
--
-- The buyers, and who is not one (the owner, gifts, moderator grants, refunds), are 20271123120000's.
-- A buyer still replaces one download each, and a buyer holding both purchases counts once, at the
-- dearer one. The weight only raises the bar (it is >= 1), and only the bar changes.
--
-- The price is the amount charged, which the purchase records on the grant from this release on
-- ("<kind>-amount" and "<kind>-buzzType", the keys of EARLY_ACCESS_PURCHASES in model-version-access.service.ts). The Buzz
-- ledger is not in this database, so for a purchase recorded before that the price is the gate's
-- current price for that kind ("PaidAccess".terms), read through its primary key.
--
-- A Blue Buzz purchase counts 1 at any price: Blue is granted by rewards, so pricing it would let
-- farmed credit buy weight. An older purchase on a gate that accepts Blue counts 1 too, since its
-- currency was not recorded. Anything unreadable counts 1, never an error in the metrics write.
--
-- 🔴 APPLY WITH psql -X -v ON_ERROR_STOP=1 AND WITHOUT --single-transaction: section 0 must stop the
-- file on refusal, and section 5 is a CALL whose procedure COMMITs per batch. Deploy the app first:
-- applied before it, only older purchases are weighed, by the gate's price, until it ships.
--
-- The formula lives only in these functions; the app change is only the recorded amount and currency.

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

-- 1. One buyer's weight -------------------------------------------------------
--
-- Single expressions with no FROM, so the planner can inline them into the triggers' buyer count.
-- Every cast is guarded by jsonb_typeof: these run inside the metrics write.

CREATE OR REPLACE FUNCTION public.hot_price_weight(price numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $function$
    SELECT CASE
        WHEN price IS NULL THEN 1
        ELSE least(1 + log(2, greatest(price, 100) / 100) / 3, 3)
    END
$function$;

-- The price one purchase kind was bought at, or NULL for "count 1".
CREATE OR REPLACE FUNCTION public.hot_purchase_price(
    amount jsonb,
    buzz_type jsonb,
    list_price jsonb,
    accepts_blue jsonb
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $function$
    SELECT CASE
        WHEN buzz_type IS NOT NULL THEN
            CASE
                WHEN buzz_type = '"blue"'::jsonb THEN NULL
                WHEN jsonb_typeof(amount) = 'number' THEN (amount #>> '{}')::numeric
            END
        WHEN accepts_blue = 'true'::jsonb THEN NULL
        WHEN jsonb_typeof(list_price) = 'number' THEN (list_price #>> '{}')::numeric
    END
$function$;

-- A generation price falls back to the download price, as generationPrice() in
-- packages/civitai-buzz/src/paid-access.ts; a free generation grant has no price.
CREATE OR REPLACE FUNCTION public.hot_buyer_weight(meta jsonb, terms jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $function$
    SELECT greatest(
        CASE WHEN meta ? 'download-buzzTransactionId' THEN public.hot_price_weight(
            public.hot_purchase_price(
                meta -> 'download-amount', meta -> 'download-buzzType',
                terms #> '{download,price}', terms -> 'acceptsBlueBuzz'))
        END,
        CASE WHEN meta ? 'generation-buzzTransactionId' THEN public.hot_price_weight(
            public.hot_purchase_price(
                meta -> 'generation-amount', meta -> 'generation-buzzType',
                CASE
                    WHEN jsonb_typeof(terms -> 'generation') = 'object'
                         AND NOT (terms -> 'generation') ? 'free'
                    THEN coalesce(terms #> '{generation,price}', terms #> '{download,price}')
                END,
                terms -> 'acceptsBlueBuzz'))
        END,
        -- Neither key: not a buyer, and the callers never pass one. 1 keeps the sum honest anyway.
        1)
$function$;

-- 2. The version term, with weighed buyers -------------------------------------
--
-- A new argument, so a new overload: the 10-argument one is dropped below, once nothing calls it.

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
    buyers numeric,
    buyer_weight numeric
)
RETURNS int
LANGUAGE sql
STABLE
-- One expression on purpose: a FROM clause stops the planner inlining it into the trigger's
-- version scan. The version's engagement is written out twice for that reason, and the caller
-- counts and weighs the buyers.
AS $function$
    SELECT CASE
        WHEN likes + greatest(downloads - buyers, 0) / 6.4 + buyer_weight >= 25
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

-- 3. The whole-model score ----------------------------------------------------
--
-- As 20271123120000, with each buyer weighed. The gate is one "PaidAccess" primary-key lookup per
-- buyer row, for a version inside the window and under the bar without buyers only.

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
               NEW."thumbsUpCount", NEW."downloadCount", NEW."generationCount", b.buyers, b.weight))
      INTO best_version
      FROM "ModelVersion" mv
      JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
      CROSS JOIN LATERAL (
          SELECT count(*) AS buyers,
                 coalesce(sum(public.hot_buyer_weight(ea.meta, pa.terms)), 0) AS weight
            FROM "EntityAccess" ea
            LEFT JOIN "PaidAccess" pa
              ON pa."entityType" = 'ModelVersion' AND pa."entityId" = ea."accessToId"
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

-- 4. The per-base-model score -------------------------------------------------

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
               b.buyers, b.weight))
      INTO best_version
      FROM "ModelVersion" mv
      JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = mv.id
      CROSS JOIN LATERAL (
          SELECT count(*) AS buyers,
                 coalesce(sum(public.hot_buyer_weight(ea.meta, pa.terms)), 0) AS weight
            FROM "EntityAccess" ea
            LEFT JOIN "PaidAccess" pa
              ON pa."entityType" = 'ModelVersion' AND pa."entityId" = ea."accessToId"
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

-- Dropped, not kept: a leftover 10-argument overload would silently count each buyer as 1.
-- IF EXISTS: re-running this file is how a stopped rescore resumes.
DROP FUNCTION IF EXISTS public.hot_version_score(
    numeric, numeric, numeric, int, timestamp, timestamp, numeric, numeric, numeric, numeric);

-- 5. Rescore the models the weights lift over the bar --------------------------
--
-- Candidates: a version inside the window, not a re-date, under 20271123120000's bar and over this
-- one. Every one of them now earns a head start it did not have, so each candidate's rows are
-- rewritten outright. Measured slices are written here; unmeasured ones follow their ModelMetric row
-- through trg_model_metric_hot_score_mirror (20271122120000). Lag watch and batching as before.

CREATE OR REPLACE PROCEDURE public.rescore_hot_version_price_weight(
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
              SELECT count(*) AS buyers,
                     coalesce(sum(public.hot_buyer_weight(ea.meta, pa.terms)), 0) AS weight
                FROM "EntityAccess" ea
                LEFT JOIN "PaidAccess" pa
                  ON pa."entityType" = 'ModelVersion' AND pa."entityId" = ea."accessToId"
               WHERE ea."accessToId" = mv.id
                 AND ea."accessToType" = 'ModelVersion'
                 AND ea."accessorType" = 'User'
                 AND ea."accessorId" IS DISTINCT FROM m."userId"
                 AND ea.meta ?| array['download-buzzTransactionId', 'generation-buzzTransactionId']
          ) b
         WHERE mv.status = 'Published'
           AND mv."publishedAt" > NOW() - INTERVAL '60 days'
           AND mv."publishedAt" < coalesce(mv."initialPublishedAt", mv."publishedAt") + INTERVAL '1 day'
           AND mvm."thumbsUpCount" + greatest(mvm."downloadCount" - b.buyers, 0) / 6.4 + b.buyers < 25
           AND mvm."thumbsUpCount" + greatest(mvm."downloadCount" - b.buyers, 0) / 6.4 + b.weight >= 25
         ORDER BY 1);
    RAISE NOTICE 'price weight candidates: % models', coalesce(array_length(ids, 1), 0);

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

CALL public.rescore_hot_version_price_weight();

DROP PROCEDURE public.rescore_hot_version_price_weight(INT, BIGINT, INTERVAL);

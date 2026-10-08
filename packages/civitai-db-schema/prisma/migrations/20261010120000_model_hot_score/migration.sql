-- Hot sort for the model feed: a stored popularity score that favours newer models.
--
--   engagement = thumbsUpCount + downloadCount / 6.4 + generationCount / 4.1
--   hotScore   = round((log10(1 + engagement) + publishedAt_epoch / 2592000) * 10000)
--
-- The time term is the PUBLISH date, not the age, so the passage of time adds the same
-- amount to every model and nobody's ranking moves. A score only changes when its
-- engagement changes, which is why this needs no scheduled job.
--
-- 🔴 APPLY THIS FILE BEFORE DEPLOYING THE CODE, and apply it WITHOUT
-- --single-transaction: it contains CALL with internal COMMITs and two
-- CREATE INDEX CONCURRENTLY, neither of which can run inside a transaction block.
--
-- 🔴 DO NOT RE-RUN THIS FILE ONCE 20261011120000 IS APPLIED. It redefines
-- model_metric_hot_score() and its trigger WITHOUT the generation cap, and its backfill
-- defaults to force := true, so it would rescore every row uncapped and drop
-- "uniqueGeneratorCount" from the trigger's UPDATE OF list. If you must re-run it,
-- apply 20261011120000 again afterwards.
--
-- On its own it is re-runnable: every object is CREATE OR REPLACE or IF NOT EXISTS.
-- Pass force := false only to resume an interrupted first run.
-- Prisma selects explicit column lists, so a client that predates the columns ignores
-- them, and getModelsRaw is raw SQL that never does SELECT *.
--
-- Three properties that are load-bearing, each one a trap we hit on dev:
--
--   1. hotScore is NEVER NULL. `ORDER BY "hotScore" DESC` puts NULLs FIRST, so one NULL
--      would outrank every model on the site. `DESC NULLS LAST` is not an escape: it
--      cannot use a DESC index, and the planner falls back to a full sort.
--   2. A future publishedAt is clamped to now(). Without it a scheduled publish outranks
--      everything until its date arrives — the same failure the lastVersionAt guard in
--      20260501135000_tighten_sync_model_to_metric exists for.
--   3. The score is computed in the DATABASE, not the app. No application version can
--      skip it, which is what makes this file safe to apply before the deploy.

-- 1. Columns ------------------------------------------------------------------

ALTER TABLE "ModelMetric"
  ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "hotScore" INTEGER;

-- Mirrored, not recomputed: the same model-level score, so the base-model feed can be
-- served by a (baseModel, hotScore) index the way mbmm_feed_highest_rated serves
-- Highest Rated. Without this, a base-model-filtered Hot query drives from ModelMetric
-- and walks the index hunting for matches, which costs most for a mid-sized base model
-- (docs/model-feed-hot-ranking.md §10 has the measurements).
ALTER TABLE "ModelBaseModelMetric"
  ADD COLUMN IF NOT EXISTS "hotScore" INTEGER;

-- 2. The score ----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW."hotScore" := round(
        (
            -- 6.4 and 4.1 are the MEDIAN per-model ratios of downloads and generations to
            -- likes, NOT the site-wide SUM ratios: generations concentrate in a few
            -- checkpoints, which skews a sum badly. Derivation: docs/model-feed-hot-ranking.md §13.
            log(
                1
                + NEW."thumbsUpCount"
                + NEW."downloadCount" / 6.4
                + NEW."generationCount" / 4.1
            )
            -- least(..., NOW()) is guard 2. The coalesce is guard 1, and it falls back to
            -- the epoch rather than NOW(): a row with no publish date is unpublished or
            -- orphaned, and "unknown" must sort LAST, not first. Falling back to NOW()
            -- would hand every such row the freshest possible time term.
            + extract(epoch FROM least(coalesce(NEW."publishedAt", TIMESTAMP 'epoch'), NOW())) / 2592000
        ) * 10000
    )::int;

    RETURN NEW;
END
$function$;

CREATE OR REPLACE TRIGGER trg_model_metric_hot_score
    BEFORE INSERT OR UPDATE OF "thumbsUpCount", "downloadCount", "generationCount", "publishedAt"
    ON "ModelMetric"
    FOR EACH ROW
    EXECUTE FUNCTION public.model_metric_hot_score();

-- 3. Mirror the score onto ModelBaseModelMetric -------------------------------

CREATE OR REPLACE FUNCTION public.model_metric_hot_score_fanout()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    UPDATE "ModelBaseModelMetric"
       SET "hotScore" = NEW."hotScore"
     WHERE "modelId" = NEW."modelId"
       AND "hotScore" IS DISTINCT FROM NEW."hotScore";

    RETURN NULL;
END
$function$;

CREATE OR REPLACE TRIGGER trg_model_metric_hot_score_fanout
    AFTER UPDATE OF "hotScore" ON "ModelMetric"
    FOR EACH ROW
    WHEN (OLD."hotScore" IS DISTINCT FROM NEW."hotScore")
    EXECUTE FUNCTION public.model_metric_hot_score_fanout();

-- The fan-out above only reaches rows that already exist. basemodel.metrics.ts inserts
-- ModelBaseModelMetric rows with an explicit column list that omits "hotScore", and its
-- ON CONFLICT sets only the counts — so a model gaining a base model would get a NULL
-- score and (per trap 1) land at the TOP of that base model's feed. This pulls the
-- score in on insert. Scoped to NULL so the metrics job's row updates don't pay for a
-- lookup they don't need.
CREATE OR REPLACE FUNCTION public.base_model_metric_hot_score()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."hotScore" IS NULL THEN
        -- coalesce to 0, not NULL: some rows reference a modelId with no ModelMetric row
        -- at all, and a NULL would put those at the TOP of that base model's feed.
        SELECT coalesce(mm."hotScore", 0) INTO NEW."hotScore"
          FROM "ModelMetric" mm
         WHERE mm."modelId" = NEW."modelId";
        NEW."hotScore" := coalesce(NEW."hotScore", 0);
    END IF;

    RETURN NEW;
END
$function$;

CREATE OR REPLACE TRIGGER trg_base_model_metric_hot_score
    BEFORE INSERT OR UPDATE ON "ModelBaseModelMetric"
    FOR EACH ROW
    EXECUTE FUNCTION public.base_model_metric_hot_score();

-- 4. Carry publishedAt into ModelMetric ---------------------------------------
--
-- Same shape as the existing lastVersionAt handling in
-- 20260501135000_tighten_sync_model_to_metric, with "publishedAt" added to both branches.
-- coalesce(publishedAt, createdAt) so a model that has never published still gets a
-- score (trap 1) rather than a NULL; the clamp in model_metric_hot_score() handles a
-- future date, so no CASE is needed here.

CREATE OR REPLACE FUNCTION public.sync_model_to_metric()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO "ModelMetric" (
            "modelId",
            "downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount",
            "collectedCount", "imageCount",
            "tippedAmountCount", "tippedCount", "generationCount", "updatedAt",
            "status", "availability", "mode", "nsfwLevel", "minor", "poi", "userId", "lastVersionAt",
            "publishedAt"
        )
        VALUES (
            NEW.id,
            0, 0, 0, 0,
            0, 0,
            0, 0, 0, NOW(),
            NEW."status", NEW."availability", NEW."mode", NEW."nsfwLevel", NEW."minor", NEW."poi", NEW."userId",
            CASE
                WHEN NEW."lastVersionAt" IS NULL OR NEW."lastVersionAt" <= NOW()
                THEN NEW."lastVersionAt"
                ELSE NULL
            END,
            coalesce(NEW."publishedAt", NEW."createdAt")
        )
        ON CONFLICT ("modelId") DO UPDATE
        SET
            "status"        = EXCLUDED."status",
            "availability"  = EXCLUDED."availability",
            "mode"          = EXCLUDED."mode",
            "nsfwLevel"     = EXCLUDED."nsfwLevel",
            "minor"         = EXCLUDED."minor",
            "poi"           = EXCLUDED."poi",
            "userId"        = EXCLUDED."userId",
            "lastVersionAt" = CASE
                WHEN EXCLUDED."lastVersionAt" IS NULL OR EXCLUDED."lastVersionAt" <= NOW()
                THEN EXCLUDED."lastVersionAt"
                ELSE "ModelMetric"."lastVersionAt"
            END,
            "publishedAt"   = EXCLUDED."publishedAt";

        RETURN NEW;
    END IF;

    IF (TG_OP = 'UPDATE') THEN
        INSERT INTO "ModelMetric" (
            "modelId",
            "downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount",
            "collectedCount", "imageCount",
            "tippedAmountCount", "tippedCount", "generationCount", "updatedAt",
            "status", "availability", "mode", "nsfwLevel", "minor", "poi", "userId", "lastVersionAt",
            "publishedAt"
        )
        VALUES (
            NEW.id,
            0, 0, 0, 0,
            0, 0,
            0, 0, 0, NOW(),
            NEW."status", NEW."availability", NEW."mode", NEW."nsfwLevel", NEW."minor", NEW."poi", NEW."userId",
            CASE
                WHEN NEW."lastVersionAt" IS NULL OR NEW."lastVersionAt" <= NOW()
                THEN NEW."lastVersionAt"
                ELSE NULL
            END,
            coalesce(NEW."publishedAt", NEW."createdAt")
        )
        ON CONFLICT ("modelId") DO UPDATE
        SET
            "status"        = EXCLUDED."status",
            "availability"  = EXCLUDED."availability",
            "mode"          = EXCLUDED."mode",
            "nsfwLevel"     = EXCLUDED."nsfwLevel",
            "minor"         = EXCLUDED."minor",
            "poi"           = EXCLUDED."poi",
            "userId"        = EXCLUDED."userId",
            "lastVersionAt" = CASE
                WHEN EXCLUDED."lastVersionAt" IS NULL OR EXCLUDED."lastVersionAt" <= NOW()
                THEN EXCLUDED."lastVersionAt"
                ELSE "ModelMetric"."lastVersionAt"
            END,
            "publishedAt"   = EXCLUDED."publishedAt";

        RETURN NEW;
    END IF;

    RETURN NEW;
END
$function$;

-- 5. Backfill -----------------------------------------------------------------
--
-- A procedure rather than one UPDATE: a single statement over every row holds row locks
-- and a snapshot throughout. Batched by modelId with a COMMIT per batch, so the metrics
-- job keeps writing.
--
-- Only "publishedAt" is assigned — trg_model_metric_hot_score computes the score from it.

CREATE OR REPLACE PROCEDURE public.backfill_model_hot_score(batch_size INT DEFAULT 250000,
                                                            force BOOLEAN DEFAULT true)
LANGUAGE plpgsql
AS $procedure$
DECLARE
    lo INT := 0;
    hi INT;
    touched INT;
BEGIN
    SELECT max("modelId") INTO hi FROM "ModelMetric";
    IF hi IS NULL THEN RETURN; END IF;

    WHILE lo <= hi LOOP
        -- A correlated subquery, NOT `FROM "Model" m WHERE m.id = mm."modelId"`: the join
        -- form skips any ModelMetric row whose Model is gone, so the
        -- UPDATE never fires and the BEFORE trigger never computes their score, leaving a
        -- NULL that sorts FIRST. Every row in range has to be touched.
        UPDATE "ModelMetric" mm
           SET "publishedAt" = (
                   SELECT coalesce(m."publishedAt", m."createdAt")
                     FROM "Model" m
                    WHERE m.id = mm."modelId"
               )
         WHERE mm."modelId" >= lo
           AND mm."modelId" < lo + batch_size
           AND (
                force
             OR mm."hotScore" IS NULL
             OR mm."publishedAt" IS DISTINCT FROM (
                    SELECT coalesce(m."publishedAt", m."createdAt")
                      FROM "Model" m
                     WHERE m.id = mm."modelId"
                )
           );
        GET DIAGNOSTICS touched = ROW_COUNT;
        COMMIT;
        RAISE NOTICE 'ModelMetric ids %-%: % rows', lo, lo + batch_size, touched;
        lo := lo + batch_size;
    END LOOP;

    lo := 0;
    WHILE lo <= hi LOOP
        -- Same reason, plus the coalesce: orphaned modelIds must land at 0, not NULL.
        UPDATE "ModelBaseModelMetric" mbm
           SET "hotScore" = coalesce(
                   (SELECT mm."hotScore" FROM "ModelMetric" mm WHERE mm."modelId" = mbm."modelId"),
                   0
               )
         WHERE mbm."modelId" >= lo
           AND mbm."modelId" < lo + batch_size
           AND mbm."hotScore" IS DISTINCT FROM coalesce(
                   (SELECT mm."hotScore" FROM "ModelMetric" mm WHERE mm."modelId" = mbm."modelId"),
                   0
               );
        GET DIAGNOSTICS touched = ROW_COUNT;
        COMMIT;
        RAISE NOTICE 'ModelBaseModelMetric ids %-%: % rows', lo, lo + batch_size, touched;
        lo := lo + batch_size;
    END LOOP;
END
$procedure$;

CALL public.backfill_model_hot_score();

DROP PROCEDURE public.backfill_model_hot_score(INT, BOOLEAN);

-- 6. Indexes ------------------------------------------------------------------
--
-- Both DESC with no NULLS LAST: the score cannot be NULL (trap 1), and a NULLS LAST
-- ordering could not use these.
--
-- INCLUDE carries the feed's filter columns so the scan stays index-only, which is worth
-- far more than the extra size (docs/model-feed-hot-ranking.md §10 compares both).
--
-- 🔴 CREATE INDEX CONCURRENTLY waits for in-flight transactions to finish, so a session
-- lock_timeout will kill it on a busy table. A killed CONCURRENTLY build leaves behind
-- an INVALID index — and
-- `IF NOT EXISTS` then treats that corpse as "already there" and silently does nothing,
-- so the feed would ship with no index and nobody would see an error. The DO block below
-- clears an invalid leftover first; keep it if you have to re-run this section.

-- The DROP below deliberately keeps the session's normal lock_timeout: it takes an
-- ACCESS EXCLUSIVE lock, and waiting forever for that on a live feed table is worse
-- than failing and retrying. Only the CONCURRENTLY builds get an unlimited timeout.
DO $drop_invalid$
DECLARE
    dead text;
BEGIN
    FOR dead IN
        SELECT i.indexrelid::regclass::text
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indrelid
         WHERE c.relname IN ('ModelMetric', 'ModelBaseModelMetric')
           AND i.indexrelid::regclass::text IN ('feed_hot', 'mbmm_feed_hot')
           AND NOT i.indisvalid
    LOOP
        RAISE NOTICE 'dropping invalid index % left by an interrupted build', dead;
        EXECUTE format('DROP INDEX %s', dead);
    END LOOP;
END
$drop_invalid$;

-- Both timeouts, not just lock_timeout. CONCURRENTLY waits for every transaction that
-- was open when it started, so on a busy database the statement outlives a
-- statement_timeout even when it holds no lock, with one long-running query enough to
-- outlast it.
--
-- 🔴 Before running these two, check for long transactions:
--   SELECT pid, state, now() - xact_start AS age, left(query, 80)
--     FROM pg_stat_activity
--    WHERE datname = current_database() AND xact_start IS NOT NULL
--    ORDER BY xact_start;
-- The build will wait for the oldest one to finish. It is safe to let it wait (it takes
-- no exclusive lock), but it is worth knowing before watching a terminal.
SET lock_timeout = 0;
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "feed_hot"
    ON "ModelMetric" ("hotScore" DESC, "modelId")
    INCLUDE (status, availability, mode, "nsfwLevel", poi, minor, "userId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "mbmm_feed_hot"
    ON "ModelBaseModelMetric" ("baseModel", "hotScore" DESC, "modelId")
    INCLUDE (status, availability, "nsfwLevel", mode, poi, minor);

RESET lock_timeout;
RESET statement_timeout;

-- 7. Vacuum ---------------------------------------------------------------------
--
-- The backfill rewrote most of the table, which leaves the visibility map stale — and until a
-- vacuum clears it, an index-only scan still visits the heap, which is the entire reason
-- the indexes above carry INCLUDE columns. Autovacuum gets there on its own (the scale
-- factor is well below a rewrite this size), so this only makes it immediate.
--
-- Plain VACUUM, never VACUUM FULL: this takes SHARE UPDATE EXCLUSIVE, which does not block
-- SELECT/INSERT/UPDATE/DELETE. It DOES conflict with other maintenance on the same table,
-- including CREATE INDEX CONCURRENTLY — hence after the builds above, not beside them.
--
-- vacuum_cost_delay is 0 for manual vacuums on this cluster, i.e. unthrottled. Matching
-- autovacuum's 2ms trades a longer run for a smaller I/O burst; drop the SET if you would
-- rather it finish quickly.
SET vacuum_cost_delay = '2ms';

VACUUM (ANALYZE) "ModelMetric";
VACUUM (ANALYZE) "ModelBaseModelMetric";

RESET vacuum_cost_delay;

-- Verification (expect: 0, 0, and a max_future below max_published)
--
--   SELECT count(*) FILTER (WHERE "hotScore" IS NULL)  AS null_score,
--          count(*) FILTER (WHERE "publishedAt" IS NULL) AS null_published,
--          max("hotScore") FILTER (WHERE "publishedAt" >  NOW()) AS max_future,
--          max("hotScore") FILTER (WHERE "publishedAt" <= NOW()) AS max_published
--     FROM "ModelMetric";
--
--   SELECT count(*) FILTER (WHERE "hotScore" IS NULL) AS null_score
--     FROM "ModelBaseModelMetric";

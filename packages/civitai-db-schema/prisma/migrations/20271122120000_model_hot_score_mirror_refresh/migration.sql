-- A mirrored slice follows its model's Hot score whenever that score moves.
--
-- A "ModelBaseModelMetric" row with NULL "uniqueGeneratorCount" has not been measured, and
-- trg_base_model_metric_hot_score (20261012120000) gives it a copy of "ModelMetric"."hotScore".
-- It copies only when the slice row itself is written, and the base-model metrics job writes a
-- slice only for models in its own update set. The model's score also moves when nothing writes
-- the slice: version credit (20271117190000) and the head start (20271121120000) move it on a
-- version publish or on version metrics. The mirror then sits on an older, usually lower score,
-- and the single-base-model Hot feed sorts on it.
--
-- So the push side comes back, on ModelMetric, written to fire this time:
--
--   * 20261010120000's fan-out was AFTER UPDATE OF "hotScore", which never fired: UPDATE OF
--     matches the statement's SET list, and nothing SETs "hotScore", the BEFORE trigger computes
--     it. This one is AFTER UPDATE with no column list, and the WHEN compares the stored values.
--   * It writes only unmeasured slices. A measured slice computes its own score, and a push from
--     the whole-model score is what 20261012120000 dropped the fan-out to stop.
--   * DEFERRED to commit, and SKIP LOCKED. Slices are locked by the base-model job's batched
--     upserts and by Model's sync trigger (scheduled publishing changes several models in one
--     transaction). Locking mirrors mid-transaction, then waiting on another slice later in the
--     same transaction, could close a deadlock cycle with a job batch. At commit only other deferred
--     triggers follow, and SKIP LOCKED never waits, so these locks are taken after the
--     transaction's own waits. A skipped mirror is
--     locked by another open transaction; it catches up on its next write or the model's next
--     score move.
--
-- Apply with psql -X -v ON_ERROR_STOP=1, without --single-transaction. The triggers are replaced
-- in their own short transaction: DROP TRIGGER locks ModelMetric ACCESS EXCLUSIVE (readers queue
-- behind it, for at most the 5s lock timeout), and a wider wrap would hold that lock through the
-- catch-up. A timeout rolls the replacement back, leaving the old triggers in place: retry.
--
-- No application change ships with this.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.model_metric_hot_score_mirror()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- Setting "hotScore" makes trg_base_model_metric_hot_score fire, and its NULL branch copies
    -- ModelMetric's score as it stands at commit, so there is one formula, not two.
    UPDATE "ModelBaseModelMetric" bm
       SET "hotScore" = coalesce(NEW."hotScore", 0)
     WHERE (bm."modelId", bm."baseModel") IN (
               SELECT s."modelId", s."baseModel"
                 FROM "ModelBaseModelMetric" s
                WHERE s."modelId" = NEW."modelId"
                  AND s."uniqueGeneratorCount" IS NULL
                  AND s."hotScore" IS DISTINCT FROM coalesce(NEW."hotScore", 0)
                  FOR UPDATE SKIP LOCKED);
    RETURN NULL;
END
$function$;

DROP TRIGGER IF EXISTS trg_model_metric_hot_score_mirror ON "ModelMetric";
CREATE CONSTRAINT TRIGGER trg_model_metric_hot_score_mirror
    AFTER UPDATE ON "ModelMetric"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    WHEN (OLD."hotScore" IS DISTINCT FROM NEW."hotScore")
    EXECUTE FUNCTION public.model_metric_hot_score_mirror();

-- A slice the base-model job wrote before the model's first ModelMetric row mirrored 0.
DROP TRIGGER IF EXISTS trg_model_metric_hot_score_mirror_insert ON "ModelMetric";
CREATE CONSTRAINT TRIGGER trg_model_metric_hot_score_mirror_insert
    AFTER INSERT ON "ModelMetric"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.model_metric_hot_score_mirror();

COMMIT;

-- Catch up the mirrors already behind, in one statement (the PR body has the measured count).
-- Assigning "uniqueGeneratorCount" to itself makes UPDATE OF fire and recompute the copy. SKIP
-- LOCKED, so it never waits on the metrics job; a re-run of the file picks up what it skipped.
UPDATE "ModelBaseModelMetric" bm
   SET "uniqueGeneratorCount" = bm."uniqueGeneratorCount"
 WHERE (bm."modelId", bm."baseModel") IN (
           SELECT s."modelId", s."baseModel"
             FROM "ModelBaseModelMetric" s
            WHERE s."uniqueGeneratorCount" IS NULL
              AND s."hotScore" IS DISTINCT FROM coalesce(
                      (SELECT mm."hotScore" FROM "ModelMetric" mm WHERE mm."modelId" = s."modelId"),
                      0
                  )
              FOR UPDATE SKIP LOCKED);

-- Verification, on a replica, straight after and again an hour or more later; both should read in
-- single digits (a skipped lock or a row mid-write can leave a few):
--
--   SELECT count(*)
--     FROM "ModelBaseModelMetric" bm
--     JOIN "ModelMetric" mm USING ("modelId")
--    WHERE bm."uniqueGeneratorCount" IS NULL
--      AND bm."hotScore" IS DISTINCT FROM mm."hotScore";

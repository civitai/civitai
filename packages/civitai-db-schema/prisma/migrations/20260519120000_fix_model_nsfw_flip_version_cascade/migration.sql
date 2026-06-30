-- Fix stale ModelVersion.nsfwLevel after Model.nsfw flips true->false.
--
-- Background:
--   When Model.nsfw = true, updateModelVersionNsfwLevels stamps every
--   ModelVersion.nsfwLevel to nsfwBrowsingLevelsFlag (60 = R|X|XXX|Blocked).
--   The old trigger only enqueued a Model-level UpdateNsfwLevel job on
--   nsfw flip, so when nsfw flipped back to false:
--     - Model rollup runs updateModelNsfwLevels.
--     - bit_or(mv.nsfwLevel) over (still-stale) versions = 60.
--     - ELSE branch writes 60. WHERE clause finds no diff. Model frozen.
--     - Versions never recompute -> Model.nsfwLevel & 32 stays set,
--       model is hidden from .com search even though images are PG/PG-13.
--
-- Fix:
--   When Model.nsfw is distinct from its previous value, enqueue a
--   ModelVersion UpdateNsfwLevel job for every Published version under
--   the model. The update-nsfw-levels cron processes versions before
--   models in the same tick (see updateNsfwLevels batch order in
--   src/server/services/nsfwLevels.service.ts), so version rollups land
--   fresh before the model rollup reads them.
--
-- Also swap the existing `NEW."nsfw" != OLD."nsfw"` check to
-- IS DISTINCT FROM for NULL-safe comparison.

CREATE OR REPLACE FUNCTION update_model_nsfw_level()
RETURNS TRIGGER AS $model_nsfw_level$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When a model is deleted, schedule removal of FKs (collectionItems)
    PERFORM create_job_queue_record(OLD.id, 'Model', 'CleanUp');
  -- On model publish, create a job to update the nsfw level of the related entities (collectionItems)
  ELSIF ((NEW.status = 'Published' AND OLD.status != 'Published')
         OR (NEW."nsfw" IS DISTINCT FROM OLD."nsfw" AND NEW.status = 'Published')) THEN
    PERFORM create_job_queue_record(OLD."id", 'Model', 'UpdateNsfwLevel');
    -- When Model.nsfw flips, the rollup that stamps every version to
    -- nsfwBrowsingLevelsFlag (60) is stale: a true->false transition
    -- leaves versions at 60, so bit_or of versions = 60 and the Model
    -- rollup short-circuits at 60 forever. Enqueue version recomputes
    -- so the next cron tick recomputes from actual image data first,
    -- then re-rolls up to Model (batch order in updateNsfwLevels
    -- processes versions before models in the same run).
    IF NEW."nsfw" IS DISTINCT FROM OLD."nsfw" THEN
      INSERT INTO "JobQueue" ("entityId", "entityType", "type")
      SELECT mv.id, 'ModelVersion'::"EntityType", 'UpdateNsfwLevel'::"JobQueueType"
      FROM "ModelVersion" mv
      WHERE mv."modelId" = NEW.id AND mv.status = 'Published'
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NULL;
END;
$model_nsfw_level$ LANGUAGE plpgsql;

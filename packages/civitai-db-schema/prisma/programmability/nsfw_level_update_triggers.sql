-- A function to queue a job
CREATE OR REPLACE FUNCTION create_job_queue_record(entityId INTEGER, entityType text, type text)
RETURNS VOID AS $job_queue_record$
BEGIN
  INSERT INTO "JobQueue" ("entityId", "entityType", "type")
  VALUES (entityId, entityType::"EntityType", type::"JobQueueType")
  ON CONFLICT DO NOTHING;
END;
$job_queue_record$ LANGUAGE plpgsql;
---

-- IMAGE TRIGGER
CREATE OR REPLACE FUNCTION update_image_nsfw_level()
RETURNS TRIGGER AS $image_nsfw_level$
BEGIN
  -- On image delete
  IF (TG_OP = 'DELETE') THEN

    -- If the image has an nsfw level, create a job to update the nsfw level of the post
    IF (OLD."postId" IS NOT NULL AND OLD."nsfwLevel" != 0) THEN
      PERFORM create_job_queue_record(OLD."postId", 'Post', 'UpdateNsfwLevel');
    END IF;

    IF (OLD."postId" IS NOT NULL) THEN
      PERFORM create_job_queue_record(OLD."postId", 'Post', 'CleanIfEmpty');
    END IF;

    -- Create a job to clean up the FKs of the image
    PERFORM create_job_queue_record(OLD.id, 'Image', 'CleanUp');

  -- On change nsfw level, create a job to update the nsfw level of related entities (imageConnections, collectionItems, articles)
  ELSIF (NEW."nsfwLevel" != OLD."nsfwLevel") THEN
    PERFORM create_job_queue_record(NEW.id, 'Image', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$image_nsfw_level$ LANGUAGE plpgsql;
---
-- setup image trigger
CREATE OR REPLACE TRIGGER image_nsfw_level_change
AFTER UPDATE OF "nsfwLevel" OR DELETE ON "Image"
FOR EACH ROW
EXECUTE FUNCTION update_image_nsfw_level();


-- POST TRIGGER
CREATE OR REPLACE FUNCTION update_post_nsfw_level()
RETURNS TRIGGER AS $post_nsfw_level$
BEGIN
  IF (TG_OP = 'DELETE') THEN

    -- If the post has a model version, create a job to update the nsfw level of the model version
    IF (OLD."modelVersionId" IS NOT NULL AND OLD."publishedAt" IS NOT NULL) THEN
      PERFORM create_job_queue_record(OLD."modelVersionId", 'ModelVersion', 'UpdateNsfwLevel');
    END IF;

    -- Create a job to clean up the FKs of the post (collectionItems)
    PERFORM create_job_queue_record(OLD.id, 'Post', 'CleanUp');

  -- On post publish, create a job to update the nsfw level of the related entities (modelVersions, collectionItems)
  ELSIF (NEW."publishedAt" IS NOT NULL AND OLD."publishedAt" IS NULL) THEN
    PERFORM create_job_queue_record(NEW.id, 'Post', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$post_nsfw_level$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER post_nsfw_level_change
AFTER UPDATE OF "publishedAt" OR DELETE ON "Post"
FOR EACH ROW
EXECUTE FUNCTION update_post_nsfw_level();


-- MODEL VERSION TRIGGER
CREATE OR REPLACE FUNCTION update_model_version_nsfw_level()
RETURNS TRIGGER AS $model_version_nsfw_level$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When a model version is deleted, schedule nsfw level update for the model
    PERFORM create_job_queue_record(OLD."modelId", 'Model', 'UpdateNsfwLevel');
    RETURN NULL;
  END IF;

  -- On model version publish, create a job to update the nsfw level of the related entities (model)
  IF (NEW.status = 'Published' AND OLD.status != 'Published') THEN
    PERFORM create_job_queue_record(NEW.id, 'ModelVersion', 'UpdateNsfwLevel');
  END IF;

  -- ModelVersion.nsfw is an INPUT to the version's derived nsfwLevel, so a flip has to
  -- enqueue a recompute or the level never moves: the cron drains "JobQueue" and does not
  -- scan for stale rows, and update-model-version-nsfw-levels only revisits versions
  -- sitting at 0. IS DISTINCT FROM in BOTH directions, not `!=` — the same shape on
  -- "Model" left versions stamped NSFW after a true->false flip, which froze the model's
  -- bit_or rollup (see 20260519120000_fix_model_nsfw_flip_version_cascade).
  --
  -- Version only: getModelVersionConnectedEntities derives the parent model from it, and
  -- the cron rolls models up after versions in the same tick.
  IF (NEW."nsfw" IS DISTINCT FROM OLD."nsfw") THEN
    PERFORM create_job_queue_record(NEW.id, 'ModelVersion', 'UpdateNsfwLevel');
  END IF;

  RETURN NULL;
END;
$model_version_nsfw_level$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER model_version_nsfw_level_change
AFTER UPDATE OF "status", "nsfw" OR DELETE ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION update_model_version_nsfw_level();
---

-- A version under a system-owned model must never carry the name flag.
--
-- The derivation has no branch for a system-owned model that is not flagged: the CASE falls
-- through to NULL, the update's `!=` guard is never true, and the row keeps whatever level it
-- had. So setting the flag there is a ONE-WAY door — clearing it leaves the version stamped at
-- the NSFW level permanently, and that then rolls into its parent model. There is no agreed
-- level to recompute such a version back to, so the trap is closed at the write instead.
--
-- INSERT as well as UPDATE: the whole reason this is in the database is the writers that are
-- not the adapter — a hand-run backfill or a moderator tool can INSERT a version with the flag
-- already set, and an UPDATE-only guard never sees it. Once the row exists in that state no
-- later UPDATE OF "nsfw" is needed to keep it, so there is no second chance to catch it.
--
-- Enforced in the database, not in application code. The live writer (the version-name
-- moderation adapter) excludes system-owned models in its own WHERE, but a guard that only
-- lived there would not see a hand-run backfill or a moderator tool — and this is a trap with
-- no way back out.
CREATE OR REPLACE FUNCTION reject_system_model_version_nsfw()
RETURNS TRIGGER AS $reject_system_mv_nsfw$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Model" m WHERE m.id = NEW."modelId" AND m."userId" = -1
  ) THEN
    RAISE EXCEPTION
      'ModelVersion.nsfw cannot be set on a system-owned model (modelVersionId %, modelId %)',
      NEW.id, NEW."modelId";
  END IF;
  RETURN NEW;
END;
$reject_system_mv_nsfw$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER model_version_nsfw_system_guard
BEFORE INSERT OR UPDATE OF "nsfw" ON "ModelVersion"
FOR EACH ROW
WHEN (NEW."nsfw")
EXECUTE FUNCTION reject_system_model_version_nsfw();


-- MODEL TRIGGER
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
---
CREATE OR REPLACE TRIGGER model_nsfw_level_change
AFTER UPDATE OF "status", "nsfw" OR DELETE ON "Model"
FOR EACH ROW
EXECUTE FUNCTION update_model_nsfw_level();


-- ARTICLE TRIGGER
CREATE OR REPLACE FUNCTION update_article_nsfw_level()
RETURNS TRIGGER AS $article_nsfw_level$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When an article is deleted, schedule removal of FKs (collectionItems)
    PERFORM create_job_queue_record(OLD.id, 'Article', 'CleanUp');
  -- On article publish, create a job to update the nsfw level of the related entities (collectionItems)
  ELSIF ((NEW."publishedAt" IS NOT NULL AND OLD."publishedAt" IS NULL) OR (NEW."userNsfwLevel" != OLD."userNsfwLevel" AND NEW."publishedAt" IS NOT NULL)) THEN
    PERFORM create_job_queue_record(OLD."id", 'Article', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$article_nsfw_level$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER article_nsfw_level_change
AFTER UPDATE OF "publishedAt", "userNsfwLevel" OR DELETE ON "Article"
FOR EACH ROW
EXECUTE FUNCTION update_article_nsfw_level();


-- COLLECTION ITEM TRIGGER
CREATE OR REPLACE FUNCTION update_collection_nsfw_level()
RETURNS TRIGGER AS $collection_nsfw_level$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When a collection item is deleted, schedule update of collection nsfw level
    PERFORM create_job_queue_record(OLD."collectionId", 'Collection', 'UpdateNsfwLevel');
  -- On collection item publish, schedule update of collection nsfw level
  ELSIF ((TG_OP = 'UPDATE' AND OLD.status != 'ACCEPTED' AND NEW.status = 'ACCEPTED')) THEN
    PERFORM create_job_queue_record(OLD."collectionId", 'Collection', 'UpdateNsfwLevel');
  -- When a collection item is added, schedule update of collection nsfw level
  ELSIF (TG_OP = 'INSERT' AND NEW.status = 'ACCEPTED') THEN
    PERFORM create_job_queue_record(NEW."collectionId", 'Collection', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$collection_nsfw_level$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER collection_nsfw_level_change
AFTER INSERT OR UPDATE OF "status" OR DELETE ON "CollectionItem"
FOR EACH ROW
EXECUTE FUNCTION update_collection_nsfw_level();

-- COLLECTION TRIGGER — re-scan when visibility / read privacy / forcedBrowsingLevel changes.
-- Collection.nsfw is ignored by the bucket logic, so changes to it don't need to re-scan.
CREATE OR REPLACE FUNCTION update_collection_visibility_nsfw_level()
RETURNS TRIGGER AS $collection_visibility_nsfw_level$
BEGIN
  IF (
    (NEW."availability" IS DISTINCT FROM OLD."availability" AND NEW."availability" = 'Public')
    OR (NEW."read" IS DISTINCT FROM OLD."read")
    OR (NEW.metadata->>'forcedBrowsingLevel' IS DISTINCT FROM OLD.metadata->>'forcedBrowsingLevel')
  ) THEN
    PERFORM create_job_queue_record(NEW.id, 'Collection', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$collection_visibility_nsfw_level$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER collection_visibility_nsfw_level_change
AFTER UPDATE OF "availability", "read", "metadata" ON "Collection"
FOR EACH ROW
EXECUTE FUNCTION update_collection_visibility_nsfw_level();

-- BOUNTY TRIGGER
CREATE OR REPLACE FUNCTION update_bounty_nsfw_level()
RETURNS TRIGGER AS $bounty_nsfw_level$
BEGIN
  -- On bounty nsfw toggle, create a job to update the nsfw level
  PERFORM create_job_queue_record(NEW."id", 'Bounty', 'UpdateNsfwLevel');
  RETURN NULL;
END;
$bounty_nsfw_level$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER bounty_nsfw_level_change
AFTER UPDATE OF "nsfw" ON "Bounty"
FOR EACH ROW
EXECUTE FUNCTION update_bounty_nsfw_level();

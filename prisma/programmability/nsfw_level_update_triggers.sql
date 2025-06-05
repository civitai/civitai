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
  -- On model version publish, create a job to update the nsfw level of the related entities (model)
  ELSIF (NEW.status = 'Published' AND OLD.status != 'Published') THEN
    PERFORM create_job_queue_record(NEW.id, 'ModelVersion', 'UpdateNsfwLevel');
  END IF;
  RETURN NULL;
END;
$model_version_nsfw_level$ LANGUAGE plpgsql;
---
CREATE OR REPLACE TRIGGER model_version_nsfw_level_change
AFTER UPDATE OF "status" OR DELETE ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION update_model_version_nsfw_level();


-- MODEL TRIGGER
CREATE OR REPLACE FUNCTION update_model_nsfw_level()
RETURNS TRIGGER AS $model_nsfw_level$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    -- When a model is deleted, schedule removal of FKs (collectionItems)
    PERFORM create_job_queue_record(OLD.id, 'Model', 'CleanUp');
  -- On model publish, create a job to update the nsfw level of the related entities (collectionItems)
  ELSIF ((NEW.status = 'Published' AND OLD.status != 'Published') OR (NEW."nsfw" != OLD."nsfw" AND NEW.status = 'Published')) THEN
    PERFORM create_job_queue_record(OLD."id", 'Model', 'UpdateNsfwLevel');
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

-- TODO ??? - create trigger for collection update nsfw? (NEW."nsfw" != OLD."nsfw" AND NEW.status = 'ACCEPTED')

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

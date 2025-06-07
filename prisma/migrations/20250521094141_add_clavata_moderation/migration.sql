ALTER TYPE "JobQueueType" ADD VALUE 'ModerationRequest';

ALTER TYPE "EntityType" ADD VALUE 'Comment';
ALTER TYPE "EntityType" ADD VALUE 'CommentV2';
ALTER TYPE "EntityType" ADD VALUE 'User';
ALTER TYPE "EntityType" ADD VALUE 'UserProfile';
ALTER TYPE "EntityType" ADD VALUE 'ResourceReview';
ALTER TYPE "EntityType" ADD VALUE 'ChatMessage';

CREATE TYPE "ModerationRequest_ExternalType" AS ENUM (
  'Clavata'
);

CREATE TABLE "ModerationRequest" (
  "id" serial NOT NULL,
  "externalId" text,
  "externalType" "ModerationRequest_ExternalType",
  "entityType" "EntityType" NOT NULL,
  "entityId" int NOT NULL,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT "ModerationRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ModerationRequest_uniq_externalId_externalType" UNIQUE NULLS NOT DISTINCT ("externalId", "externalType"),
  CONSTRAINT "ModerationRequest_uniq_externalType_entityType_entityId" UNIQUE NULLS NOT DISTINCT ("externalType", "entityType", "entityId")
);
---

CREATE OR REPLACE FUNCTION create_job_queue_moderation()
  RETURNS TRIGGER AS
$$
DECLARE
  id int;
  entityType text := TG_ARGV[0]::text;
BEGIN
  IF entityType IS NULL THEN
    RAISE NOTICE 'entityType is required but is null. SKipping.';
    RETURN NEW;
  END IF;

  IF entityType = 'UserProfile' THEN
    id := NEW."userId";
  ELSE
    id := NEW."id";
  end if;

  IF id IS NULL THEN
    RAISE NOTICE 'ID is required but is null. Skipping.';
    RETURN NEW;
  END IF;

  INSERT INTO "JobQueue" (type, "entityType", "entityId") VALUES ('ModerationRequest', entityType::"EntityType", id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION create_job_queue_moderation() IS 'Insert a JobQueue record for moderation';


-- CREATE OR REPLACE TRIGGER trg_moderation_chatmessage
--   AFTER UPDATE OF "content" OR INSERT
--   ON "ChatMessage"
--   FOR EACH ROW
--   WHEN (NEW."contentType" = 'Markdown' AND NEW."userId" != -1)
-- EXECUTE FUNCTION create_job_queue_moderation('ChatMessage');

CREATE OR REPLACE TRIGGER trg_moderation_comment
  AFTER UPDATE OF "content" OR INSERT
  ON "Comment"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('Comment');

CREATE OR REPLACE TRIGGER trg_moderation_commentv2
  AFTER UPDATE OF "content" OR INSERT
  ON "CommentV2"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('CommentV2');

CREATE OR REPLACE TRIGGER trg_moderation_user
  AFTER UPDATE OF "username" OR INSERT
  ON "User"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('User');

CREATE OR REPLACE TRIGGER trg_moderation_userprofile
  AFTER UPDATE OF "bio", "message" OR INSERT
  ON "UserProfile"
  FOR EACH ROW
  WHEN (NEW."bio" IS NOT NULL OR NEW."message" IS NOT NULL)
EXECUTE FUNCTION create_job_queue_moderation('UserProfile');

CREATE OR REPLACE TRIGGER trg_moderation_model
  AFTER UPDATE OF "name", "description" OR INSERT
  ON "Model"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('Model');

CREATE OR REPLACE TRIGGER trg_moderation_post
  AFTER UPDATE OF "title", "detail" OR INSERT
  ON "Post"
  FOR EACH ROW
  WHEN (NEW."title" IS NOT NULL OR NEW."detail" IS NOT NULL)
EXECUTE FUNCTION create_job_queue_moderation('Post');

CREATE OR REPLACE TRIGGER trg_moderation_resourcereview
  AFTER UPDATE OF "details" OR INSERT
  ON "ResourceReview"
  FOR EACH ROW
  WHEN (NEW."details" IS NOT NULL)
EXECUTE FUNCTION create_job_queue_moderation('ResourceReview');

CREATE OR REPLACE TRIGGER trg_moderation_article
  AFTER UPDATE OF "title", "content" OR INSERT
  ON "Article"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('Article');

CREATE OR REPLACE TRIGGER trg_moderation_bounty
  AFTER UPDATE OF "name", "description" OR INSERT
  ON "Bounty"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('Bounty');

CREATE OR REPLACE TRIGGER trg_moderation_bountyentry
  AFTER UPDATE OF "description" OR INSERT
  ON "BountyEntry"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('BountyEntry');

CREATE OR REPLACE TRIGGER trg_moderation_collection
  AFTER UPDATE OF "name", "description" OR INSERT
  ON "Collection"
  FOR EACH ROW
EXECUTE FUNCTION create_job_queue_moderation('Collection');

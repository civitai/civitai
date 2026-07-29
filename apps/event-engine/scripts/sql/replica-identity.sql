ALTER TABLE "ResourceReview" REPLICA IDENTITY FULL;
ALTER TABLE "BountyBenefactor" REPLICA IDENTITY FULL;

-- Reaction tables: delete events (un-react) must carry reaction + entityId + userId
-- in the before-image so handlers can decrement metrics. Default REPLICA IDENTITY
-- only ships the PK (id), so deletes were silently no-ops and metrics drifted up.
ALTER TABLE "ImageReaction" REPLICA IDENTITY FULL;
ALTER TABLE "ArticleReaction" REPLICA IDENTITY FULL;
ALTER TABLE "BountyEntryReaction" REPLICA IDENTITY FULL;

-- Same delete-decrement bug class: these handlers read NON-PK columns from the
-- delete before-image (entity ids, userId, type, status, etc.) to know what to
-- decrement. With DEFAULT replica identity the before-image is PK-only, so the
-- needed fields are undefined and the delete silently skips its decrement.
ALTER TABLE "UserEngagement" REPLICA IDENTITY FULL;          -- reads `type` (PK: userId,targetUserId)
ALTER TABLE "TagEngagement" REPLICA IDENTITY FULL;           -- reads `type` (PK: userId,tagId)
ALTER TABLE "ComicProjectEngagement" REPLICA IDENTITY FULL;  -- reads `type`,`readChapters` (PK: userId,projectId)
ALTER TABLE "CollectionContributor" REPLICA IDENTITY FULL;   -- reads `permissions` (PK: userId,collectionId)
ALTER TABLE "CollectionItem" REPLICA IDENTITY FULL;          -- reads entity ids,addedById,status (PK: id)
ALTER TABLE "Comment" REPLICA IDENTITY FULL;                 -- reads userId,modelId (PK: id)
ALTER TABLE "CommentV2" REPLICA IDENTITY FULL;               -- reads userId,threadId (PK: id)
ALTER TABLE "Article" REPLICA IDENTITY FULL;                 -- reads status,userId (PK: id)
ALTER TABLE "Bounty" REPLICA IDENTITY FULL;                  -- reads userId (PK: id)
ALTER TABLE "BountyEntry" REPLICA IDENTITY FULL;             -- reads userId,bountyId (PK: id)
-- Thread entity FKs: SET NULL -> CASCADE, so a hard-deleted entity takes its thread with it.
-- "commentId" stays SET NULL on purpose (see the Thread model in schema.full.prisma).
--
-- HAND-APPLIED, either side of the deploy: the client never emulates delete actions, so no code
-- depends on this landing first. Existing orphans are purged separately; this only stops new ones.
--
-- 🔴 Each ALTER takes ACCESS EXCLUSIVE on "Thread" for the drop + NOT VALID re-add. Milliseconds,
-- but it queues behind long readers: apply one block at a time and re-run on lock timeout. The
-- VALIDATEs take only SHARE UPDATE EXCLUSIVE, so writes continue; one at a time, any order.

SET lock_timeout = '5s';

-- Thread.challengeId never had an FK in prod (baseline: missing-foreign-key|Thread|challengeId).
-- Delete rows pointing at deleted challenges so the ADD succeeds.
DELETE FROM "Thread" t
WHERE t."challengeId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "Challenge" c WHERE c.id = t."challengeId");

ALTER TABLE "Thread" ADD CONSTRAINT "Thread_challengeId_fkey"
  FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id")
  ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_imageId_fkey",
  ADD CONSTRAINT "Thread_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "Image"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_postId_fkey",
  ADD CONSTRAINT "Thread_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "Post"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_reviewId_fkey",
  ADD CONSTRAINT "Thread_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "ResourceReview"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_modelId_fkey",
  ADD CONSTRAINT "Thread_modelId_fkey"
    FOREIGN KEY ("modelId") REFERENCES "Model"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_articleId_fkey",
  ADD CONSTRAINT "Thread_articleId_fkey"
    FOREIGN KEY ("articleId") REFERENCES "Article"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_bountyId_fkey",
  ADD CONSTRAINT "Thread_bountyId_fkey"
    FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_bountyEntryId_fkey",
  ADD CONSTRAINT "Thread_bountyEntryId_fkey"
    FOREIGN KEY ("bountyEntryId") REFERENCES "BountyEntry"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_comicChapter_fkey",
  ADD CONSTRAINT "Thread_comicChapter_fkey"
    FOREIGN KEY ("comicProjectId", "comicChapterPosition") REFERENCES "ComicChapter"("projectId", "position")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_model3dId_fkey",
  ADD CONSTRAINT "Thread_model3dId_fkey"
    FOREIGN KEY ("model3dId") REFERENCES "Model3D"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_model3dReviewId_fkey",
  ADD CONSTRAINT "Thread_model3dReviewId_fkey"
    FOREIGN KEY ("model3dReviewId") REFERENCES "Model3DReview"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_appListingId_fkey",
  ADD CONSTRAINT "Thread_appListingId_fkey"
    FOREIGN KEY ("appListingId") REFERENCES "app_listings"("serial_id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_crucibleId_fkey",
  ADD CONSTRAINT "Thread_crucibleId_fkey"
    FOREIGN KEY ("crucibleId") REFERENCES "Crucible"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_questionId_fkey",
  ADD CONSTRAINT "Thread_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "Question"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_answerId_fkey",
  ADD CONSTRAINT "Thread_answerId_fkey"
    FOREIGN KEY ("answerId") REFERENCES "Answer"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

ALTER TABLE "Thread"
  DROP CONSTRAINT "Thread_clubPostId_fkey",
  ADD CONSTRAINT "Thread_clubPostId_fkey"
    FOREIGN KEY ("clubPostId") REFERENCES "ClubPost"("id")
    ON UPDATE CASCADE ON DELETE CASCADE NOT VALID;

RESET lock_timeout;

-- Already present in prod, newly declared in the schema; IF NOT EXISTS keeps this safe on both.
-- CONCURRENTLY cannot run inside a transaction block: apply this statement on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Thread_parentThreadId_idx" ON "Thread" ("parentThreadId");

ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_challengeId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_imageId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_postId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_reviewId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_modelId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_articleId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_bountyId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_bountyEntryId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_comicChapter_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_model3dId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_model3dReviewId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_appListingId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_crucibleId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_questionId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_answerId_fkey";
ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_clubPostId_fkey";

-- Storylines: each storyline gets its own comment thread (CommentsV2 entity type `storyline`),
-- separate from chapter 1's post thread. Adds the polymorphic parent FK `Thread.storylineId`
-- (nullable, unique), exactly like `Thread.crucibleId`; the shared comment path resolves the thread
-- by interpolating `${entityType}Id`. Also registers `storyline` with the CommentV3 dual-write
-- (docs/comments-consolidation.md: a new entity type is enum value + partition + FK), so storyline
-- comments are mirrored like every other type.
--
-- MANUAL APPLY, per environment, BEFORE the deploy that reads it. This inverts the usual
-- "client before migration" order for an enum value, because the regenerated client lists
-- `storylineId` among Thread's columns and a Thread read without an explicit select would fail
-- without it. Applying early is safe for the running code:
--   * nothing here writes a `storyline` value or sets "storylineId" on any row;
--   * `commentv3_thread_entity` returns 'storyline' only from its "storylineId" arm, and every
--     existing row has "storylineId" NULL until the new code writes one;
--   * the running code never names the column or the enum value.
--
-- Apply statement by statement (psql autocommit, the default), with the lock timeout below, and
-- re-run a statement that times out. Re-runnable: every step is guarded.
--   Step 1 takes ACCESS EXCLUSIVE on "Thread" for a catalog-only ADD COLUMN (milliseconds).
--   Step 2 is CONCURRENTLY and MUST run outside any transaction. If it fails mid-build it leaves an
--     INVALID index: `DROP INDEX CONCURRENTLY IF EXISTS "Thread_storylineId_key";` and re-run it.
--   Step 3 adds the FK NOT VALID (brief SHARE ROW EXCLUSIVE on "Thread" and "Storyline"), then
--     VALIDATE takes only SHARE UPDATE EXCLUSIVE, so writes continue.
--   Step 4 adds the enum value on its own: a new value cannot be used until it commits.
--   Step 5 is one transaction: the CommentTopic partition (briefly locks "CommentTopic") with its
--     FK to "Storyline", and the mirror's entity resolver with the storyline arm.
SET lock_timeout = '3s';

-- 1. Column.
ALTER TABLE "Thread" ADD COLUMN IF NOT EXISTS "storylineId" INTEGER;

-- 2. Unique index. RUN OUTSIDE ANY TRANSACTION.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Thread_storylineId_key" ON "Thread" ("storylineId");

-- 3. Foreign key. CASCADE like every other Thread entity FK (20261101120000_thread_entity_fk_cascade):
-- a storyline goes only with its owner's account, and its thread goes with it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Thread_storylineId_fkey') THEN
    ALTER TABLE "Thread"
      ADD CONSTRAINT "Thread_storylineId_fkey"
      FOREIGN KEY ("storylineId") REFERENCES "Storyline" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
      NOT VALID;
  END IF;
END $$;

ALTER TABLE "Thread" VALIDATE CONSTRAINT "Thread_storylineId_fkey";

-- 4. CommentV3 entity type. On its own, outside the transaction below.
ALTER TYPE "CommentEntityType" ADD VALUE IF NOT EXISTS 'storyline';

-- 5. CommentV3 partition and the mirror's entity resolver.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "CommentTopic_storyline" PARTITION OF "CommentTopic" FOR VALUES IN ('storyline');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommentTopic_storyline_entityId_fkey') THEN
    ALTER TABLE "CommentTopic_storyline"
      ADD CONSTRAINT "CommentTopic_storyline_entityId_fkey"
      FOREIGN KEY ("entityId") REFERENCES "Storyline" ("id") ON DELETE CASCADE;
  END IF;
END $$;

-- As in 20261120120000_comment_v3_mirror, with the "storylineId" arm added. Requires step 1 (the
-- body reads the column) and step 4 (it assigns the value).

-- Climbs reply threads via Thread.commentId -> CommentV2.threadId because prod has null rootThreadId on
-- some child threads. All outputs are NULL when there is no entity (question/answer/clubPost, dead-parent
-- thread, missing comic chapter); callers test entityType. The Phase 3 backfill must call this, not
-- re-derive it.
CREATE OR REPLACE FUNCTION commentv3_thread_entity(
  th "Thread",
  OUT "entityType" "CommentEntityType",
  OUT "entityId"   integer,
  OUT "rootLocked" boolean
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  root "Thread" := th;
  hops integer := 0;
BEGIN
  WHILE root."commentId" IS NOT NULL LOOP
    hops := hops + 1;
    IF hops > 1000 THEN RETURN; END IF;
    SELECT t.* INTO root
      FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId"
     WHERE c.id = root."commentId";
    IF NOT FOUND THEN RETURN; END IF;
  END LOOP;

  CASE
    WHEN root."modelId"         IS NOT NULL THEN "entityType" := 'model';         "entityId" := root."modelId";
    WHEN root."imageId"         IS NOT NULL THEN "entityType" := 'image';         "entityId" := root."imageId";
    WHEN root."postId"          IS NOT NULL THEN "entityType" := 'post';          "entityId" := root."postId";
    WHEN root."articleId"       IS NOT NULL THEN "entityType" := 'article';       "entityId" := root."articleId";
    WHEN root."reviewId"        IS NOT NULL THEN "entityType" := 'review';        "entityId" := root."reviewId";
    WHEN root."bountyId"        IS NOT NULL THEN "entityType" := 'bounty';        "entityId" := root."bountyId";
    WHEN root."bountyEntryId"   IS NOT NULL THEN "entityType" := 'bountyEntry';   "entityId" := root."bountyEntryId";
    WHEN root."challengeId"     IS NOT NULL THEN "entityType" := 'challenge';     "entityId" := root."challengeId";
    WHEN root."model3dId"       IS NOT NULL THEN "entityType" := 'model3d';       "entityId" := root."model3dId";
    WHEN root."model3dReviewId" IS NOT NULL THEN "entityType" := 'model3dReview'; "entityId" := root."model3dReviewId";
    WHEN root."appListingId"    IS NOT NULL THEN "entityType" := 'appListing';    "entityId" := root."appListingId";
    WHEN root."crucibleId"      IS NOT NULL THEN "entityType" := 'crucible';      "entityId" := root."crucibleId";
    WHEN root."storylineId"     IS NOT NULL THEN "entityType" := 'storyline';     "entityId" := root."storylineId";
    WHEN root."comicProjectId"  IS NOT NULL THEN
      "entityType" := 'comicChapter';
      SELECT ch.id INTO "entityId" FROM "ComicChapter" ch
       WHERE ch."projectId" = root."comicProjectId" AND ch.position = root."comicChapterPosition";
    ELSE
      RETURN;
  END CASE;
  IF "entityId" IS NULL THEN "entityType" := NULL; RETURN; END IF;
  "rootLocked" := root.locked;
END $$;

COMMIT;

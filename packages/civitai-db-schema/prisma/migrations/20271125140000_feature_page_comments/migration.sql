-- Feature Pages discussion: the Comment v3 thread of a feature or feature request on the
-- data.civitai.com platform (entity type `featurePage`), an integer id for each platform urn, and the
-- mirror table that pushes each comment and its moderation state to the platform.
--
-- MANUAL APPLY, per environment, AFTER the release carrying the regenerated client is deployed
-- there, and before either Feature Pages flag is turned on. Until it is applied, that release's
-- Feature Pages jobs do nothing.
--
-- Apply off-peak with psql (ON_ERROR_STOP on), connected as the role that owns "CommentTopic", in
-- this order:
--   a. Dry run step 1: BEGIN; <step 1>; ROLLBACK;
--   b. Apply step 1. It adds the enum value on its own: a new value cannot be used in the transaction
--      that adds it.
--   c. Dry run steps 2 and 3 together: BEGIN; <step 2 without its own BEGIN and COMMIT>; <step 3>;
--      ROLLBACK;
--   d. Apply steps 2 and 3 as written.
-- Every step is re-runnable; re-run one that times out on its lock. Where the mirror table already
-- exists, read its columns back first: IF NOT EXISTS passes over an older copy of it.
-- Locks: step 2 holds ACCESS EXCLUSIVE on "CommentTopic" and SHARE ROW EXCLUSIVE on "CommentV3" until
-- it commits, so comment reads and writes wait for it. Step 3 creates a table nothing references.
SET lock_timeout = '3s';

-- 1. Comment v3 entity type. On its own, outside the transaction below.
ALTER TYPE "CommentEntityType" ADD VALUE IF NOT EXISTS 'featurePage';

-- 2. The platform subject a thread hangs on, and its Comment v3 partition. Deleting a topic row
--    deletes its thread.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "FeaturePageTopic" (
  "id" SERIAL PRIMARY KEY,
  "urn" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "FeaturePageTopic_kind_check" CHECK ("kind" IN ('feature', 'request'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "FeaturePageTopic_urn_key" ON "FeaturePageTopic" ("urn");

CREATE TABLE IF NOT EXISTS "CommentTopic_featurePage" PARTITION OF "CommentTopic" FOR VALUES IN ('featurePage');

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommentTopic_featurePage_entityId_fkey') THEN
    ALTER TABLE "CommentTopic_featurePage"
      ADD CONSTRAINT "CommentTopic_featurePage_entityId_fkey"
      FOREIGN KEY ("entityId") REFERENCES "FeaturePageTopic" ("id") ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;

-- 3. One row per Feature Pages comment: what was last pushed to the platform and when to push next.
--    No foreign key to "CommentV3", so the row outlives a hard-deleted comment and still pushes its
--    retraction or removal.
CREATE TABLE IF NOT EXISTS "FeaturePageCommentMirror" (
  "commentId" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "requestId" TEXT NOT NULL,
  "urn" TEXT,
  "goneCause" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "pushedState" TEXT,
  "pushedDigest" TEXT,
  "platformDigest" TEXT,
  "pendingDigest" TEXT,
  "pushAttempts" INTEGER NOT NULL DEFAULT 0,
  "scanAttempts" INTEGER NOT NULL DEFAULT 0,
  "scanHash" TEXT,
  -- The frame requestIds of the last 20 edits applied: a resent edit changes nothing.
  "editRequestIds" TEXT[] NOT NULL DEFAULT '{}',
  -- Set before the first post is sent: a lost reply leaves it set with no urn.
  "postAttemptedAt" TIMESTAMPTZ(6),
  -- Counts text sends after the first post, so each changed body gets its own idempotency key.
  "postSeq" INTEGER NOT NULL DEFAULT 0,
  -- When goneCause was set: the retraction's event time, the same on every retry.
  "goneAt" TIMESTAMPTZ(6),
  -- Since when its feature subject is one the platform does not hold yet: the post waits, uncapped.
  "subjectMissingAt" TIMESTAMPTZ(6),
  -- The text's own event time (post or edit), sent as `at`; flag changes do not move it.
  "contentAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  -- Set when the platform holds, or is about to be sent, a removal: never cleared.
  "removeWantedAt" TIMESTAMPTZ(6),
  -- Since when a restriction (hide, removal, retraction) is owed to the platform: lease priority and
  -- the alert clock.
  "restrictedAt" TIMESTAMPTZ(6),
  "nextPushAt" TIMESTAMPTZ(6),
  "leaseUntil" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "FeaturePageCommentMirror_goneCause_check"
    CHECK ("goneCause" IS NULL OR "goneCause" IN ('author', 'moderator', 'refused'))
);

CREATE INDEX IF NOT EXISTS "FeaturePageCommentMirror_nextPushAt_idx"
  ON "FeaturePageCommentMirror" ("nextPushAt");
-- Owed restrictions lease first.
CREATE INDEX IF NOT EXISTS "FeaturePageCommentMirror_restricted_nextPushAt_idx"
  ON "FeaturePageCommentMirror" ("nextPushAt") WHERE "restrictedAt" IS NOT NULL;
-- One comment per frame request: a resend after the request's claim lapsed finds this row.
CREATE UNIQUE INDEX IF NOT EXISTS "FeaturePageCommentMirror_userId_requestId_key"
  ON "FeaturePageCommentMirror" ("userId", "requestId");
-- The frame names a comment by its platform urn (edit, retract, report) and so does the reconcile.
CREATE UNIQUE INDEX IF NOT EXISTS "FeaturePageCommentMirror_urn_key"
  ON "FeaturePageCommentMirror" ("urn") WHERE "urn" IS NOT NULL;

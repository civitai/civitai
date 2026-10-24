-- CommentV3 tables. Design: docs/comments-consolidation.md, "Target data model" and "Entity deletion".
--
-- Apply: `psql -v ON_ERROR_STOP=1 -f migration.sql`. ltree is a trusted extension, so the
-- application role can create it.

BEGIN;

-- The entity FKs take SHARE ROW EXCLUSIVE on 15 hot tables and hold it to COMMIT. Fail fast behind
-- a long writer rather than queue every write to those tables; nothing persists on rollback.
SET LOCAL lock_timeout = '3s';

CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TYPE "CommentEntityType" AS ENUM (
  'model', 'image', 'post', 'article', 'review', 'bounty', 'bountyEntry',
  'comicChapter', 'challenge', 'model3d', 'model3dReview', 'appListing', 'crucible'
);

-- One id space across Comment, CommentV2 and CommentV3, so a row mirrored during dual-write keeps its id.
-- Seeded and made the old tables' default at the end of this transaction, under their lock.
CREATE SEQUENCE comment_shared_id_seq AS integer;

-- Partitioned by entity type so each partition can carry a real FK to its entity table. No DEFAULT
-- partition on purpose: an enum value without a partition must fail on its first insert.
-- entityId leads the key so the entity-side cascade probes the partition index directly.
CREATE TABLE "CommentTopic" (
  "entityType"   "CommentEntityType" NOT NULL,
  "entityId"     integer             NOT NULL,
  "locked"       boolean             NOT NULL DEFAULT false,
  "commentCount" integer             NOT NULL DEFAULT 0,
  PRIMARY KEY ("entityId", "entityType")
) PARTITION BY LIST ("entityType");

-- Loops over the enum so a value with no mapping fails here rather than on the first comment.
-- ComicChapter's PK is composite, so its unique SERIAL id is the target; app_listings.id is a
-- text ULID, so the integer surrogate serial_id is (Thread.appListingId already holds it).
DO $$
DECLARE
  t            text;
  entity_table text;
  entity_col   text;
BEGIN
  FOREACH t IN ARRAY enum_range(NULL::"CommentEntityType")::text[] LOOP
    SELECT v.tbl, v.col INTO entity_table, entity_col FROM (VALUES
      ('model',         'Model',          'id'),
      ('image',         'Image',          'id'),
      ('post',          'Post',           'id'),
      ('article',       'Article',        'id'),
      ('review',        'ResourceReview', 'id'),
      ('bounty',        'Bounty',         'id'),
      ('bountyEntry',   'BountyEntry',    'id'),
      ('comicChapter',  'ComicChapter',   'id'),
      ('challenge',     'Challenge',      'id'),
      ('model3d',       'Model3D',        'id'),
      ('model3dReview', 'Model3DReview',  'id'),
      ('appListing',    'app_listings',   'serial_id'),
      ('crucible',      'Crucible',       'id')
    ) AS v(type, tbl, col) WHERE v.type = t;
    IF entity_table IS NULL THEN
      RAISE EXCEPTION 'CommentEntityType value % has no entity table mapped', t;
    END IF;
    EXECUTE format('CREATE TABLE %I PARTITION OF "CommentTopic" FOR VALUES IN (%L)',
                   'CommentTopic_' || t, t);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("entityId") REFERENCES %I (%I) ON DELETE CASCADE',
                   'CommentTopic_' || t, 'CommentTopic_' || t || '_entityId_fkey', entity_table, entity_col);
  END LOOP;
END $$;

CREATE TABLE "CommentV3" (
  "id"            integer             NOT NULL DEFAULT nextval('comment_shared_id_seq'),
  "entityType"    "CommentEntityType" NOT NULL,
  "entityId"      integer             NOT NULL,

  "parentId"      integer,
  "replyToId"     integer,

  -- Set by commentv3_set_path. NOT NULL is explicit on the generated columns because Postgres does not infer it.
  "path"          ltree               NOT NULL,
  "rootId"        integer             GENERATED ALWAYS AS ((subltree(path, 0, 1)::text)::integer) STORED NOT NULL,
  "depth"         integer             GENERATED ALWAYS AS (nlevel(path) - 1) STORED NOT NULL,

  "userId"        integer             NOT NULL,
  "content"       text                NOT NULL,
  "createdAt"     timestamptz         NOT NULL DEFAULT now(),
  "updatedAt"     timestamptz         NOT NULL DEFAULT now(),
  "deletedAt"     timestamptz,

  "tosViolation"  boolean             NOT NULL DEFAULT false,
  "hidden"        boolean             NOT NULL DEFAULT false,
  "locked"        boolean             NOT NULL DEFAULT false,
  "pinnedAt"      timestamptz,

  "reactionCount" integer             NOT NULL DEFAULT 0,
  "legacyV1Id"    integer,

  CONSTRAINT "CommentV3_pkey" PRIMARY KEY ("id"),
  -- ON UPDATE CASCADE on every FK that mirrors a Prisma relation: Prisma's implicit onUpdate, which
  -- the schema-drift gate compares.
  CONSTRAINT "CommentV3_entityId_entityType_fkey"
    FOREIGN KEY ("entityId", "entityType") REFERENCES "CommentTopic" ("entityId", "entityType") ON DELETE CASCADE ON UPDATE CASCADE,
  -- RESTRICT: a childless delete that loses a race against a new reply fails instead of orphaning it
  CONSTRAINT "CommentV3_parentId_fkey"  FOREIGN KEY ("parentId")  REFERENCES "CommentV3" ("id") ON DELETE RESTRICT  ON UPDATE CASCADE,
  CONSTRAINT "CommentV3_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "CommentV3" ("id") ON DELETE SET NULL  ON UPDATE CASCADE,
  CONSTRAINT "CommentV3_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User" ("id")      ON DELETE CASCADE   ON UPDATE CASCADE,

  CONSTRAINT commentv3_depth_cap             CHECK (nlevel(path) <= 21),
  CONSTRAINT commentv3_reply_to_needs_parent CHECK ("replyToId" IS NULL OR "parentId" IS NOT NULL),
  CONSTRAINT commentv3_reaction_count_nonneg CHECK ("reactionCount" >= 0)
);

CREATE FUNCTION commentv3_set_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parentId" IS NULL THEN
    NEW.path := NEW.id::text::ltree;
  ELSE
    SELECT p.path || NEW.id::text INTO NEW.path FROM "CommentV3" p WHERE p.id = NEW."parentId";
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER commentv3_set_path
  BEFORE INSERT ON "CommentV3" FOR EACH ROW EXECUTE FUNCTION commentv3_set_path();

-- Counts every row, hidden and tombstoned included, matching update_thread_comment_count.
CREATE FUNCTION commentv3_topic_comment_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "CommentTopic" SET "commentCount" = "commentCount" + 1
     WHERE "entityId" = NEW."entityId" AND "entityType" = NEW."entityType";
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "CommentTopic" SET "commentCount" = GREATEST("commentCount" - 1, 0)
     WHERE "entityId" = OLD."entityId" AND "entityType" = OLD."entityType";
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_topic_comment_count
  AFTER INSERT OR DELETE ON "CommentV3" FOR EACH ROW EXECUTE FUNCTION commentv3_topic_comment_count();

-- Oldest scans commentv3_top_newest backward. Not filtered on hidden, so the same index serves the
-- moderator hidden-comments view. Newest leads on createdAt because the v1 backfill assigns new ids,
-- so id order stops being creation order.
CREATE INDEX commentv3_top_newest    ON "CommentV3" ("entityType", "entityId", "createdAt" DESC, "id" DESC)     WHERE "parentId" IS NULL;
CREATE INDEX commentv3_top_reactions ON "CommentV3" ("entityType", "entityId", "reactionCount" DESC, "id" DESC) WHERE "parentId" IS NULL;
CREATE INDEX commentv3_top_pinned    ON "CommentV3" ("entityType", "entityId", "pinnedAt" DESC)                 WHERE "pinnedAt" IS NOT NULL;
CREATE INDEX commentv3_entity        ON "CommentV3" ("entityType", "entityId");
CREATE INDEX commentv3_replies_newest    ON "CommentV3" ("parentId", "hidden", "createdAt", "id");
CREATE INDEX commentv3_replies_reactions ON "CommentV3" ("parentId", "hidden", "reactionCount" DESC, "id" DESC);
CREATE INDEX commentv3_root_depth ON "CommentV3" ("rootId", "depth");
CREATE INDEX commentv3_path_gist  ON "CommentV3" USING gist ("path");
CREATE INDEX commentv3_user       ON "CommentV3" ("userId", "id" DESC);
CREATE UNIQUE INDEX commentv3_legacy_v1 ON "CommentV3" ("legacyV1Id") WHERE "legacyV1Id" IS NOT NULL;
-- The replyToId SET NULL action runs an UPDATE per deleted row; without this it is a table scan each
CREATE INDEX commentv3_reply_to ON "CommentV3" ("replyToId") WHERE "replyToId" IS NOT NULL;

CREATE TABLE "CommentV3Reaction" (
  "id"        serial            NOT NULL,
  "commentId" integer           NOT NULL,
  "userId"    integer           NOT NULL,
  "reaction"  "ReviewReactions" NOT NULL,
  "createdAt" timestamptz       NOT NULL DEFAULT now(),
  "updatedAt" timestamptz       NOT NULL DEFAULT now(),
  CONSTRAINT "CommentV3Reaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommentV3Reaction_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV3" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CommentV3Reaction_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User" ("id")      ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CommentV3Reaction_commentId_userId_reaction_key"
  ON "CommentV3Reaction" ("commentId", "userId", "reaction");
CREATE INDEX "CommentV3Reaction_userId_idx" ON "CommentV3Reaction" ("userId");

CREATE FUNCTION commentv3_reaction_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "CommentV3" SET "reactionCount" = "reactionCount" + 1 WHERE id = NEW."commentId";
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "CommentV3" SET "reactionCount" = GREATEST("reactionCount" - 1, 0) WHERE id = OLD."commentId";
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_reaction_count
  AFTER INSERT OR DELETE ON "CommentV3Reaction" FOR EACH ROW EXECUTE FUNCTION commentv3_reaction_count();

CREATE TABLE "CommentV3Report" (
  "commentId" integer NOT NULL,
  "reportId"  integer NOT NULL,
  CONSTRAINT "CommentV3Report_pkey" PRIMARY KEY ("reportId", "commentId"),
  CONSTRAINT "CommentV3Report_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV3" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CommentV3Report_reportId_fkey"  FOREIGN KEY ("reportId")  REFERENCES "Report" ("id")    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CommentV3Report_reportId_key"  ON "CommentV3Report" ("reportId");
CREATE INDEX        "CommentV3Report_commentId_idx" ON "CommentV3Report" ("commentId");

-- Notification mutes. Two tables because a nullable primary-key column is illegal.
CREATE TABLE "CommentMute" (
  "userId"    integer     NOT NULL,
  "commentId" integer     NOT NULL,
  "mutedAt"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CommentMute_pkey" PRIMARY KEY ("userId", "commentId"),
  CONSTRAINT "CommentMute_userId_fkey"    FOREIGN KEY ("userId")    REFERENCES "User" ("id")      ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CommentMute_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV3" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CommentMute_commentId_idx" ON "CommentMute" ("commentId");

CREATE TABLE "CommentTopicMute" (
  "userId"     integer             NOT NULL,
  "entityType" "CommentEntityType" NOT NULL,
  "entityId"   integer             NOT NULL,
  "mutedAt"    timestamptz         NOT NULL DEFAULT now(),
  CONSTRAINT "CommentTopicMute_pkey" PRIMARY KEY ("userId", "entityType", "entityId"),
  CONSTRAINT "CommentTopicMute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "CommentTopicMute_entityType_entityId_idx" ON "CommentTopicMute" ("entityType", "entityId");

-- Last, so the ACCESS EXCLUSIVE lock these take on the live comment tables lasts milliseconds, and
-- max(id) is read under it: no insert can take an id from the old sequences after the read.
ALTER TABLE "Comment"   ALTER COLUMN id SET DEFAULT nextval('comment_shared_id_seq');
ALTER TABLE "CommentV2" ALTER COLUMN id SET DEFAULT nextval('comment_shared_id_seq');
-- is_called = false: the next id is max + 1, and 1 on an empty database (setval rejects 0).
SELECT setval(
  'comment_shared_id_seq',
  GREATEST((SELECT max(id) FROM "Comment"), (SELECT max(id) FROM "CommentV2"), 0) + 1,
  false
);

COMMIT;

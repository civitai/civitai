-- Dual-write mirror (docs/comments-consolidation.md, "Phase 2"). Apply after 20261110120000_comment_v3_schema,
-- with `psql -v ON_ERROR_STOP=1 -f migration.sql`.

BEGIN;

-- Trigger DDL takes table locks that queue every later writer behind it; fail rather than wait behind a
-- long writer.
SET LOCAL lock_timeout = '3s';

-- Climbs reply threads via Thread.commentId -> CommentV2.threadId because prod has null rootThreadId on
-- some child threads. All outputs are NULL when there is no entity (question/answer/clubPost, dead-parent
-- thread, missing comic chapter); callers test entityType. The Phase 3 backfill must call this, not
-- re-derive it.
CREATE FUNCTION commentv3_thread_entity(
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

-- Baked in as a constant (IMMUTABLE): the schema migration moved both tables off the old sequences, so
-- the floor cannot rise.
DO $$
DECLARE floor_id bigint;
BEGIN
  SELECT GREATEST((SELECT last_value FROM "Comment_id_seq"), (SELECT last_value FROM "CommentV2_id_seq"))
    INTO floor_id;
  -- Otherwise this fails later on CommentV3_pkey, inside a user's write.
  IF EXISTS (SELECT 1 FROM "Comment" c JOIN "CommentV2" v ON v.id = c.id WHERE c.id > floor_id) THEN
    RAISE EXCEPTION 'Comment and CommentV2 share ids above the floor %', floor_id;
  END IF;
  EXECUTE format('CREATE FUNCTION commentv3_v1_id_floor() RETURNS integer LANGUAGE sql IMMUTABLE AS %L',
                 'SELECT ' || floor_id::text || '::integer');
END $$;

-- Takes KEY SHARE on the topic row, and on the entity row when creating the topic, before the CommentV3
-- insert's FK checks would wait for them: an entity delete can hold both while it waits on a Thread row
-- this transaction holds. SKIP LOCKED yields; false = entity gone or mid-delete, so the write stays
-- unmirrored.
CREATE FUNCTION commentv3_ensure_topic(et "CommentEntityType", ei integer, lock boolean) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  entity_tbl regclass;
  entity_col name;
  locked_id  integer;
BEGIN
  PERFORM 1 FROM "CommentTopic" WHERE "entityId" = ei AND "entityType" = et FOR KEY SHARE SKIP LOCKED;
  IF FOUND THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM "CommentTopic" WHERE "entityId" = ei AND "entityType" = et) THEN RETURN false; END IF;

  SELECT k.confrelid, a.attname INTO STRICT entity_tbl, entity_col
    FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = k.confkey[1]
   WHERE k.conrelid = format('%I', 'CommentTopic_' || et::text)::regclass AND k.contype = 'f';
  EXECUTE format('SELECT %I FROM %s WHERE %I = $1 FOR KEY SHARE SKIP LOCKED', entity_col, entity_tbl, entity_col)
     INTO locked_id USING ei;
  IF locked_id IS NULL THEN RETURN false; END IF;

  INSERT INTO "CommentTopic" ("entityType", "entityId", "locked")
  VALUES (et, ei, COALESCE(lock, false))
  ON CONFLICT ("entityId", "entityType") DO NOTHING;
  -- A no-op here means a concurrent creator committed meanwhile, and the caller's insert needs the
  -- row held before an entity cascade can take it.
  PERFORM 1 FROM "CommentTopic" WHERE "entityId" = ei AND "entityType" = et FOR KEY SHARE SKIP LOCKED;
  RETURN FOUND;
END $$;

-- Past commentv3_depth_cap a reply attaches to the depth-19 ancestor and replyToId keeps who was answered;
-- the 20 and 19 derive from it. KEY SHARE makes a concurrent delete of the parent tombstone it instead
-- of removing it before the reply's insert. SKIP LOCKED on both rows: a bulk delete can hold the
-- ancestor FOR UPDATE while waiting on a Thread row we hold, and the reply's FK check would then
-- block on it. Both outputs NULL if the parent is gone or a deleter holds it.
CREATE FUNCTION commentv3_clamp_parent(
  IN  wanted_parent integer,
  OUT "parentId"  integer,
  OUT "replyToId" integer
) LANGUAGE plpgsql AS $$
DECLARE
  parent_path ltree;
  ancestor    integer;
BEGIN
  SELECT path INTO parent_path FROM "CommentV3" WHERE id = wanted_parent FOR KEY SHARE SKIP LOCKED;
  IF parent_path IS NULL THEN RETURN; END IF;
  IF nlevel(parent_path) > 20 THEN
    ancestor := subpath(parent_path, 19, 1)::text::integer;
    PERFORM 1 FROM "CommentV3" WHERE id = ancestor FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN; END IF;
    "parentId"  := ancestor;
    "replyToId" := wanted_parent;
  ELSE
    "parentId"  := wanted_parent;
  END IF;
END $$;

-- Precondition: the parent, if any, is already in CommentV3 (commentv3_mirror_v2 guarantees it).
CREATE FUNCTION commentv3_mirror_v2_one(c "CommentV2") RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  th        "Thread";
  et        "CommentEntityType";
  ei        integer;
  root_lock boolean;
  attach_parent integer;
  attach_reply  integer;
  lock      boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM "CommentV3" WHERE id = c.id) THEN RETURN c.id; END IF;

  SELECT * INTO th FROM "Thread" WHERE id = c."threadId";
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF th."commentId" IS NOT NULL THEN
    SELECT "entityType", "entityId" INTO et, ei FROM "CommentV3" WHERE id = th."commentId";
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT "parentId", "replyToId" INTO attach_parent, attach_reply FROM commentv3_clamp_parent(th."commentId");
    IF attach_parent IS NULL THEN RETURN NULL; END IF;
  ELSE
    SELECT "entityType", "entityId", "rootLocked" INTO et, ei, root_lock FROM commentv3_thread_entity(th);
    IF et IS NULL THEN RETURN NULL; END IF;
  END IF;

  IF NOT commentv3_ensure_topic(et, ei, root_lock) THEN RETURN NULL; END IF;

  -- v2 stores a comment's lock on its reply Thread.
  SELECT t.locked INTO lock FROM "Thread" t WHERE t."commentId" = c.id;

  INSERT INTO "CommentV3" (
    id, "entityType", "entityId", "parentId", "replyToId", "userId", content,
    "createdAt", "updatedAt", "tosViolation", hidden, locked, "pinnedAt"
  ) VALUES (
    c.id, et, ei, attach_parent, attach_reply, c."userId", c.content,
    c."createdAt" AT TIME ZONE 'UTC', c."updatedAt" AT TIME ZONE 'UTC',
    c."tosViolation", COALESCE(c.hidden, false), COALESCE(lock, false), c."pinnedAt" AT TIME ZONE 'UTC'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN c.id;
END $$;

-- A loop, not recursion: an unmirrored chain can be deep enough to exhaust max_stack_depth inside the
-- user's write.
CREATE FUNCTION commentv3_mirror_v2(c "CommentV2") RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  ids   integer[] := '{}';
  cur   "CommentV2" := c;
  th    "Thread";
  aid   integer;
  hops  integer := 0;
BEGIN
  LOOP
    IF EXISTS (SELECT 1 FROM "CommentV3" WHERE id = cur.id) THEN EXIT; END IF;
    ids := cur.id || ids;
    SELECT * INTO th FROM "Thread" WHERE id = cur."threadId";
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF th."commentId" IS NULL THEN EXIT; END IF;
    IF EXISTS (SELECT 1 FROM "CommentV3" WHERE id = th."commentId") THEN EXIT; END IF;
    SELECT * INTO cur FROM "CommentV2" WHERE id = th."commentId";
    IF NOT FOUND THEN RETURN NULL; END IF;
    hops := hops + 1;
    IF hops > 1000 THEN RETURN NULL; END IF;
  END LOOP;
  -- SKIP LOCKED: a deleter holding an ancestor may be waiting on a Thread row this transaction holds.
  -- A row mid-delete leaves the write unmirrored (the backfill covers it) rather than deadlocking.
  IF array_length(ids, 1) > 1 THEN
    PERFORM 1 FROM "CommentV2" WHERE id = ANY(ids) AND id <> c.id FOR KEY SHARE SKIP LOCKED;
    GET DIAGNOSTICS hops = ROW_COUNT;
    IF hops <> array_length(ids, 1) - 1 THEN RETURN NULL; END IF;
  END IF;
  FOREACH aid IN ARRAY ids LOOP
    IF aid = c.id THEN
      cur := c;
    ELSE
      SELECT * INTO cur FROM "CommentV2" WHERE id = aid;
      IF NOT FOUND THEN RETURN NULL; END IF;
    END IF;
    IF commentv3_mirror_v2_one(cur) IS NULL THEN RETURN NULL; END IF;
  END LOOP;
  RETURN c.id;
END $$;

CREATE FUNCTION commentv3_mirror_v1_one(c "Comment") RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v3_id     integer;
  attach_parent integer;
  attach_reply  integer;
BEGIN
  SELECT id INTO v3_id FROM "CommentV3" WHERE "legacyV1Id" = c.id;
  IF FOUND THEN RETURN v3_id; END IF;

  IF c."parentId" IS NOT NULL THEN
    SELECT id INTO v3_id FROM "CommentV3" WHERE "legacyV1Id" = c."parentId";
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT "parentId", "replyToId" INTO attach_parent, attach_reply FROM commentv3_clamp_parent(v3_id);
    IF attach_parent IS NULL THEN RETURN NULL; END IF;
  END IF;

  -- The model may already have a (locked) v2 Thread; the topic carries that lock.
  IF NOT commentv3_ensure_topic('model', c."modelId",
       (SELECT t.locked FROM "Thread" t WHERE t."modelId" = c."modelId")) THEN RETURN NULL; END IF;

  v3_id := CASE WHEN c.id > commentv3_v1_id_floor() THEN c.id ELSE nextval('comment_shared_id_seq') END;

  INSERT INTO "CommentV3" (
    id, "entityType", "entityId", "parentId", "replyToId", "userId", content,
    "createdAt", "updatedAt", "tosViolation", hidden, locked, "pinnedAt", "legacyV1Id"
  ) VALUES (
    v3_id, 'model', c."modelId", attach_parent, attach_reply, c."userId", c.content,
    c."createdAt" AT TIME ZONE 'UTC', c."updatedAt" AT TIME ZONE 'UTC',
    c."tosViolation", COALESCE(c.hidden, false), COALESCE(c.locked, false), c."pinnedAt" AT TIME ZONE 'UTC', c.id
  )
  ON CONFLICT ("legacyV1Id") WHERE "legacyV1Id" IS NOT NULL DO NOTHING;

  SELECT id INTO v3_id FROM "CommentV3" WHERE "legacyV1Id" = c.id;
  RETURN v3_id;
END $$;

CREATE FUNCTION commentv3_mirror_v1(c "Comment") RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  ids   integer[] := '{}';
  cur   "Comment" := c;
  aid   integer;
  v3_id integer;
  hops  integer := 0;
BEGIN
  LOOP
    IF EXISTS (SELECT 1 FROM "CommentV3" WHERE "legacyV1Id" = cur.id) THEN EXIT; END IF;
    ids := cur.id || ids;
    IF cur."parentId" IS NULL THEN EXIT; END IF;
    IF EXISTS (SELECT 1 FROM "CommentV3" WHERE "legacyV1Id" = cur."parentId") THEN EXIT; END IF;
    SELECT * INTO cur FROM "Comment" WHERE id = cur."parentId";
    IF NOT FOUND THEN RETURN NULL; END IF;
    hops := hops + 1;
    IF hops > 1000 THEN RETURN NULL; END IF;
  END LOOP;
  IF array_length(ids, 1) > 1 THEN
    PERFORM 1 FROM "Comment" WHERE id = ANY(ids) AND id <> c.id FOR KEY SHARE SKIP LOCKED;
    GET DIAGNOSTICS hops = ROW_COUNT;
    IF hops <> array_length(ids, 1) - 1 THEN RETURN NULL; END IF;
  END IF;
  FOREACH aid IN ARRAY ids LOOP
    IF aid = c.id THEN
      cur := c;
    ELSE
      SELECT * INTO cur FROM "Comment" WHERE id = aid;
      IF NOT FOUND THEN RETURN NULL; END IF;
    END IF;
    v3_id := commentv3_mirror_v1_one(cur);
    IF v3_id IS NULL THEN RETURN NULL; END IF;
  END LOOP;
  SELECT id INTO v3_id FROM "CommentV3" WHERE "legacyV1Id" = c.id;
  RETURN v3_id;
END $$;

-- Two locks: NO KEY UPDATE SKIP LOCKED yields to a FOR UPDATE holder (deleter or entity cascade) and to
-- another delete's probe of the same tombstone (a KEY SHARE probe would deadlock on the upgrade). FOR
-- UPDATE then waits out in-flight replies, which each hold a row this delete already waited on: the
-- parent's reply Thread row (v2; the commentId SET NULL action locks it FOR UPDATE, because commentId
-- is uniquely indexed, and fires before this trigger), the old parent (v1), or, for a clamped reply, a
-- Thread row the deleter only wants in a cascade. A comment a clamped reply answers (replyToId) is
-- tombstoned like a parent: a hard delete would fire the replyToId SET NULL, whose lock on that reply
-- can deadlock an entity cascade against an edit of it. Rests on RI action triggers sorting before
-- commentv3_mirror by name, and on Thread.commentId keeping a full unique index.
CREATE FUNCTION commentv3_mirror_delete(v3_id integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  todo integer[] := ARRAY[v3_id];
  cur  integer;
  pid  integer;
  rid  integer;
BEGIN
  WHILE cardinality(todo) > 0 LOOP
    cur := todo[1];
    todo := todo[2:];
    PERFORM 1 FROM "CommentV3" WHERE id = cur FOR NO KEY UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    PERFORM 1 FROM "CommentV3" WHERE id = cur FOR UPDATE;
    IF EXISTS (SELECT 1 FROM "CommentV3" WHERE "parentId" = cur)
       OR EXISTS (SELECT 1 FROM "CommentV3" WHERE "replyToId" = cur) THEN
      UPDATE "CommentV3" SET "deletedAt" = now(), content = '' WHERE id = cur AND "deletedAt" IS NULL;
      CONTINUE;
    END IF;
    DELETE FROM "CommentV3" WHERE id = cur RETURNING "parentId", "replyToId" INTO pid, rid;
    -- A tombstone that just lost its last reply or answerer collapses too.
    todo := todo || ARRAY(
      SELECT x FROM unnest(ARRAY[rid, pid]) AS x
       WHERE x IS NOT NULL AND EXISTS (SELECT 1 FROM "CommentV3" WHERE id = x AND "deletedAt" IS NOT NULL));
  END LOOP;
END $$;

-- Deferred to commit so the topic row is never held while waiting on other row locks: a multi-row
-- delete (holds topic, wants the parent) and a concurrent reply (holds the parent's KEY SHARE, wants
-- topic) would deadlock. Two transactions touching two topics in opposite order can still deadlock
-- at COMMIT (40P01); row triggers cannot order their locks.
-- SECURITY DEFINER because at commit the trigger runs as the session role, not the mirror's definer.
CREATE OR REPLACE FUNCTION commentv3_topic_comment_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "CommentTopic" SET "commentCount" = "commentCount" + 1
     WHERE "entityId" = NEW."entityId" AND "entityType" = NEW."entityType";
  ELSIF TG_OP = 'DELETE' THEN
    -- SKIP LOCKED: an entity cascade holding the topic FOR UPDATE may be waiting on a row we
    -- deleted, and the topic is going anyway.
    PERFORM 1 FROM "CommentTopic"
     WHERE "entityId" = OLD."entityId" AND "entityType" = OLD."entityType"
       FOR KEY SHARE SKIP LOCKED;
    IF FOUND THEN
      UPDATE "CommentTopic" SET "commentCount" = GREATEST("commentCount" - 1, 0)
       WHERE "entityId" = OLD."entityId" AND "entityType" = OLD."entityType";
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER commentv3_topic_comment_count ON "CommentV3";
CREATE CONSTRAINT TRIGGER commentv3_topic_comment_count
  AFTER INSERT OR DELETE ON "CommentV3" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION commentv3_topic_comment_count();

-- Every trigger function below is SECURITY DEFINER: the writer role can write the old tables, not
-- CommentV3*. pg_temp stays last in search_path so a temp table can't shadow a mirror target.
-- SKIP LOCKED on a row lock means: yield to a deleter or entity cascade that may be waiting on a row
-- this transaction holds. The explicit KEY SHARE before each reaction, report or comment-mute insert
-- is there because that insert's FK check would otherwise wait.

-- toggleLockCommentsThread creates a locked root Thread before any comment exists, so the topic must be
-- created here.
CREATE FUNCTION commentv3_mirror_thread_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ent record;
  c   "CommentV2";
  ok  boolean;
BEGIN
  IF NEW."commentId" IS NULL THEN
    SELECT * INTO ent FROM commentv3_thread_entity(NEW);
    IF ent."entityType" IS NULL THEN RETURN NULL; END IF;
    -- The v1 mirror may have created the topic already, so set its lock explicitly. The UPDATE is
    -- deliberately not SKIP LOCKED: a lock toggle must not be dropped.
    IF commentv3_ensure_topic(ent."entityType", ent."entityId", NEW.locked) THEN
      UPDATE "CommentTopic" SET locked = NEW.locked
       WHERE "entityId" = ent."entityId" AND "entityType" = ent."entityType";
    END IF;
  ELSIF NEW.locked OR TG_OP = 'UPDATE' THEN
    PERFORM 1 FROM "CommentV2" WHERE id = NEW."commentId" FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM 1 FROM "CommentV3" WHERE id = NEW."commentId" FOR KEY SHARE SKIP LOCKED;
    ok := FOUND;
    IF NOT ok AND NEW.locked THEN
      SELECT * INTO c FROM "CommentV2" WHERE id = NEW."commentId";
      IF commentv3_mirror_v2(c) IS NOT NULL THEN
        PERFORM 1 FROM "CommentV3" WHERE id = NEW."commentId" FOR KEY SHARE SKIP LOCKED;
        ok := FOUND;
      END IF;
    END IF;
    IF ok THEN UPDATE "CommentV3" SET locked = NEW.locked WHERE id = NEW."commentId"; END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_mirror
  AFTER INSERT OR UPDATE OF locked
  ON "Thread" FOR EACH ROW EXECUTE FUNCTION commentv3_mirror_thread_trigger();

CREATE FUNCTION commentv3_mirror_v2_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM commentv3_mirror_v2(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only a deleter (FOR UPDATE) is skipped. The UPDATE below waits for NO KEY UPDATE holders
    -- (reaction count, lock toggle, replyToId SET NULL) instead of dropping the edit.
    PERFORM 1 FROM "CommentV3" WHERE id = NEW.id FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN
      -- Possibly mid-copy in another transaction: our copy waits for its commit and then no-ops, so
      -- NEW is applied below.
      PERFORM commentv3_mirror_v2(NEW);
      PERFORM 1 FROM "CommentV3" WHERE id = NEW.id FOR KEY SHARE SKIP LOCKED;
    END IF;
    IF FOUND THEN
      UPDATE "CommentV3"
         SET content        = NEW.content,
             "updatedAt"    = NEW."updatedAt" AT TIME ZONE 'UTC',
             "tosViolation" = NEW."tosViolation",
             hidden         = COALESCE(NEW.hidden, false),
             "pinnedAt"     = NEW."pinnedAt" AT TIME ZONE 'UTC'
       WHERE id = NEW.id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM commentv3_mirror_delete(OLD.id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_mirror
  AFTER INSERT OR DELETE OR UPDATE OF content, "tosViolation", hidden, "pinnedAt", "updatedAt"
  ON "CommentV2" FOR EACH ROW EXECUTE FUNCTION commentv3_mirror_v2_trigger();

CREATE FUNCTION commentv3_mirror_v1_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM commentv3_mirror_v1(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    -- commentv3_set_path is INSERT-only, so a move can't mirror. UPDATE OF parentId/modelId fires on every
    -- edit (the upsert always sends them), hence the IS DISTINCT check.
    IF NEW."parentId" IS DISTINCT FROM OLD."parentId" OR NEW."modelId" <> OLD."modelId" THEN
      RAISE EXCEPTION 'Comment % cannot change parent or model under the CommentV3 mirror', NEW.id;
    END IF;
    PERFORM 1 FROM "CommentV3" WHERE "legacyV1Id" = NEW.id FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN
      PERFORM commentv3_mirror_v1(NEW);
      PERFORM 1 FROM "CommentV3" WHERE "legacyV1Id" = NEW.id FOR KEY SHARE SKIP LOCKED;
    END IF;
    IF FOUND THEN
      UPDATE "CommentV3"
         SET content        = NEW.content,
             "updatedAt"    = NEW."updatedAt" AT TIME ZONE 'UTC',
             "tosViolation" = NEW."tosViolation",
             hidden         = COALESCE(NEW.hidden, false),
             locked         = COALESCE(NEW.locked, false),
             "pinnedAt"     = NEW."pinnedAt" AT TIME ZONE 'UTC'
       WHERE "legacyV1Id" = NEW.id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM commentv3_mirror_delete((SELECT id FROM "CommentV3" WHERE "legacyV1Id" = OLD.id));
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_mirror
  AFTER INSERT OR DELETE OR UPDATE OF content, "tosViolation", hidden, locked, "pinnedAt", "updatedAt", "parentId", "modelId"
  ON "Comment" FOR EACH ROW EXECUTE FUNCTION commentv3_mirror_v1_trigger();

CREATE FUNCTION commentv3_mirror_v2_reaction_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c     "CommentV2";
  v3_id integer;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    -- Deleting a reaction updates the comment's reactionCount; a cascade holding the comment removes
    -- the reaction itself.
    PERFORM 1 FROM "CommentV3" WHERE id = OLD."commentId" FOR KEY SHARE SKIP LOCKED;
    IF FOUND THEN
      DELETE FROM "CommentV3Reaction"
       WHERE id IN (SELECT id FROM "CommentV3Reaction"
                     WHERE "commentId" = OLD."commentId" AND "userId" = OLD."userId" AND reaction = OLD.reaction
                     FOR UPDATE SKIP LOCKED);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT * INTO c FROM "CommentV2" WHERE id = NEW."commentId" FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v3_id := commentv3_mirror_v2(c);
    IF v3_id IS NULL THEN RETURN NULL; END IF;
    PERFORM 1 FROM "CommentV3" WHERE id = v3_id FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    INSERT INTO "CommentV3Reaction" ("commentId", "userId", reaction, "createdAt", "updatedAt")
    VALUES (v3_id, NEW."userId", NEW.reaction, NEW."createdAt" AT TIME ZONE 'UTC', NEW."updatedAt" AT TIME ZONE 'UTC')
    ON CONFLICT ("commentId", "userId", reaction) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_mirror
  AFTER INSERT OR UPDATE OR DELETE
  ON "CommentV2Reaction" FOR EACH ROW EXECUTE FUNCTION commentv3_mirror_v2_reaction_trigger();

CREATE FUNCTION commentv3_mirror_v1_reaction_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c     "Comment";
  v3_id integer;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    PERFORM 1 FROM "CommentV3" WHERE "legacyV1Id" = OLD."commentId" FOR KEY SHARE SKIP LOCKED;
    IF FOUND THEN
      DELETE FROM "CommentV3Reaction"
       WHERE id IN (SELECT r.id FROM "CommentV3Reaction" r JOIN "CommentV3" v3 ON v3.id = r."commentId"
                     WHERE v3."legacyV1Id" = OLD."commentId" AND r."userId" = OLD."userId" AND r.reaction = OLD.reaction
                     FOR UPDATE OF r SKIP LOCKED);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT * INTO c FROM "Comment" WHERE id = NEW."commentId" FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v3_id := commentv3_mirror_v1(c);
    IF v3_id IS NULL THEN RETURN NULL; END IF;
    PERFORM 1 FROM "CommentV3" WHERE id = v3_id FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    INSERT INTO "CommentV3Reaction" ("commentId", "userId", reaction, "createdAt", "updatedAt")
    VALUES (v3_id, NEW."userId", NEW.reaction, NEW."createdAt" AT TIME ZONE 'UTC', NEW."updatedAt" AT TIME ZONE 'UTC')
    ON CONFLICT ("commentId", "userId", reaction) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_mirror
  AFTER INSERT OR UPDATE OR DELETE
  ON "CommentReaction" FOR EACH ROW EXECUTE FUNCTION commentv3_mirror_v1_reaction_trigger();

CREATE FUNCTION commentv3_mirror_v2_report_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c     "CommentV2";
  v3_id integer;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    DELETE FROM "CommentV3Report"
     WHERE "reportId" IN (SELECT "reportId" FROM "CommentV3Report" WHERE "reportId" = OLD."reportId" FOR UPDATE SKIP LOCKED);
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
  END IF;
  SELECT * INTO c FROM "CommentV2" WHERE id = NEW."commentV2Id" FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v3_id := commentv3_mirror_v2(c);
  IF v3_id IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM "CommentV3" WHERE id = v3_id FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO "CommentV3Report" ("reportId", "commentId") VALUES (NEW."reportId", v3_id)
  ON CONFLICT ("reportId") DO NOTHING;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_mirror
  AFTER INSERT OR UPDATE OR DELETE
  ON "CommentV2Report" FOR EACH ROW EXECUTE FUNCTION commentv3_mirror_v2_report_trigger();

CREATE FUNCTION commentv3_mirror_v1_report_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c     "Comment";
  v3_id integer;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    DELETE FROM "CommentV3Report"
     WHERE "reportId" IN (SELECT "reportId" FROM "CommentV3Report" WHERE "reportId" = OLD."reportId" FOR UPDATE SKIP LOCKED);
    IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
  END IF;
  SELECT * INTO c FROM "Comment" WHERE id = NEW."commentId" FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v3_id := commentv3_mirror_v1(c);
  IF v3_id IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM "CommentV3" WHERE id = v3_id FOR KEY SHARE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO "CommentV3Report" ("reportId", "commentId") VALUES (NEW."reportId", v3_id)
  ON CONFLICT ("reportId") DO NOTHING;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_mirror
  AFTER INSERT OR UPDATE OR DELETE
  ON "CommentReport" FOR EACH ROW EXECUTE FUNCTION commentv3_mirror_v1_report_trigger();

CREATE FUNCTION commentv3_mirror_thread_mute_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  th  "Thread";
  ent record;
  c   "CommentV2";
  v3_id integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO th FROM "Thread" WHERE id = OLD."threadId";
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF th."commentId" IS NOT NULL THEN
      DELETE FROM "CommentMute"
       WHERE ("userId", "commentId") IN (SELECT "userId", "commentId" FROM "CommentMute"
                                          WHERE "userId" = OLD."userId" AND "commentId" = th."commentId"
                                          FOR UPDATE SKIP LOCKED);
    ELSE
      SELECT * INTO ent FROM commentv3_thread_entity(th);
      IF ent."entityType" IS NOT NULL THEN
        DELETE FROM "CommentTopicMute"
         WHERE "userId" = OLD."userId" AND "entityType" = ent."entityType" AND "entityId" = ent."entityId";
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  SELECT * INTO th FROM "Thread" WHERE id = NEW."threadId";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF th."commentId" IS NOT NULL THEN
    SELECT * INTO c FROM "CommentV2" WHERE id = th."commentId" FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v3_id := commentv3_mirror_v2(c);
    IF v3_id IS NULL THEN RETURN NULL; END IF;
    PERFORM 1 FROM "CommentV3" WHERE id = v3_id FOR KEY SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    INSERT INTO "CommentMute" ("userId", "commentId", "mutedAt")
    VALUES (NEW."userId", v3_id, NEW."mutedAt" AT TIME ZONE 'UTC')
    ON CONFLICT ("userId", "commentId") DO NOTHING;
  ELSE
    SELECT * INTO ent FROM commentv3_thread_entity(th);
    IF ent."entityType" IS NULL THEN RETURN NULL; END IF;
    INSERT INTO "CommentTopicMute" ("userId", "entityType", "entityId", "mutedAt")
    VALUES (NEW."userId", ent."entityType", ent."entityId", NEW."mutedAt" AT TIME ZONE 'UTC')
    ON CONFLICT ("userId", "entityType", "entityId") DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER commentv3_mirror
  AFTER INSERT OR DELETE
  ON "ThreadMute" FOR EACH ROW EXECUTE FUNCTION commentv3_mirror_thread_mute_trigger();

-- Creating a trigger needs EXECUTE on its function; firing one does not. Without this, any role owning
-- a table could attach a definer function and write CommentV3.
REVOKE EXECUTE ON FUNCTION
  commentv3_topic_comment_count(),
  commentv3_mirror_thread_trigger(),
  commentv3_mirror_v2_trigger(),
  commentv3_mirror_v1_trigger(),
  commentv3_mirror_v2_reaction_trigger(),
  commentv3_mirror_v1_reaction_trigger(),
  commentv3_mirror_v2_report_trigger(),
  commentv3_mirror_v1_report_trigger(),
  commentv3_mirror_thread_mute_trigger()
FROM PUBLIC;

COMMIT;

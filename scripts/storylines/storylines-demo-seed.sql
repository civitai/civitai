-- Demo storyline "The Patch" for reviewing Storylines on a dev server. DEV ONLY.
--
-- Builds the storyline from posts the demo accounts already have; it never writes to "Post"
-- or "Image". Re-running it changes nothing. Undo with storylines-demo-cleanup.sql.
--
--   node .claude/skills/postgres-query/query.mjs --dev --writable --file scripts/storylines/storylines-demo-seed.sql
--
-- Shape: four chapters on the main path alternating owner and collaborator, then continuations
-- of the last one: canon by the owner, endorsed by the collaborator, one rated above the
-- storyline's ceiling (readers see it only as a placeholder), and a community one when a third
-- account is named.
--
-- It does not create posts: inserting "Image" rows queues them for scanning.

DO $$
DECLARE
  owner_name CONSTANT text := 'CivBot';
  collaborator_name CONSTANT text := 'CivChan';
  -- Leave empty to seed without a community continuation.
  community_name CONSTANT text := '';
  story_title CONSTANT text := 'The Patch';
  -- PG-13. A single NsfwLevel flag.
  ceiling CONSTANT int := 2;

  owner_id int;
  collaborator_id int;
  community_id int;
  story_id int;
  owner_posts int[];
  collaborator_posts int[];
  community_posts int[];
  above_ceiling_post int;
  main_posts int[];
  chapter_ids int[] := '{}';
  new_chapter int;
  parent_chapter int;
  i int;
BEGIN
  -- Fails closed: any server whose cluster_name does not end in "-dev" is refused, including
  -- one that does not set cluster_name at all.
  IF coalesce(current_setting('cluster_name', true), '') NOT LIKE '%-dev' THEN
    RAISE EXCEPTION 'storylines demo seed: refusing to run, cluster_name is "%" (expected *-dev)',
      coalesce(current_setting('cluster_name', true), '');
  END IF;

  SELECT id INTO owner_id FROM "User" WHERE username = owner_name AND "deletedAt" IS NULL;
  SELECT id INTO collaborator_id FROM "User" WHERE username = collaborator_name AND "deletedAt" IS NULL;
  IF owner_id IS NULL OR collaborator_id IS NULL THEN
    RAISE EXCEPTION 'storylines demo seed: accounts % / % not found', owner_name, collaborator_name;
  END IF;
  IF community_name <> '' THEN
    SELECT id INTO community_id FROM "User" WHERE username = community_name AND "deletedAt" IS NULL;
    IF community_id IS NULL THEN
      RAISE EXCEPTION 'storylines demo seed: account % not found', community_name;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "Storyline" WHERE "userId" = owner_id AND title = story_title) THEN
    RAISE NOTICE 'storylines demo seed: "%" already exists for %, nothing to do', story_title, owner_name;
    RETURN;
  END IF;

  -- Public, live posts at or under the ceiling that are not already a chapter somewhere. Every
  -- post the seed picks must pass the same visibility filters.
  SELECT array_agg(id ORDER BY "publishedAt", id) INTO owner_posts FROM "Post" p
  WHERE p."userId" = owner_id AND p."publishedAt" <= now()
    AND NOT p."tosViolation" AND NOT p.unlisted AND p.availability = 'Public'
    AND p."nsfwLevel" > 0 AND p."nsfwLevel" < ceiling * 2
    AND NOT EXISTS (SELECT 1 FROM "StorylineChapter" c WHERE c."postId" = p.id);
  SELECT array_agg(id ORDER BY "publishedAt", id) INTO collaborator_posts FROM "Post" p
  WHERE p."userId" = collaborator_id AND p."publishedAt" <= now()
    AND NOT p."tosViolation" AND NOT p.unlisted AND p.availability = 'Public'
    AND p."nsfwLevel" > 0 AND p."nsfwLevel" < ceiling * 2
    AND NOT EXISTS (SELECT 1 FROM "StorylineChapter" c WHERE c."postId" = p.id);
  IF coalesce(array_length(owner_posts, 1), 0) < 3 OR coalesce(array_length(collaborator_posts, 1), 0) < 3 THEN
    RAISE EXCEPTION 'storylines demo seed: need 3 posts at or under the ceiling from each of % and %',
      owner_name, collaborator_name;
  END IF;
  IF community_id IS NOT NULL THEN
    SELECT array_agg(id ORDER BY "publishedAt", id) INTO community_posts FROM "Post" p
    WHERE p."userId" = community_id AND p."publishedAt" <= now()
      AND NOT p."tosViolation" AND NOT p.unlisted AND p.availability = 'Public'
      AND p."nsfwLevel" > 0 AND p."nsfwLevel" < ceiling * 2
      AND NOT EXISTS (SELECT 1 FROM "StorylineChapter" c WHERE c."postId" = p.id);
    IF community_posts IS NULL THEN
      RAISE EXCEPTION 'storylines demo seed: % has no post at or under the ceiling', community_name;
    END IF;
  END IF;

  SELECT id INTO above_ceiling_post FROM "Post" p
  WHERE p."userId" IN (owner_id, collaborator_id) AND p."publishedAt" <= now()
    AND NOT p."tosViolation" AND NOT p.unlisted AND p.availability = 'Public'
    AND p."nsfwLevel" >= ceiling * 2
    -- 32 is the Blocked flag: never attach blocked content, even to demonstrate a refusal.
    AND (p."nsfwLevel" & 32) = 0
    AND NOT EXISTS (SELECT 1 FROM "StorylineChapter" c WHERE c."postId" = p.id)
  ORDER BY p."publishedAt", p.id LIMIT 1;
  IF above_ceiling_post IS NULL THEN
    RAISE EXCEPTION 'storylines demo seed: no post above the ceiling from % or %', owner_name, collaborator_name;
  END IF;

  INSERT INTO "Storyline" ("userId", title, "maxNsfwLevel", "updatedAt")
  VALUES (owner_id, story_title, ceiling, now())
  RETURNING id INTO story_id;

  INSERT INTO "StorylineCollaborator" ("storylineId", "userId") VALUES (story_id, collaborator_id);

  main_posts := ARRAY[owner_posts[1], collaborator_posts[1], owner_posts[2], collaborator_posts[2]];
  FOR i IN 1..4 LOOP
    INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
    SELECT story_id, p.id, p."userId", i - 1 FROM "Post" p WHERE p.id = main_posts[i]
    RETURNING id INTO new_chapter;
    IF i > 1 THEN
      INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
      VALUES (story_id, new_chapter, chapter_ids[i - 1], true);
    END IF;
    chapter_ids := chapter_ids || new_chapter;
  END LOOP;

  -- Continuations of the last main chapter. Only the owner's is canon; endorsed vs community
  -- is not stored, it follows the collaborator list.
  parent_chapter := chapter_ids[4];
  INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
  VALUES (story_id, owner_posts[3], owner_id, 4) RETURNING id INTO new_chapter;
  INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
  VALUES (story_id, new_chapter, parent_chapter, true);

  INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
  VALUES (story_id, collaborator_posts[3], collaborator_id, 4) RETURNING id INTO new_chapter;
  INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
  VALUES (story_id, new_chapter, parent_chapter, false);

  IF community_id IS NOT NULL THEN
    INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
    VALUES (story_id, community_posts[1], community_id, 4) RETURNING id INTO new_chapter;
    INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
    VALUES (story_id, new_chapter, parent_chapter, false);
  END IF;

  -- The submission path would refuse this one; it stands for a post re-rated upward after it
  -- was added.
  INSERT INTO "StorylineChapter" ("storylineId", "postId", "userId", depth)
  SELECT story_id, p.id, p."userId", 4 FROM "Post" p WHERE p.id = above_ceiling_post
  RETURNING id INTO new_chapter;
  INSERT INTO "StorylineChapterEdge" ("storylineId", "chapterId", "parentChapterId", canon)
  VALUES (story_id, new_chapter, parent_chapter, false);

  RAISE NOTICE 'storylines demo seed: created storyline %', story_id;
END
$$;

SELECT
  s.id AS "storylineId",
  c.id AS "chapterId",
  c.depth,
  c."postId",
  u.username AS author,
  e."parentChapterId",
  CASE
    WHEN e."parentChapterId" IS NULL THEN 'first'
    WHEN e.canon THEN 'canon'
    WHEN c."userId" = s."userId" OR sc."userId" IS NOT NULL THEN 'endorsed'
    ELSE 'community'
  END AS rank,
  p."nsfwLevel" > s."maxNsfwLevel" * 2 - 1 AS "aboveCeiling",
  -- Same order as storyline mode walks a post's images: a missing index counts as 0.
  (SELECT i.id FROM "Image" i WHERE i."postId" = c."postId" ORDER BY coalesce(i.index, 0), i.id LIMIT 1) AS "firstImageId",
  (SELECT i.id FROM "Image" i WHERE i."postId" = c."postId" ORDER BY coalesce(i.index, 0) DESC, i.id DESC LIMIT 1) AS "lastImageId"
FROM "Storyline" s
JOIN "StorylineChapter" c ON c."storylineId" = s.id
JOIN "User" u ON u.id = c."userId"
LEFT JOIN "Post" p ON p.id = c."postId"
LEFT JOIN "StorylineChapterEdge" e ON e."chapterId" = c.id
LEFT JOIN "StorylineCollaborator" sc ON sc."storylineId" = s.id AND sc."userId" = c."userId"
WHERE s.title = 'The Patch' AND s."userId" = (SELECT id FROM "User" WHERE username = 'CivBot')
ORDER BY c.depth, c.id;

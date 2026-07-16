-- Manual verification for the Image.sortAt triggers
-- (migration 20260716130000_image_sort_at_triggers /
--  programmability/image_post_triggers.sql).
--
-- Self-contained and NON-DESTRUCTIVE: everything runs inside a transaction that
-- ROLLs BACK at the end, so it can be run against any environment that already
-- has the triggers installed. It borrows one real User id (FK requirement) but
-- writes no permanent rows.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f verify-image-sort-at-triggers.sql
--
-- Every case ASSERTs the expected sortAt; a failure aborts with the case name.
-- sortAt = GREATEST(post.publishedAt, image.scannedAt, image.createdAt), with
-- GREATEST ignoring NULLs (draft/unpublished/postless -> GREATEST(scannedAt,
-- createdAt)).

BEGIN;

DO $$
DECLARE
  uid          int;
  draft_post   int;
  pub_post     int;
  other_post   int;
  img          int;
  created      timestamptz := '2024-01-01 00:00:00Z';
  scanned      timestamptz := '2024-02-01 00:00:00Z';  -- > createdAt
  publish_past timestamptz := '2024-06-01 00:00:00Z';  -- > scannedAt
  reschedule   timestamptz := now() + interval '30 days';
  got          timestamptz;
BEGIN
  SELECT id INTO uid FROM "User" LIMIT 1;
  IF uid IS NULL THEN RAISE EXCEPTION 'no User rows to borrow for FK'; END IF;

  -- Fixtures: one draft post (publishedAt NULL), one already-published post.
  INSERT INTO "Post" ("userId", "publishedAt", "createdAt", "updatedAt")
    VALUES (uid, NULL, created, now()) RETURNING id INTO draft_post;
  INSERT INTO "Post" ("userId", "publishedAt", "createdAt", "updatedAt")
    VALUES (uid, publish_past, created, now()) RETURNING id INTO pub_post;

  -- CASE 1 — insert image on a DRAFT post (publishedAt NULL).
  --   expect GREATEST(NULL, scanned, created) = scanned
  INSERT INTO "Image" ("url", "userId", "postId", "scannedAt", "createdAt", "updatedAt")
    VALUES ('v', uid, draft_post, scanned, created, now()) RETURNING id INTO img;
  SELECT "sortAt" INTO got FROM "Image" WHERE id = img;
  ASSERT got = scanned, format('CASE 1 draft insert: got %s, want %s', got, scanned);

  -- CASE 2 — publish the draft (Post.publishedAt NULL -> past) via the Post trigger.
  --   expect GREATEST(publish_past, scanned, created) = publish_past
  UPDATE "Post" SET "publishedAt" = publish_past WHERE id = draft_post;
  SELECT "sortAt" INTO got FROM "Image" WHERE id = img;
  ASSERT got = publish_past, format('CASE 2 publish: got %s, want %s', got, publish_past);

  -- CASE 3 — reschedule to the FUTURE (Post trigger restamps).
  --   expect GREATEST(future, scanned, created) = future
  UPDATE "Post" SET "publishedAt" = reschedule WHERE id = draft_post;
  SELECT "sortAt" INTO got FROM "Image" WHERE id = img;
  ASSERT got = reschedule, format('CASE 3 reschedule: got %s, want %s', got, reschedule);

  -- CASE 4 — unpublish (Post.publishedAt -> NULL via the Post trigger).
  --   expect GREATEST(NULL, scanned, created) = scanned
  UPDATE "Post" SET "publishedAt" = NULL WHERE id = draft_post;
  SELECT "sortAt" INTO got FROM "Image" WHERE id = img;
  ASSERT got = scanned, format('CASE 4 unpublish: got %s, want %s', got, scanned);

  -- CASE 5 — scannedAt bump AFTER unpublish (Image BEFORE trigger recomputes).
  --   new scanned pushed past the others; publishedAt still NULL.
  UPDATE "Image" SET "scannedAt" = scanned + interval '10 days' WHERE id = img;
  SELECT "sortAt" INTO got FROM "Image" WHERE id = img;
  ASSERT got = scanned + interval '10 days',
    format('CASE 5 scannedAt bump: got %s, want %s', got, scanned + interval '10 days');

  -- CASE 6 — insert image directly on an ALREADY-published post (BEFORE trigger
  -- reads Post.publishedAt).
  --   expect GREATEST(publish_past, scanned, created) = publish_past
  INSERT INTO "Image" ("url", "userId", "postId", "scannedAt", "createdAt", "updatedAt")
    VALUES ('v', uid, pub_post, scanned, created, now()) RETURNING id INTO img;
  SELECT "sortAt" INTO got FROM "Image" WHERE id = img;
  ASSERT got = publish_past, format('CASE 6 insert on published: got %s, want %s', got, publish_past);

  -- CASE 7 — move the image to a DRAFT post (postId change; BEFORE trigger
  -- recomputes from the NEW post, publishedAt NULL).
  --   expect GREATEST(NULL, scanned, created) = scanned
  INSERT INTO "Post" ("userId", "publishedAt", "createdAt", "updatedAt")
    VALUES (uid, NULL, created, now()) RETURNING id INTO other_post;
  UPDATE "Image" SET "postId" = other_post WHERE id = img;
  SELECT "sortAt" INTO got FROM "Image" WHERE id = img;
  ASSERT got = scanned, format('CASE 7 postId move: got %s, want %s', got, scanned);

  RAISE NOTICE 'ALL 7 CASES PASSED';
END $$;

ROLLBACK;

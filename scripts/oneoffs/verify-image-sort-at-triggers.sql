-- Manual verification for the Image.sortAt triggers
-- (migrations 20260716130000_image_sort_at_triggers +
--  20260716140000_sortat_trigger_all_updates /
--  programmability/image_post_triggers.sql).
--
-- Runs inside a transaction that ROLLs BACK at the end. It borrows one real User
-- id (FK requirement) but writes no permanent rows.
--
-- DEV-ONLY: creates a tx-scoped audit trigger on "Image" and (CASE 11) briefly
-- DISABLEs/ENABLEs the sortAt trigger to inject a stale value. Never run against
-- prod.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f verify-image-sort-at-triggers.sql
--
-- Every case ASSERTs the expected sortAt; a failure aborts with the case name.
-- sortAt = GREATEST(post.publishedAt, image.scannedAt, image.createdAt), with
-- GREATEST ignoring NULLs (draft/unpublished/postless -> GREATEST(scannedAt,
-- createdAt)). The BEFORE trigger fires on EVERY Image write (all-updates).

BEGIN;

-- Recursion / double-write observer (tx-scoped; removed on ROLLBACK). Records
-- every Image row-version change so CASE 9 can assert a Post publishedAt fan-out
-- touches each image EXACTLY once — i.e. the fan-out's sortAt UPDATE does not
-- re-fire the Image BEFORE trigger into a cascade.
CREATE TABLE _sortat_audit (image_id int, seen_at timestamptz DEFAULT clock_timestamp());
CREATE FUNCTION _sortat_audit_fn() RETURNS trigger AS
$$ BEGIN INSERT INTO _sortat_audit(image_id) VALUES (NEW.id); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER _zzz_sortat_audit AFTER UPDATE ON "Image" FOR EACH ROW EXECUTE FUNCTION _sortat_audit_fn();

DO $$
DECLARE
  uid          int;
  draft_post   int;
  pub_post     int;
  other_post   int;
  img          int;
  audit_img    int;
  reg_post     int;
  reg_img      int;
  stale_post   int;
  stale_img    int;
  n            bigint;
  created      timestamptz := '2024-01-01 00:00:00Z';
  scanned      timestamptz := '2024-02-01 00:00:00Z';  -- > createdAt
  scanned_late timestamptz := '2025-06-01 00:00:00Z';  -- > publish_past
  publish_past timestamptz := '2024-06-01 00:00:00Z';  -- > scannedAt
  reschedule   timestamptz := now() + interval '30 days';
  sentinel_upd timestamptz := '2000-01-01 00:00:00Z';
  got          timestamptz;
  got_upd      timestamptz;
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

  -- CASE 8 — move the image onto an already-PUBLISHED post (postId change; the
  -- BEFORE trigger recomputes from the NEW post's publishedAt).
  --   img: scannedAt=scanned, createdAt=created; pub_post.publishedAt=publish_past
  --   expect GREATEST(publish_past, scanned, created) = publish_past
  UPDATE "Image" SET "postId" = pub_post WHERE id = img;
  SELECT "sortAt" INTO got FROM "Image" WHERE id = img;
  ASSERT got = publish_past, format('CASE 8 postId move to published: got %s, want %s', got, publish_past);

  -- CASE 9 — recursion / double-write non-fire. Publish a fresh single-image
  -- draft and assert the fan-out produced EXACTLY one Image row-version. The Post
  -- fan-out UPDATE now DOES re-fire the all-updates BEFORE trigger, but a BEFORE
  -- trigger only mutates NEW in place (no new UPDATE), so it must not add a second
  -- row-version — a count > 1 would mean a real cascade.
  INSERT INTO "Post" ("userId", "publishedAt", "createdAt", "updatedAt")
    VALUES (uid, NULL, created, now()) RETURNING id INTO other_post;
  INSERT INTO "Image" ("url", "userId", "postId", "scannedAt", "createdAt", "updatedAt")
    VALUES ('v', uid, other_post, scanned, created, now()) RETURNING id INTO audit_img;
  DELETE FROM _sortat_audit;                         -- ignore the insert-path noise
  UPDATE "Post" SET "publishedAt" = publish_past WHERE id = other_post;  -- one fan-out
  SELECT count(*) INTO n FROM _sortat_audit WHERE image_id = audit_img;
  ASSERT n = 1, format('CASE 9 recursion non-fire: image updated %s times on one publish, want 1', n);
  SELECT "sortAt" INTO got FROM "Image" WHERE id = audit_img;
  ASSERT got = publish_past, format('CASE 9 fan-out value: got %s, want %s', got, publish_past);

  -- CASE 10 — unconditional bump regression (the fix for zuri's finding): an
  -- unpublish that leaves sortAt UNCHANGED must still bump updatedAt so Meili's
  -- incremental sync (WHERE updatedAt > lastUpdate) re-syncs the publish state.
  -- Image with scannedAt > publishedAt ⇒ sortAt = scannedAt both before and
  -- after unpublish. A guarded (IS DISTINCT FROM) fan-out would skip the row and
  -- leave updatedAt stale — this asserts it does NOT.
  INSERT INTO "Post" ("userId", "publishedAt", "createdAt", "updatedAt")
    VALUES (uid, publish_past, created, now()) RETURNING id INTO reg_post;
  INSERT INTO "Image" ("url", "userId", "postId", "scannedAt", "createdAt", "updatedAt")
    VALUES ('v', uid, reg_post, scanned_late, created, now()) RETURNING id INTO reg_img;
  ASSERT (SELECT "sortAt" FROM "Image" WHERE id = reg_img) = scanned_late,
    'CASE 10 setup: sortAt should be scanned_late';
  UPDATE "Image" SET "updatedAt" = sentinel_upd WHERE id = reg_img;  -- BEFORE trigger re-fires, recomputes same sortAt (scanned_late is the max)
  UPDATE "Post" SET "publishedAt" = NULL WHERE id = reg_post;        -- unpublish; sortAt stays scanned_late
  SELECT "sortAt", "updatedAt" INTO got, got_upd FROM "Image" WHERE id = reg_img;
  ASSERT got = scanned_late, format('CASE 10 sortAt should be unchanged: got %s, want %s', got, scanned_late);
  ASSERT got_upd <> sentinel_upd, 'CASE 10 REGRESSION: updatedAt not bumped on sortAt-unchanged unpublish (Meili would miss it)';

  -- CASE 11 — ALL-UPDATES repair of a STALE sortAt (the ~92M no-backfill rows).
  -- Simulate a pre-existing stale row by injecting a bogus sortAt with the BEFORE
  -- trigger disabled, then prove an UNRELATED column edit (nsfwLevel) recomputes
  -- it correct-on-write. A column-listed {scannedAt,postId} trigger would leave it
  -- stale, and the downstream sync trigger would emit the garbage value.
  INSERT INTO "Post" ("userId", "publishedAt", "createdAt", "updatedAt")
    VALUES (uid, publish_past, created, now()) RETURNING id INTO stale_post;
  INSERT INTO "Image" ("url", "userId", "postId", "scannedAt", "createdAt", "updatedAt")
    VALUES ('v', uid, stale_post, scanned, created, now()) RETURNING id INTO stale_img;
  ALTER TABLE "Image" DISABLE TRIGGER image_sort_at_before;
  UPDATE "Image" SET "sortAt" = '1999-01-01Z' WHERE id = stale_img;   -- inject stale value
  ALTER TABLE "Image" ENABLE TRIGGER image_sort_at_before;
  ASSERT (SELECT "sortAt" FROM "Image" WHERE id = stale_img) = '1999-01-01Z'::timestamptz,
    'CASE 11 setup: stale sortAt not injected';
  UPDATE "Image" SET "nsfwLevel" = 5 WHERE id = stale_img;            -- unrelated edit, no sortAt/scannedAt/postId
  SELECT "sortAt" INTO got FROM "Image" WHERE id = stale_img;
  ASSERT got = publish_past,
    format('CASE 11 stale repair: unrelated edit left sortAt %s, want %s (all-updates recompute)', got, publish_past);

  RAISE NOTICE 'ALL 11 CASES PASSED';
END $$;

ROLLBACK;

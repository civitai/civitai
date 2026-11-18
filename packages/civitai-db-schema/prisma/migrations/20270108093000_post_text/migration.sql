-- Storylines: text items in a post's reading order (PostText). Held text, and the post that holds
-- it, cannot be deleted until the hold is released: a text is held while its CSAM hold is pending,
-- or confirmed with no CSAM report quoting its post (`csamHeld`); while a CSAM report that still holds
-- (pending, not yet archived, or sent within the year) names its author or quotes its post; or
-- while an evidence hold covers its author. The trigger refuses every delete of such a row,
-- including the cascade from "Post" and raw SQL. Its Comment v3 thread is
-- 20270108094000_post_text_comment_type, applied later.
--
-- MANUAL APPLY, per environment, BEFORE the PR that reads it merges. Applying early is safe for the
-- running code: nothing deployed reads or writes "PostText". Needs "CsamReport"; reads the
-- "EvidenceHeldUser" view while it exists.
--
-- Apply statement by statement (psql autocommit, the default), off-peak, and re-run a statement that
-- times out. Every step is re-runnable.
--   Step 1 creates the table and its index (the FK briefly locks "Post").
--   Step 2 creates the hold check and the delete trigger on the new, empty table.
SET lock_timeout = '3s';

-- 1. Table.
CREATE TABLE IF NOT EXISTS "PostText" (
  "id"        SERIAL NOT NULL,
  "postId"    INTEGER NOT NULL,
  "userId"    INTEGER NOT NULL,
  "index"     INTEGER NOT NULL,
  "content"   TEXT NOT NULL,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  "refused"   BOOLEAN NOT NULL DEFAULT false,
  "csamHeld"  BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PostText_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PostText_postId_index_idx" ON "PostText" ("postId", "index");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostText_postId_fkey') THEN
    ALTER TABLE "PostText" ADD CONSTRAINT "PostText_postId_fkey"
      FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 2. Held text is kept. An earlier three-argument version is dropped, so no looser one stays.
DROP FUNCTION IF EXISTS post_text_held(BOOLEAN, INTEGER, INTEGER);
-- post_text_held is also what the app asks before a delete
-- (src/server/services/post-text-hold.ts), so the two refuse the same rows.
CREATE OR REPLACE FUNCTION post_text_held(
  text_id INTEGER, csam_held BOOLEAN, post_id INTEGER, author_id INTEGER
)
RETURNS boolean AS $$
DECLARE
  marked BOOLEAN := false;
BEGIN
  -- `csamHeld` keeps the text from readers for good; as a delete hold it stands until a moderator
  -- confirms the hold AND a CSAM report captured the post's text after the hold was raised. From
  -- then on that report's own retention (below) holds the text, and ends when the report stops
  -- holding. An older report, or one on the author or a comment alone, never captured this text.
  IF csam_held AND (
    EXISTS (
      SELECT 1 FROM "TextScanHold" h
      WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
        AND h.status = 'Pending'
    )
    OR NOT EXISTS (
      SELECT 1 FROM "TextScanHold" h
      WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
        AND h.status = 'Confirmed'
    )
    OR NOT EXISTS (
      -- The post's text as a report captured it after the hold was raised, so with this text in it.
      SELECT 1
      FROM "TextScanHold" h
      JOIN "CsamReport" r ON jsonb_typeof(r.details -> 'contextText') = 'array'
      CROSS JOIN LATERAL jsonb_array_elements(r.details -> 'contextText') c
      WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
        AND h.status = 'Confirmed'
        AND c ->> 'source' = 'postDescription'
        AND c ->> 'postId' = post_id::text
        AND (c ->> 'capturedAt') ~ '^\d{4}-\d{2}-\d{2}T'
        -- setText refuses a held text from the hold's detection on, so a capture taken at or after
        -- the hold's createdAt includes the held text.
        AND (c ->> 'capturedAt')::timestamptz >= h."createdAt" AT TIME ZONE 'UTC'
    )
  ) THEN
    RETURN true;
  END IF;
  -- A report holds while pending, not yet archived, or sent within the year (`reportHolds` in
  -- src/server/utils/legal-hold.ts), naming the author or quoting the post.
  IF EXISTS (
    SELECT 1 FROM "CsamReport" r
    WHERE (r."reportSentAt" IS NULL OR r."archivedAt" IS NULL
           OR r."reportSentAt" > now() - interval '1 year')
      AND (
        r."userId" = author_id
        OR r.details ->> 'secondaryUserId' = author_id::text
        OR (jsonb_typeof(r.details -> 'contextText') = 'array'
            AND r.details -> 'contextText' @> jsonb_build_array(jsonb_build_object('postId', post_id)))
      )
  ) THEN
    RETURN true;
  END IF;
  -- An evidence hold on the author, while that view exists. Its table without the view is a schema
  -- mid-change: every text is held, as the app's own fallback does. With neither, the reports above
  -- decide, and each database session warns once that the view is gone.
  IF to_regclass('public."EvidenceHeldUser"') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = $1)'
      INTO marked USING author_id;
  ELSIF to_regclass('public."EvidenceHold"') IS NOT NULL THEN
    RETURN true;
  ELSIF current_setting('post_text_held.warned', true) IS DISTINCT FROM 't' THEN
    RAISE WARNING 'post_text_held: "EvidenceHeldUser" is missing; evidence holds are not checked';
    PERFORM set_config('post_text_held.warned', 't', false);
  END IF;
  RETURN marked;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION post_text_keep_held() RETURNS trigger AS $$
BEGIN
  IF post_text_held(OLD."id", OLD."csamHeld", OLD."postId", OLD."userId") THEN
    RAISE EXCEPTION 'PostText % cannot be deleted while it is held', OLD."id";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS post_text_keep_held ON "PostText";
CREATE TRIGGER post_text_keep_held BEFORE DELETE ON "PostText"
  FOR EACH ROW EXECUTE FUNCTION post_text_keep_held();

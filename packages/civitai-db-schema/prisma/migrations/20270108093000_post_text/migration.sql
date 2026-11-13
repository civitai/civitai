-- Storylines: text items in a post's reading order (PostText). Held text, and the post that holds
-- it, cannot be deleted until the hold is released: a text is held while its CSAM hold is pending
-- (`csamHeld`), while an unsent CSAM report names its author or quotes its post, or while an evidence
-- hold covers its author. The trigger refuses every delete of such a row, including the cascade from
-- "Post" and raw SQL. Its Comment v3 thread is 20270108094000_post_text_comment_type, applied later.
--
-- MANUAL APPLY, per environment, BEFORE the PR that reads it merges. Applying early is safe for the
-- running code: nothing deployed reads or writes "PostText". Needs "CsamReport" and the
-- "EvidenceHeldUser" view (20261019220000_evidence_hold).
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

-- 2. Held text is kept. post_text_held is also what the app asks before a delete
-- (src/server/services/post-text-hold.ts), so the two refuse the same rows.
CREATE OR REPLACE FUNCTION post_text_held(csam_held BOOLEAN, post_id INTEGER, author_id INTEGER)
RETURNS boolean AS $$
  SELECT csam_held
    OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = author_id)
    OR EXISTS (
      SELECT 1 FROM "CsamReport" r
      WHERE r."reportSentAt" IS NULL
        AND (
          r."userId" = author_id
          OR r.details ->> 'secondaryUserId' = author_id::text
          OR (jsonb_typeof(r.details -> 'contextText') = 'array'
              AND r.details -> 'contextText' @> jsonb_build_array(jsonb_build_object('postId', post_id)))
        )
    );
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION post_text_keep_held() RETURNS trigger AS $$
BEGIN
  IF post_text_held(OLD."csamHeld", OLD."postId", OLD."userId") THEN
    RAISE EXCEPTION 'PostText % cannot be deleted while it is held', OLD."id";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS post_text_keep_held ON "PostText";
CREATE TRIGGER post_text_keep_held BEFORE DELETE ON "PostText"
  FOR EACH ROW EXECUTE FUNCTION post_text_keep_held();

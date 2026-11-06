-- Archived comments kept under the evidence hold: a third kept table beside "EvidenceHoldImage"
-- and "EvidenceHoldPost", filled once from the `archive` schema by
-- evidence_hold_keep_archived_comments().
--
-- Apply after 20261019220000_evidence_hold. Creates no rows. Hand-applied; the copy is a separate
-- step: SELECT evidence_hold_keep_archived_comments();

-- The report part of "held", one "userId" text per row: the same set as `legalHoldUserIdsSql` in
-- src/server/utils/legal-hold.ts, kept identical by evidence-hold-comment.behavior.test.ts.
CREATE OR REPLACE FUNCTION evidence_hold_report_named_users() RETURNS SETOF text AS $$
  WITH holding AS (
    SELECT r."userId", r.details FROM "CsamReport" r
    WHERE r."reportSentAt" IS NULL
       OR r."archivedAt" IS NULL
       OR r."reportSentAt" > now() - interval '1 year'
  )
  SELECT "userId"::text FROM holding WHERE "userId" IS NOT NULL
  UNION
  SELECT details ->> 'secondaryUserId' FROM holding WHERE details ->> 'secondaryUserId' IS NOT NULL;
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;

-- Held for the comment table: an active marker, or named on a report that still holds. For one
-- owner; a statement over many rows uses the set above once instead.
CREATE OR REPLACE FUNCTION evidence_hold_comment_owner_held(uid INTEGER) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = uid)
      OR uid::text IN (SELECT evidence_hold_report_named_users());
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;

-- A comment as it was in the archive. `thread` is its thread row, so what it was posted on survives
-- the archive.
CREATE TABLE "EvidenceHoldComment" (
  "commentId" INTEGER PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "threadId" INTEGER,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3),
  "nsfw" BOOLEAN,
  "tosViolation" BOOLEAN,
  "hidden" BOOLEAN,
  "metadata" JSONB,
  "thread" JSONB,
  "source" TEXT NOT NULL,
  "keptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "EvidenceHoldComment_userId_idx" ON "EvidenceHoldComment" ("userId");

-- As evidence_hold_guard_kept, with the comment table's definition of held.
CREATE OR REPLACE FUNCTION evidence_hold_guard_kept_comment() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% % cannot change', TG_TABLE_NAME, OLD."userId";
  END IF;
  IF evidence_hold_comment_owner_held(OLD."userId") THEN
    RAISE EXCEPTION '% row cannot be deleted while its owner is held', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER "EvidenceHoldComment_guard"
BEFORE UPDATE OR DELETE ON "EvidenceHoldComment"
FOR EACH ROW EXECUTE FUNCTION evidence_hold_guard_kept_comment();

CREATE TRIGGER "EvidenceHoldComment_refuse_truncate"
BEFORE TRUNCATE ON "EvidenceHoldComment"
FOR EACH STATEMENT EXECUTE FUNCTION evidence_hold_refuse_truncate();

-- As in 20261019220000_evidence_hold, plus the comment table.
CREATE OR REPLACE FUNCTION evidence_hold_purge_unheld(target_user INTEGER DEFAULT NULL) RETURNS void AS $$
  DELETE FROM "EvidenceHoldPost" p
  WHERE (target_user IS NULL OR p."userId" = target_user)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = p."userId");
  DELETE FROM "EvidenceHoldImage" i
  WHERE (target_user IS NULL OR i."userId" = target_user)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = i."userId");
  DELETE FROM "EvidenceHoldComment" c
  WHERE (target_user IS NULL OR c."userId" = target_user)
    AND NOT EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = c."userId")
    AND c."userId"::text NOT IN (SELECT evidence_hold_report_named_users());
$$ LANGUAGE sql SET search_path = public, pg_temp;

-- The copy. Idempotent: a comment already kept is skipped. Returns the rows it added. plpgsql, so
-- it can be created where the `archive` schema does not exist.
CREATE OR REPLACE FUNCTION evidence_hold_keep_archived_comments() RETURNS integer AS $$
DECLARE
  added integer;
BEGIN
  WITH held AS MATERIALIZED (
    SELECT "userId"::text AS uid FROM "EvidenceHeldUser"
    UNION
    SELECT evidence_hold_report_named_users()
  )
  INSERT INTO "EvidenceHoldComment" (
    "commentId", "userId", "threadId", "content", "createdAt", "updatedAt", "nsfw",
    "tosViolation", "hidden", "metadata", "thread", "source"
  )
  SELECT c."id", c."userId", c."threadId", c."content", c."createdAt", c."updatedAt", c."nsfw",
         c."tosViolation", c."hidden", c."metadata", to_jsonb(t), 'archive'
  FROM archive."CommentV2" c
  JOIN held h ON h.uid = c."userId"::text
  LEFT JOIN archive."Thread" t ON t."id" = c."threadId"
  ON CONFLICT ("commentId") DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

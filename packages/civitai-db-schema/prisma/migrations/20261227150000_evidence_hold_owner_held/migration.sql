-- An owner's content is kept while ANY hold on the account stands, not only while an evidence-hold
-- marker does: a deleted image or post of such an owner is kept and taken off the site, what a hold
-- kept stays recorded until no hold of any kind remains, and a held owner's model, image or post
-- cannot be moved to another account.
--
-- Apply AFTER 20261227140000_evidence_hold_owner_held_indexes (the function relies on its indexes),
-- and after 20261019220000_evidence_hold and 20261204120000_evidence_hold_image_prior_state, whose
-- functions this replaces. Hand-applied. Dry run: the whole file inside BEGIN; ... ROLLBACK;.
--
-- Before applying it, carry 20261231120100_feedback_capture_owner_hold's feedback capture clause
-- into evidence_hold_keep_image below and skip owner -2 in the image legs of evidence_hold_owner_held
-- (as `holdLegsSql` does), or captures lose their keep. Carry
-- 20261231130100_feedback_capture_hold_lifetime's capture clauses into evidence_hold_purge_unheld and
-- evidence_hold_guard_kept below too.
--
-- Until those clauses are carried in, the block below refuses this file on a database that has the
-- capture migrations (applied as written, it would drop every capture clause). Remove the block in
-- the same change that carries them. Apply as one transaction
-- (psql -v ON_ERROR_STOP=1 --single-transaction -f migration.sql) so the refusal stops the file.
DO $$
BEGIN
  IF to_regprocedure('evidence_hold_capture_held(integer,text,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION '20261227150000_evidence_hold_owner_held does not yet carry the feedback capture clauses of 20261231120100 and 20261231130100: carry them in, and remove this block, before applying it';
  END IF;
END $$;

-- Whether owner `uid` is held. The same answer as `ownerHeldSql` in
-- src/server/services/legal-hold.service.ts (every account hold, the placeholder owner, the marker),
-- written per owner so a row trigger can run it; evidence-hold-owner-held.behavior.test.ts keeps the
-- two identical.
CREATE OR REPLACE FUNCTION evidence_hold_owner_held(uid INTEGER) RETURNS boolean AS $$
  SELECT uid = -1
    -- An active marker.
    OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" h WHERE h."userId" = uid)
    -- Named on a report that still holds: pending, not yet archived, or sent within the year.
    OR EXISTS (
      SELECT 1 FROM "CsamReport" r
      WHERE (r."userId" = uid OR r.details ->> 'secondaryUserId' = uid::text)
        AND (r."reportSentAt" IS NULL OR r."archivedAt" IS NULL
             OR r."reportSentAt" > now() - interval '1 year')
    )
    -- An image of theirs awaiting review.
    OR EXISTS (SELECT 1 FROM "Image" hr WHERE hr."userId" = uid AND hr."needsReview" = 'csam')
    -- A blocked image of theirs that no sent report naming them lists.
    OR EXISTS (
      SELECT 1 FROM "Image" bi
      WHERE bi."userId" = uid AND bi."blockedFor" = 'CSAM'
        AND NOT EXISTS (
          SELECT 1 FROM "CsamReport" sc
          WHERE (sc."userId" = uid OR sc.details ->> 'secondaryUserId' = uid::text)
            AND sc."reportSentAt" IS NOT NULL
            AND sc.images @> jsonb_build_array(jsonb_build_object('id', bi.id))
        )
    )
    -- An image of theirs listed in a report that still holds, whoever the report names.
    OR EXISTS (
      SELECT 1
      FROM "CsamReport" rr
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rr.images) = 'array' THEN rr.images ELSE '[]'::jsonb END
      ) re
      JOIN "Image" ri
        ON ri.id = CASE WHEN (re ->> 'id') ~ '^[0-9]{1,18}$' THEN (re ->> 'id')::bigint END
      WHERE ri."userId" = uid
        AND (rr."reportSentAt" IS NULL OR rr."archivedAt" IS NULL
             OR rr."reportSentAt" > now() - interval '1 year')
    );
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;

-- evidence_hold_owner_held for the delete triggers, which run it once per row: one statement deleting
-- many rows of one owner (an account's content wipe) reuses the answer instead of re-reading it per
-- row. The answer is kept for this statement only, and for at most 5 seconds, so a hold placed while a
-- long delete runs is seen within 5 seconds. Anything unreadable in the memo means a fresh check.
CREATE OR REPLACE FUNCTION evidence_hold_owner_held_memo(uid INTEGER) RETURNS boolean AS $$
DECLARE
  -- A setting name part may not start with a digit or hold a '-'.
  memo_name text := 'evidence_hold.owner_' || CASE WHEN uid < 0 THEN 'n' || abs(uid::bigint)::text ELSE uid::text END;
  memo text[] := string_to_array(current_setting(memo_name, true), '|');
  held boolean;
BEGIN
  -- statement start | when checked, epoch seconds | t or f
  IF array_length(memo, 1) = 3
    AND memo[1] = statement_timestamp()::text
    AND memo[2] ~ '^[0-9]{1,12}(\.[0-9]{1,9})?$'
    AND memo[2]::numeric > extract(epoch FROM clock_timestamp()) - 5
    AND memo[2]::numeric <= extract(epoch FROM clock_timestamp())
    AND memo[3] IN ('t', 'f') THEN
    RETURN memo[3] = 't';
  END IF;
  held := evidence_hold_owner_held(uid);
  PERFORM set_config(
    memo_name,
    statement_timestamp()::text || '|' || extract(epoch FROM clock_timestamp())::text || '|'
      || CASE WHEN held THEN 't' ELSE 'f' END,
    true
  );
  RETURN held;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- As in 20261204120000_evidence_hold_image_prior_state, held by the function above.
CREATE OR REPLACE FUNCTION evidence_hold_keep_image() RETURNS trigger AS $$
DECLARE
  graced BOOLEAN := (OLD."metadata" -> 'accountDeletionPriorIngestion') IS NOT NULL;
BEGIN
  IF evidence_hold_owner_held_memo(OLD."userId") THEN
    IF pg_trigger_depth() > 1 THEN
      RAISE EXCEPTION 'Image % cannot be deleted', OLD."id";
    END IF;
    -- The first record stands: a later delete finds the image already out of its post.
    INSERT INTO "EvidenceHoldImage" (
      "imageId", "userId", "postId", "priorIngestion", "priorBlockedFor", "priorNsfwLevel"
    )
    VALUES (
      OLD."id",
      OLD."userId",
      OLD."postId",
      CASE WHEN graced THEN OLD."metadata" ->> 'accountDeletionPriorIngestion' ELSE OLD."ingestion"::text END,
      CASE WHEN graced THEN OLD."metadata" ->> 'accountDeletionPriorBlockedFor' ELSE OLD."blockedFor" END,
      OLD."nsfwLevel"
    )
    ON CONFLICT ("imageId") DO NOTHING;
    UPDATE "Image"
    SET "ingestion" = 'Blocked', "nsfwLevel" = 32, "blockedFor" = 'moderated', "updatedAt" = now()
    WHERE "id" = OLD."id" AND NOT (
      "ingestion" = 'Blocked' AND COALESCE("blockedFor", '') IN ('moderated', 'tos', 'CSAM')
    );
    UPDATE "Image" SET "postId" = NULL, "updatedAt" = now()
    WHERE "id" = OLD."id" AND "postId" IS NOT NULL;
    -- Kept counts as moderated, so the account-deletion markers go even on a row already blocked:
    -- restoring the account would otherwise put the image back (account-deletion-image-markers.ts).
    UPDATE "Image"
    SET "metadata" = "metadata" - 'accountDeletionPriorIngestion' - 'accountDeletionPriorBlockedFor'
    WHERE "id" = OLD."id" AND ("metadata" -> 'accountDeletionPriorIngestion') IS NOT NULL;
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- As in 20261019220000_evidence_hold, held by the function above.
CREATE OR REPLACE FUNCTION evidence_hold_keep_post() RETURNS trigger AS $$
BEGIN
  IF evidence_hold_owner_held_memo(OLD."userId") THEN
    INSERT INTO "EvidenceHoldPost" (
      "postId", "userId", "title", "detail", "createdAt", "publishedAt", "modelVersionId",
      "collectionId", "metadata"
    )
    VALUES (
      OLD."id", OLD."userId", OLD."title", OLD."detail", OLD."createdAt", OLD."publishedAt",
      OLD."modelVersionId", OLD."collectionId", OLD."metadata"
    )
    ON CONFLICT ("postId") DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- What a hold kept stays while any hold on its owner stands, so a kept record is deleted only once
-- the function above says no. As in 20261019220000_evidence_hold otherwise.
CREATE OR REPLACE FUNCTION evidence_hold_guard_kept() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% % cannot change', TG_TABLE_NAME, OLD."userId";
  END IF;
  IF evidence_hold_owner_held(OLD."userId") THEN
    RAISE EXCEPTION '% row cannot be deleted while its owner is held', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- The sweep and the release purge (evidence_hold_purge_on_release calls this) skip any owner still
-- held. As in 20261019220000_evidence_hold otherwise.
CREATE OR REPLACE FUNCTION evidence_hold_purge_unheld(target_user INTEGER DEFAULT NULL) RETURNS void AS $$
  DELETE FROM "EvidenceHoldPost" p
  WHERE (target_user IS NULL OR p."userId" = target_user)
    AND NOT evidence_hold_owner_held(p."userId");
  DELETE FROM "EvidenceHoldImage" i
  WHERE (target_user IS NULL OR i."userId" = target_user)
    AND NOT evidence_hold_owner_held(i."userId");
$$ LANGUAGE sql SET search_path = public, pg_temp;

-- A held owner's models, images and posts keep their owner, whatever the hold: moving a row to another
-- account would take it out of the hold. Rows of the placeholder owner can still move, as before:
-- restoring an account hands its models back from the placeholder. As in 20261019220000_evidence_hold
-- otherwise.
CREATE OR REPLACE FUNCTION evidence_hold_keep_owner() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
    AND OLD."userId" <> -1 AND evidence_hold_owner_held(OLD."userId") THEN
    RAISE EXCEPTION '% % cannot change owner', TG_TABLE_NAME, OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

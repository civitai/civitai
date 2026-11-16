-- Confirmed held PostText: a hold confirmed with the "none" report choice holds for one year from
-- `csamConfirmedAt`, then `post_text_held` stops holding it on that ground unless
-- `post_text_retention_skip` names a reason (any other hold still applies), and the
-- `purge-confirmed-csam-text` job deletes it. However the row goes, the delete trigger drops the hold's
-- copy of the text and its label-store snapshot with it.
--
-- MANUAL APPLY, per environment, BEFORE the PR that writes the column merges. Applying early is safe
-- for the running code: nothing deployed reads the column, and with it NULL `post_text_held` holds
-- exactly what it held before. Needs 20270108093000_post_text.
--
-- Apply statement by statement (psql autocommit, the default), off-peak. Every step is re-runnable.
SET lock_timeout = '3s';

-- 1. Column and index.
ALTER TABLE "PostText" ADD COLUMN IF NOT EXISTS "csamConfirmedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "PostText_csamConfirmedAt_idx" ON "PostText" ("csamConfirmedAt")
  WHERE "csamConfirmedAt" IS NOT NULL;

-- 2. Backfill from the latest confirmed hold's decision time, as `post_text_sync_csam_hold` sets it.
UPDATE "PostText" t
SET "csamConfirmedAt" = h."decidedAt"
FROM (
  SELECT "entityId", max("decidedAt") AS "decidedAt"
  FROM "TextScanHold"
  WHERE "entityType" = 'PostText' AND label = 'csam' AND status = 'Confirmed'
    AND "decidedAt" IS NOT NULL
  GROUP BY "entityId"
) h
WHERE h."entityId" = t."id" AND t."csamHeld" AND t."csamConfirmedAt" IS NULL;

-- 3. The hold check. Same signature, so the delete trigger and the app's callers are unchanged; the
-- confirmation time is read off the row, which a BEFORE DELETE trigger still sees.
CREATE OR REPLACE FUNCTION post_text_held(
  text_id INTEGER, csam_held BOOLEAN, post_id INTEGER, author_id INTEGER
)
RETURNS boolean AS $$
DECLARE
  marked BOOLEAN := false;
BEGIN
  -- `csamHeld` keeps the text from readers for good. As a delete hold it stands while the hold is
  -- pending, and once confirmed until a CSAM report captured the post's text after the hold was raised
  -- (from then on that report's own retention, below, holds it). A confirmation whose report choice
  -- was "none" holds for one year from `csamConfirmedAt`, and after it while
  -- `post_text_retention_skip` names a reason; any other choice, or none recorded, holds until the
  -- report is filed.
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
    OR (
      NOT EXISTS (
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
      AND NOT (
        EXISTS (
          SELECT 1 FROM "PostText" t
          WHERE t."id" = text_id
            AND t."csamConfirmedAt" IS NOT NULL
            AND t."csamConfirmedAt" <= (now() AT TIME ZONE 'UTC') - interval '1 year'
        )
        AND NOT EXISTS (
          SELECT 1 FROM "TextScanHold" h
          WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
            AND h.status = 'Confirmed'
            AND h.meta ->> 'reportChoice' IS DISTINCT FROM 'none'
        )
        AND post_text_retention_skip(post_id, author_id) IS NULL
      )
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

-- 4. What keeps a deleted text's copies past its retention. The purge job reports the same reasons.
CREATE OR REPLACE FUNCTION post_text_retention_skip(post_id INTEGER, author_id INTEGER)
RETURNS text AS $$
BEGIN
  IF post_id IS NULL OR author_id IS NULL THEN
    RETURN 'unknown-owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "CsamReport" r
    WHERE jsonb_typeof(r.details -> 'contextText') = 'array'
      AND r.details -> 'contextText' @> jsonb_build_array(jsonb_build_object('postId', post_id))
  ) THEN
    RETURN 'quoted-in-report';
  END IF;
  IF EXISTS (SELECT 1 FROM "Appeal" a WHERE a."userId" = author_id AND a.status = 'Pending') THEN
    RETURN 'pending-appeal';
  END IF;
  -- Any evidence hold row, released or not. Without the table, keep.
  IF to_regclass('public."EvidenceHold"') IS NULL THEN
    RETURN 'evidence-hold';
  END IF;
  IF EXISTS (SELECT 1 FROM "EvidenceHold" e WHERE e."userId" = author_id) THEN
    RETURN 'evidence-hold';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE SET search_path = public, pg_temp;

-- 5. The delete trigger: refuses a held text as before; a confirmed "none" text past its year takes its
-- hold copy and label-store snapshot with it, in the same statement.
CREATE OR REPLACE FUNCTION post_text_keep_held() RETURNS trigger AS $$
BEGIN
  IF post_text_held(OLD."id", OLD."csamHeld", OLD."postId", OLD."userId") THEN
    RAISE EXCEPTION 'PostText % cannot be deleted while it is held', OLD."id";
  END IF;
  IF OLD."csamHeld"
    AND OLD."csamConfirmedAt" IS NOT NULL
    AND OLD."csamConfirmedAt" <= (now() AT TIME ZONE 'UTC') - interval '1 year'
    AND NOT EXISTS (
      SELECT 1 FROM "TextScanHold" h
      WHERE h."entityType" = 'PostText' AND h."entityId" = OLD."id" AND h.label = 'csam'
        AND h.status = 'Confirmed'
        AND h.meta ->> 'reportChoice' IS DISTINCT FROM 'none'
    )
    AND post_text_retention_skip(OLD."postId", OLD."userId") IS NULL
  THEN
    UPDATE "TextScanHold" h
    -- Only the decision's own keys stay: the scan's reason, the moderator's note, `previous` and any
    -- scan key may carry the text. `decisionNotePurged` records that a note existed.
    SET "text" = '',
        "reason" = '',
        "decisionNote" = NULL,
        "meta" = jsonb_strip_nulls(jsonb_build_object(
          'decision', h."meta" -> 'decision',
          'reportChoice', h."meta" -> 'reportChoice',
          'kind', h."meta" -> 'kind',
          'priorHoldId', h."meta" -> 'priorHoldId',
          'decisionNotePurged', CASE WHEN coalesce(h."decisionNote", '') <> '' THEN true END,
          'retentionPurgedAt', now()
        ))
    WHERE h."entityType" = 'PostText' AND h."entityId" = OLD."id" AND h.label = 'csam'
      AND h.status = 'Confirmed';
    IF to_regprocedure('label_store.exclude(text,text,text)') IS NOT NULL THEN
      PERFORM label_store.exclude('post_text_text', OLD."id"::text, 'retention');
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- 6. A text's held flag and confirmation time, recomputed from all of its csam holds after each
-- decision: held while any hold is pending or confirmed, confirmed at the latest confirmation. So a
-- dismissal of one hold leaves what another hold gave.
CREATE OR REPLACE FUNCTION post_text_sync_csam_hold(text_id INTEGER)
RETURNS void AS $$
  UPDATE "PostText" t
  SET "csamHeld" = EXISTS (
        SELECT 1 FROM "TextScanHold" h
        WHERE h."entityType" = 'PostText' AND h."entityId" = t."id" AND h.label = 'csam'
          AND h.status IN ('Pending', 'Confirmed')
      ),
      "csamConfirmedAt" = (
        SELECT max(h."decidedAt") FROM "TextScanHold" h
        WHERE h."entityType" = 'PostText' AND h."entityId" = t."id" AND h.label = 'csam'
          AND h.status = 'Confirmed'
      ),
      "updatedAt" = now()
  WHERE t."id" = text_id;
$$ LANGUAGE sql VOLATILE SET search_path = public, pg_temp;

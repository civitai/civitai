-- Confirmed held PostText: a hold confirmed with the "none" report choice holds for one year from the
-- latest confirmation (`post_text_csam_confirmed_at`, read off its TextScanHold rows), then
-- `post_text_held` stops holding it on that ground unless
-- `post_text_retention_skip` names a reason (any other hold still applies), and the
-- `purge-confirmed-csam-text` job deletes it. However the row goes, the delete trigger drops the hold's
-- copy of the text and its label-store snapshot with it.
--
-- MANUAL APPLY, per environment, BEFORE the PR that records the report choice merges. Applying early is
-- safe for the running code: retention needs every confirmed hold to carry `meta.reportChoice = 'none'`,
-- which nothing deployed writes, so `post_text_held` holds exactly what it held before. Needs
-- 20270108093000_post_text.
--
-- Apply statement by statement (psql autocommit, the default), off-peak. Every step is re-runnable.
SET lock_timeout = '3s';

-- 1. The latest confirmation of a text's csam holds. Read off TextScanHold, not stored on PostText.
CREATE OR REPLACE FUNCTION post_text_csam_confirmed_at(text_id INTEGER)
RETURNS timestamp AS $$
  SELECT max(h."decidedAt") FROM "TextScanHold" h
  WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
    AND h.status = 'Confirmed';
$$ LANGUAGE sql STABLE SET search_path = public, pg_temp;

-- 2. The hold check. Same signature, so the delete trigger and the app's callers are unchanged.
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
  -- was "none" holds for one year from its latest confirmation, and after it while
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
        -- No confirmation time (a hold confirmed without one) never starts the year.
        coalesce(post_text_csam_confirmed_at(text_id) <= (now() AT TIME ZONE 'UTC') - interval '1 year', false)
        AND NOT EXISTS (
          SELECT 1 FROM "TextScanHold" h
          WHERE h."entityType" = 'PostText' AND h."entityId" = text_id AND h.label = 'csam'
            AND h.status = 'Confirmed'
            AND h.meta ->> 'reportChoice' IS DISTINCT FROM 'none'
        )
        AND post_text_retention_skip(post_id, author_id) IS NULL
        -- The purge needs this role to run `label_store.drop_label_notes`; without the grant the text
        -- stays held, as it did before this retention existed, rather than failing the delete midway.
        AND CASE WHEN to_regprocedure('label_store.drop_label_notes(text,text,text)') IS NULL THEN false
          ELSE has_function_privilege('label_store.drop_label_notes(text,text,text)', 'EXECUTE') END
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

-- 3. What keeps a deleted text's copies past its retention. The purge job reports the same reasons.
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

-- 4b. The moderator's note is also copied into the label store as the label's reasonNote, which
-- `label_store.exclude` keeps. Clears it on one subject's csam text-hold labels and nothing else. Its
-- EXECUTE goes to the app role the way `label_store.exclude`'s does (ask an infra owner); until then
-- `post_text_held` keeps holding the text.
CREATE OR REPLACE FUNCTION label_store.drop_label_notes(
  p_subject_type TEXT, p_subject_id TEXT, p_family TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF p_family IS DISTINCT FROM 'csam_text_hold' THEN
    RAISE EXCEPTION 'label_store.drop_label_notes: family % is not allowed', p_family;
  END IF;
  UPDATE label_store.label l
  SET "reasonNote" = NULL
  FROM label_store.subject s
  WHERE s."id" = l."subjectId"
    AND s."subjectType" = p_subject_type AND s."subjectId" = p_subject_id
    AND l."family" = p_family
    AND l."reasonNote" IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION label_store.drop_label_notes(TEXT, TEXT, TEXT) FROM PUBLIC;

-- 4. The delete trigger: refuses a held text as before; a confirmed "none" text past its year takes its
-- hold copy and label-store snapshot with it, in the same statement.
CREATE OR REPLACE FUNCTION post_text_keep_held() RETURNS trigger AS $$
BEGIN
  IF post_text_held(OLD."id", OLD."csamHeld", OLD."postId", OLD."userId") THEN
    RAISE EXCEPTION 'PostText % cannot be deleted while it is held', OLD."id";
  END IF;
  IF OLD."csamHeld"
    AND coalesce(post_text_csam_confirmed_at(OLD."id") <= (now() AT TIME ZONE 'UTC') - interval '1 year', false)
    AND NOT EXISTS (
      SELECT 1 FROM "TextScanHold" h
      WHERE h."entityType" = 'PostText' AND h."entityId" = OLD."id" AND h.label = 'csam'
        AND h.status = 'Confirmed'
        AND h.meta ->> 'reportChoice' IS DISTINCT FROM 'none'
    )
    AND post_text_retention_skip(OLD."postId", OLD."userId") IS NULL
  THEN
    UPDATE "TextScanHold" h
    -- The confirmed holds and the duplicates a migration superseded, which carry the same text (the
    -- dismissed-hold sweep clears a duplicate only once the hold it points at is dismissed). Only the
    -- decision's own keys stay: the scan's reason, the moderator's note, `previous` and any scan key may
    -- carry the text. `decisionNotePurged` records that a note existed.
    SET "text" = '',
        "reason" = '',
        "decisionNote" = NULL,
        "meta" = jsonb_strip_nulls(jsonb_build_object(
          'decision', h."meta" -> 'decision',
          'reportChoice', h."meta" -> 'reportChoice',
          'kind', h."meta" -> 'kind',
          'priorHoldId', h."meta" -> 'priorHoldId',
          'superseded', h."meta" -> 'superseded',
          'supersededBy', h."meta" -> 'supersededBy',
          'decisionNotePurged', CASE WHEN coalesce(h."decisionNote", '') <> '' THEN true END,
          'retentionPurgedAt', now()
        ))
    WHERE h."entityType" = 'PostText' AND h."entityId" = OLD."id" AND h.label = 'csam'
      AND (h.status = 'Confirmed'
        OR (h.status = 'Dismissed' AND h."meta" ->> 'decision' = 'superseded'));
    IF to_regprocedure('label_store.exclude(text,text,text)') IS NOT NULL THEN
      PERFORM label_store.exclude('post_text_text', OLD."id"::text, 'retention');
    END IF;
    PERFORM label_store.drop_label_notes('post_text_text', OLD."id"::text, 'csam_text_hold');
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- 5. A text's held flag, recomputed from all of its csam holds after each decision: held while any hold
-- is pending or confirmed. So a dismissal of one hold leaves what another hold gave.
CREATE OR REPLACE FUNCTION post_text_sync_csam_hold(text_id INTEGER)
RETURNS void AS $$
  UPDATE "PostText" t
  SET "csamHeld" = EXISTS (
        SELECT 1 FROM "TextScanHold" h
        WHERE h."entityType" = 'PostText' AND h."entityId" = t."id" AND h.label = 'csam'
          AND h.status IN ('Pending', 'Confirmed')
      ),
      "updatedAt" = now()
  WHERE t."id" = text_id;
$$ LANGUAGE sql VOLATILE SET search_path = public, pg_temp;

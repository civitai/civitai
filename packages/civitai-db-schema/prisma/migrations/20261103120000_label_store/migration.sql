-- The label store: one record of every moderation judgement, from people and models. Features write
-- through these functions; see docs/features/label-store.md.
--
-- Its own schema, outside Prisma: the drift guard reads `public` only. Apply as the owner of the site
-- tables, so the site's own writes need no grants. Two scoped roles, created by infra, get the rest: a
-- reader that sees the views at the bottom, and a writer that can only submit predictions.
--
-- Site-write paths catch their own errors into record_failure (the count to watch), so a bad label never
-- fails the vote, flag or appeal that produced it; a statement timeout still cancels both.
-- submit_prediction raises.
--
-- Apply after 20261023140000 (scan label copy sweep) and 20261020120000 (appeal decision record). Then
-- run SELECT * FROM label_store.backfill() once; it is idempotent.
--
-- 🔴 CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE (blocks writes) on each source table. The file
-- sets lock_timeout = 5s; re-run on a timeout.

CREATE SCHEMA IF NOT EXISTS label_store;

-- Key for the person hashes below. Generated per database; never leaves it.
CREATE TABLE IF NOT EXISTS label_store.secret (
  "id"  BOOLEAN PRIMARY KEY DEFAULT true CHECK ("id"),
  "key" TEXT NOT NULL
);
INSERT INTO label_store.secret ("key")
VALUES (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT DO NOTHING;
REVOKE ALL ON label_store.secret FROM PUBLIC;

CREATE TABLE IF NOT EXISTS label_store.subject (
  "id"             BIGSERIAL PRIMARY KEY,
  "subjectType"    TEXT NOT NULL,
  "subjectId"      TEXT NOT NULL,
  -- sha256 of the text as given, or of the image's storage key (a new upload is a new key).
  "contentHash"    TEXT NOT NULL,
  "pHash"          BIGINT,
  "bytesRef"       TEXT,
  "bytesExpireAt"  TIMESTAMPTZ(3),
  "snapshot"       JSONB,
  "ownerHash"      TEXT,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "excludedAt"     TIMESTAMPTZ(3),
  "excludedReason" TEXT CHECK ("excludedReason" IN ('safety', 'removed', 'retention')),
  UNIQUE ("subjectType", "subjectId", "contentHash")
);
CREATE INDEX IF NOT EXISTS subject_owner_idx ON label_store.subject ("ownerHash");
CREATE INDEX IF NOT EXISTS subject_content_idx ON label_store.subject ("contentHash");
CREATE INDEX IF NOT EXISTS subject_site_idx ON label_store.subject ("subjectType", "subjectId");

CREATE TABLE IF NOT EXISTS label_store.label (
  "id"              BIGSERIAL PRIMARY KEY,
  "subjectId"       BIGINT NOT NULL REFERENCES label_store.subject ("id") ON DELETE CASCADE,
  "family"          TEXT NOT NULL,
  "question"        TEXT NOT NULL,
  "questionVersion" INTEGER NOT NULL DEFAULT 1,
  "value"           TEXT NOT NULL,
  "reason"          TEXT,
  "reasonNote"      TEXT,
  "labellerKind"    TEXT NOT NULL CHECK ("labellerKind" IN ('moderator', 'knight', 'appeal')),
  "labellerRef"     TEXT NOT NULL,
  "sourceRef"       TEXT NOT NULL UNIQUE,
  "labelledAt"      TIMESTAMPTZ(3) NOT NULL,
  "msOnItem"        INTEGER,
  "recordedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS label_subject_question_idx
  ON label_store.label ("subjectId", "question", "questionVersion");

CREATE TABLE IF NOT EXISTS label_store.prediction (
  "id"              BIGSERIAL PRIMARY KEY,
  "subjectId"       BIGINT NOT NULL REFERENCES label_store.subject ("id") ON DELETE CASCADE,
  "family"          TEXT NOT NULL,
  "question"        TEXT NOT NULL,
  "questionVersion" INTEGER NOT NULL DEFAULT 1,
  "value"           TEXT NOT NULL,
  "confidence"      REAL,
  "scores"          JSONB,
  "modelRef"        TEXT NOT NULL,   -- model@version
  "versions"        JSONB,
  "inputHash"       TEXT,
  "detail"          JSONB,
  "sourceRef"       TEXT NOT NULL UNIQUE,
  "predictedAt"     TIMESTAMPTZ(3) NOT NULL,
  "recordedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prediction_subject_question_idx
  ON label_store.prediction ("subjectId", "question", "questionVersion");

-- When a question has enough agreement to train on. A question with no rule never becomes trainable.
CREATE TABLE IF NOT EXISTS label_store.rule (
  "question"         TEXT NOT NULL,
  "questionVersion"  INTEGER NOT NULL,
  "minHuman"         INTEGER NOT NULL CHECK ("minHuman" >= 1),
  "requireUnanimous" BOOLEAN NOT NULL,
  PRIMARY KEY ("question", "questionVersion")
);
INSERT INTO label_store.rule VALUES ('image.block', 1, 3, true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS label_store.consensus (
  "subjectId"       BIGINT NOT NULL REFERENCES label_store.subject ("id") ON DELETE CASCADE,
  "question"        TEXT NOT NULL,
  "questionVersion" INTEGER NOT NULL,
  "outcome"         TEXT,
  "humanLabels"     INTEGER NOT NULL,
  "agreeing"        INTEGER NOT NULL,
  "unanimous"       BOOLEAN NOT NULL,
  "rule"            TEXT,
  "trainable"       BOOLEAN NOT NULL,
  "modelValue"      TEXT,
  "modelRef"        TEXT,
  "modelAgrees"     BOOLEAN,
  "computedAt"      TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("subjectId", "question", "questionVersion")
);
CREATE INDEX IF NOT EXISTS consensus_trainable_idx
  ON label_store.consensus ("question", "questionVersion") WHERE "trainable";

-- No FK: a deletion must stay in the feed after its subject is gone.
CREATE TABLE IF NOT EXISTS label_store.change (
  "id"              BIGSERIAL PRIMARY KEY,
  "kind"            TEXT NOT NULL CHECK ("kind" IN ('label', 'prediction', 'consensus', 'exclusion', 'deletion')),
  "subjectId"       BIGINT NOT NULL,
  "question"        TEXT,
  "questionVersion" INTEGER,
  "refId"           BIGINT,   -- the label or prediction id
  "at"              TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS label_store.record_failure (
  "id"        BIGSERIAL PRIMARY KEY,
  "sourceRef" TEXT,
  "error"     TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- Kinds hash differently, so an owner hash cannot be matched to a labeller hash.
CREATE OR REPLACE FUNCTION label_store.person_hash(p_kind TEXT, p_user_id INTEGER)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
  SELECT encode(sha256(convert_to(s."key" || ':' || p_kind || ':' || p_user_id, 'UTF8')), 'hex')
  FROM label_store.secret s
$$;

CREATE OR REPLACE FUNCTION label_store.text_hash(p_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION label_store.note_failure(p_source_ref TEXT, p_error TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
BEGIN
  INSERT INTO label_store.record_failure ("sourceRef", "error") VALUES (p_source_ref, p_error);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'label_store: % not recorded (%), and the failure could not be logged: %',
    p_source_ref, p_error, SQLERRM;
END;
$$;

-- An image subject with no owner gets one from public."Image" while the image exists, so
-- pipeline-submitted subjects stay erasable.
CREATE OR REPLACE FUNCTION label_store.upsert_subject(
  p_subject_type  TEXT,
  p_subject_id    TEXT,
  p_content_hash  TEXT,
  p_snapshot      JSONB,
  p_phash         BIGINT,
  p_owner_user_id INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, public, pg_temp
AS $$
DECLARE
  v_owner   INTEGER := p_owner_user_id;
  v_subject BIGINT;
BEGIN
  IF v_owner IS NULL AND p_subject_type = 'image' AND p_subject_id ~ '^[0-9]{1,9}$' THEN
    SELECT m."userId" INTO v_owner FROM public."Image" m WHERE m."id" = p_subject_id::integer;
  END IF;

  INSERT INTO label_store.subject AS s (
    "subjectType", "subjectId", "contentHash", "pHash", "snapshot", "ownerHash"
  )
  VALUES (
    p_subject_type, p_subject_id, p_content_hash, p_phash, p_snapshot,
    CASE WHEN v_owner IS NULL THEN NULL ELSE label_store.person_hash('owner', v_owner) END
  )
  ON CONFLICT ("subjectType", "subjectId", "contentHash") DO UPDATE SET
    "pHash" = COALESCE(s."pHash", EXCLUDED."pHash"),
    -- An excluded subject keeps no content, whatever a later judgement brings.
    "snapshot" = CASE WHEN s."excludedAt" IS NULL THEN COALESCE(s."snapshot", EXCLUDED."snapshot") END,
    "ownerHash" = COALESCE(s."ownerHash", EXCLUDED."ownerHash")
  RETURNING s."id" INTO v_subject;
  RETURN v_subject;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.refresh_consensus(p_subject BIGINT, p_question TEXT, p_version INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
DECLARE
  r         label_store.rule%ROWTYPE;
  v_total   INTEGER;
  v_top     TEXT;
  v_top_n   INTEGER;
  v_ties    INTEGER;
  v_outcome TEXT;
  v_model   TEXT;
  v_mref    TEXT;
  v_excl    BOOLEAN;
  v_changed BOOLEAN;
BEGIN
  WITH latest AS (
    SELECT DISTINCT ON (l."labellerRef") l."value"
    FROM label_store.label l
    WHERE l."subjectId" = p_subject AND l."question" = p_question AND l."questionVersion" = p_version
      AND l."labellerKind" IN ('moderator', 'knight')
    ORDER BY l."labellerRef", l."labelledAt" DESC, l."id" DESC
  ), tally AS (
    SELECT "value", count(*)::int AS n FROM latest GROUP BY "value"
  )
  SELECT (SELECT sum(n) FROM tally)::int, t."value", t.n, (SELECT count(*) FROM tally WHERE n = t.n)::int
  INTO v_total, v_top, v_top_n, v_ties
  FROM tally t
  ORDER BY t.n DESC, t."value"
  LIMIT 1;

  -- No human labels, no consensus row.
  IF v_total IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO r FROM label_store.rule WHERE "question" = p_question AND "questionVersion" = p_version;
  IF FOUND AND v_total >= r."minHuman" AND v_ties = 1 THEN
    v_outcome := v_top;
  END IF;

  SELECT p."value", p."modelRef" INTO v_model, v_mref
  FROM label_store.prediction p
  WHERE p."subjectId" = p_subject AND p."question" = p_question AND p."questionVersion" = p_version
  ORDER BY p."predictedAt" DESC, p."id" DESC
  LIMIT 1;

  SELECT s."excludedAt" IS NOT NULL INTO v_excl FROM label_store.subject s WHERE s."id" = p_subject;

  INSERT INTO label_store.consensus AS c (
    "subjectId", "question", "questionVersion", "outcome", "humanLabels", "agreeing", "unanimous",
    "rule", "trainable", "modelValue", "modelRef", "modelAgrees", "computedAt"
  )
  VALUES (
    p_subject, p_question, p_version, v_outcome, v_total, v_top_n, v_top_n = v_total,
    CASE WHEN r."question" IS NULL THEN NULL
      ELSE 'min' || r."minHuman" || CASE WHEN r."requireUnanimous" THEN '-unanimous' ELSE '-majority' END END,
    v_outcome IS NOT NULL AND (NOT r."requireUnanimous" OR v_top_n = v_total) AND NOT v_excl,
    v_model,
    v_mref,
    CASE WHEN v_outcome IS NULL OR v_model IS NULL THEN NULL ELSE v_model = v_outcome END,
    now()
  )
  ON CONFLICT ("subjectId", "question", "questionVersion") DO UPDATE SET
    "outcome" = EXCLUDED."outcome",
    "humanLabels" = EXCLUDED."humanLabels",
    "agreeing" = EXCLUDED."agreeing",
    "unanimous" = EXCLUDED."unanimous",
    "rule" = EXCLUDED."rule",
    "trainable" = EXCLUDED."trainable",
    "modelValue" = EXCLUDED."modelValue",
    "modelRef" = EXCLUDED."modelRef",
    "modelAgrees" = EXCLUDED."modelAgrees",
    "computedAt" = EXCLUDED."computedAt"
  WHERE (c."outcome", c."humanLabels", c."agreeing", c."trainable", c."modelValue", c."modelRef", c."modelAgrees")
    IS DISTINCT FROM
    (EXCLUDED."outcome", EXCLUDED."humanLabels", EXCLUDED."agreeing", EXCLUDED."trainable",
     EXCLUDED."modelValue", EXCLUDED."modelRef", EXCLUDED."modelAgrees")
  RETURNING true INTO v_changed;

  IF v_changed THEN
    INSERT INTO label_store.change ("kind", "subjectId", "question", "questionVersion")
    VALUES ('consensus', p_subject, p_question, p_version);
  END IF;
END;
$$;

-- Raise on bad input. Return the new id, or NULL when sourceRef was already recorded.
CREATE OR REPLACE FUNCTION label_store.put_label(
  p_subject BIGINT, p_family TEXT, p_question TEXT, p_question_version INTEGER, p_value TEXT,
  p_labeller_kind TEXT, p_labeller_ref TEXT, p_source_ref TEXT, p_labelled_at TIMESTAMPTZ,
  p_reason TEXT, p_reason_note TEXT, p_ms_on_item INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO label_store.label (
    "subjectId", "family", "question", "questionVersion", "value", "reason", "reasonNote",
    "labellerKind", "labellerRef", "sourceRef", "labelledAt", "msOnItem"
  )
  VALUES (
    p_subject, p_family, p_question, p_question_version, p_value, p_reason, p_reason_note,
    p_labeller_kind, p_labeller_ref, p_source_ref, p_labelled_at, p_ms_on_item
  )
  ON CONFLICT ("sourceRef") DO NOTHING
  RETURNING "id" INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO label_store.change ("kind", "subjectId", "question", "questionVersion", "refId")
    VALUES ('label', p_subject, p_question, p_question_version, v_id);
    PERFORM label_store.refresh_consensus(p_subject, p_question, p_question_version);
  END IF;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.put_prediction(
  p_subject BIGINT, p_family TEXT, p_question TEXT, p_question_version INTEGER, p_value TEXT,
  p_model_ref TEXT, p_source_ref TEXT, p_predicted_at TIMESTAMPTZ, p_confidence REAL, p_scores JSONB,
  p_versions JSONB, p_input_hash TEXT, p_detail JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO label_store.prediction (
    "subjectId", "family", "question", "questionVersion", "value", "confidence", "scores", "modelRef",
    "versions", "inputHash", "detail", "sourceRef", "predictedAt"
  )
  VALUES (
    p_subject, p_family, p_question, p_question_version, p_value, p_confidence, p_scores, p_model_ref,
    p_versions, p_input_hash, p_detail, p_source_ref, p_predicted_at
  )
  ON CONFLICT ("sourceRef") DO NOTHING
  RETURNING "id" INTO v_id;

  IF v_id IS NOT NULL THEN
    INSERT INTO label_store.change ("kind", "subjectId", "question", "questionVersion", "refId")
    VALUES ('prediction', p_subject, p_question, p_question_version, v_id);
    PERFORM label_store.refresh_consensus(p_subject, p_question, p_question_version);
  END IF;
  RETURN v_id;
END;
$$;

-- Site code: hashes the user id here, so no caller stores a raw id. Failures go to record_failure and
-- return NULL.
CREATE OR REPLACE FUNCTION label_store.record_label(
  p_subject_type     TEXT,
  p_subject_id       TEXT,
  p_content_hash     TEXT,
  p_family           TEXT,
  p_question         TEXT,
  p_value            TEXT,
  p_labeller_kind    TEXT,
  p_source_ref       TEXT,
  p_labelled_at      TIMESTAMPTZ,
  p_labeller_user_id INTEGER DEFAULT NULL,
  p_labeller_ref     TEXT DEFAULT NULL,
  p_question_version INTEGER DEFAULT 1,
  p_reason           TEXT DEFAULT NULL,
  p_reason_note      TEXT DEFAULT NULL,
  p_ms_on_item       INTEGER DEFAULT NULL,
  p_snapshot         JSONB DEFAULT NULL,
  p_phash            BIGINT DEFAULT NULL,
  p_owner_user_id    INTEGER DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
DECLARE
  v_ref TEXT;
BEGIN
  v_ref := CASE
    WHEN p_labeller_user_id IS NOT NULL THEN label_store.person_hash('labeller', p_labeller_user_id)
    ELSE p_labeller_ref
  END;
  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'a label needs p_labeller_user_id or p_labeller_ref';
  END IF;
  RETURN label_store.put_label(
    label_store.upsert_subject(p_subject_type, p_subject_id, p_content_hash, p_snapshot, p_phash, p_owner_user_id),
    p_family, p_question, p_question_version, p_value, p_labeller_kind, v_ref, p_source_ref,
    p_labelled_at, p_reason, p_reason_note, p_ms_on_item
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure(p_source_ref, SQLSTATE || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

-- As record_label, for a model output.
CREATE OR REPLACE FUNCTION label_store.record_prediction(
  p_subject_type     TEXT,
  p_subject_id       TEXT,
  p_content_hash     TEXT,
  p_family           TEXT,
  p_question         TEXT,
  p_value            TEXT,
  p_model_ref        TEXT,
  p_source_ref       TEXT,
  p_predicted_at     TIMESTAMPTZ,
  p_question_version INTEGER DEFAULT 1,
  p_confidence       REAL DEFAULT NULL,
  p_scores           JSONB DEFAULT NULL,
  p_versions         JSONB DEFAULT NULL,
  p_input_hash       TEXT DEFAULT NULL,
  p_detail           JSONB DEFAULT NULL,
  p_snapshot         JSONB DEFAULT NULL,
  p_phash            BIGINT DEFAULT NULL,
  p_owner_user_id    INTEGER DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
BEGIN
  RETURN label_store.put_prediction(
    label_store.upsert_subject(p_subject_type, p_subject_id, p_content_hash, p_snapshot, p_phash, p_owner_user_id),
    p_family, p_question, p_question_version, p_value, p_model_ref, p_source_ref, p_predicted_at,
    p_confidence, p_scores, p_versions, p_input_hash, p_detail
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure(p_source_ref, SQLSTATE || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.submit_prediction(
  p_subject_type     TEXT,
  p_subject_id       TEXT,
  p_content_hash     TEXT,
  p_question         TEXT,
  p_value            TEXT,
  p_model_ref        TEXT,
  p_source_ref       TEXT,
  p_predicted_at     TIMESTAMPTZ DEFAULT now(),
  p_question_version INTEGER DEFAULT 1,
  p_confidence       REAL DEFAULT NULL,
  p_scores           JSONB DEFAULT NULL,
  p_versions         JSONB DEFAULT NULL,
  p_input_hash       TEXT DEFAULT NULL,
  p_detail           JSONB DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
BEGIN
  IF p_subject_type IS NULL OR p_subject_id IS NULL OR p_content_hash IS NULL OR p_question IS NULL
     OR p_value IS NULL OR p_model_ref IS NULL OR p_source_ref IS NULL THEN
    RAISE EXCEPTION 'submit_prediction: subject type, subject id, content hash, question, value, model ref and source ref are required';
  END IF;
  RETURN label_store.put_prediction(
    label_store.upsert_subject(p_subject_type, p_subject_id, p_content_hash, NULL, NULL, NULL),
    'pipeline', p_question, p_question_version, p_value, p_model_ref, p_source_ref, p_predicted_at,
    p_confidence, p_scores, p_versions, p_input_hash, p_detail
  );
END;
$$;

-- 'erasure' deletes the subjects and everything under them; any other reason keeps the judgements (so
-- counts stay honest) and drops snapshot and bytes.
CREATE OR REPLACE FUNCTION label_store.exclude(p_subject_type TEXT, p_subject_id TEXT, p_reason TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  IF p_reason = 'erasure' THEN
    WITH gone AS (
      DELETE FROM label_store.subject
      WHERE "subjectType" = p_subject_type AND "subjectId" = p_subject_id
      RETURNING "id"
    )
    INSERT INTO label_store.change ("kind", "subjectId") SELECT 'deletion', "id" FROM gone;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
  END IF;

  WITH hit AS (
    UPDATE label_store.subject
    SET "excludedAt" = now(),
        "excludedReason" = p_reason,
        "snapshot" = NULL,
        "bytesRef" = NULL,
        "bytesExpireAt" = NULL
    WHERE "subjectType" = p_subject_type AND "subjectId" = p_subject_id AND "excludedAt" IS NULL
    RETURNING "id"
  ), untrain AS (
    UPDATE label_store.consensus c SET "trainable" = false
    FROM hit WHERE c."subjectId" = hit."id"
  )
  INSERT INTO label_store.change ("kind", "subjectId") SELECT 'exclusion', "id" FROM hit;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.erase_owner(p_user_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
DECLARE
  v_n INTEGER;
BEGIN
  WITH gone AS (
    DELETE FROM label_store.subject WHERE "ownerHash" = label_store.person_hash('owner', p_user_id)
    RETURNING "id"
  )
  INSERT INTO label_store.change ("kind", "subjectId") SELECT 'deletion', "id" FROM gone;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Site producers take a source row, so the trigger and the backfill run the same code.

-- 'control-sample' flags are a sampling marker, not a verdict, and record nothing.
CREATE OR REPLACE FUNCTION label_store.from_scan_label_flag(f public."ScanLabelFlag")
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, public, pg_temp
AS $$
DECLARE
  v_src TEXT := 'ScanLabelFlag:' || f."workflowId";
  im    RECORD;
BEGIN
  IF f."source" = 'control-sample' THEN
    RETURN NULL;
  END IF;
  SELECT i."imageId" AS id, m."url", m."pHash", m."userId", m."meta"
  INTO im
  FROM public."ScanLabelItem" i JOIN public."Image" m ON m."id" = i."imageId"
  WHERE i."id" = f."itemId";
  IF NOT FOUND THEN
    PERFORM label_store.note_failure(v_src, 'image not found');
    RETURN NULL;
  END IF;
  RETURN label_store.record_prediction(
    p_subject_type => 'image',
    p_subject_id => im.id::text,
    p_content_hash => label_store.text_hash(im."url"),
    p_family => 'scan_label',
    p_question => 'image.block',
    p_value => 'block',
    p_model_ref => f."flaggerVersion",
    p_source_ref => v_src,
    p_predicted_at => f."flaggedAt",
    p_input_hash => CASE WHEN f."source" = 'xguard-prompt'
      THEN label_store.text_hash(im."meta"->>'prompt') ELSE label_store.text_hash(im."url") END,
    p_detail => jsonb_strip_nulls(jsonb_build_object('source', f."source", 'reason', f."reason", 'outputs', f."snapshot")),
    p_snapshot => jsonb_strip_nulls(jsonb_build_object(
      'url', im."url", 'prompt', im."meta"->>'prompt', 'negativePrompt', im."meta"->>'negativePrompt'
    )),
    p_phash => im."pHash",
    p_owner_user_id => im."userId"
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure(v_src, SQLSTATE || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.from_scan_label_vote(v public."ScanLabelVote")
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, public, pg_temp
AS $$
DECLARE
  v_src TEXT := 'ScanLabelVote:' || v."itemId";
  im    RECORD;
BEGIN
  v_src := v_src || ':' || label_store.person_hash('labeller', v."userId");
  SELECT i."imageId" AS id, m."url", m."pHash", m."userId", m."meta"
  INTO im
  FROM public."ScanLabelItem" i JOIN public."Image" m ON m."id" = i."imageId"
  WHERE i."id" = v."itemId";
  IF NOT FOUND THEN
    PERFORM label_store.note_failure(v_src, 'image not found');
    RETURN NULL;
  END IF;
  RETURN label_store.record_label(
    p_subject_type => 'image',
    p_subject_id => im.id::text,
    p_content_hash => label_store.text_hash(im."url"),
    p_family => 'scan_label',
    p_question => 'image.block',
    p_value => CASE WHEN v."block" THEN 'block' ELSE 'clear' END,
    p_labeller_kind => 'moderator',
    p_labeller_user_id => v."userId",
    p_source_ref => v_src,
    p_labelled_at => v."createdAt",
    p_reason => v."reason",
    p_reason_note => v."reasonComment",
    p_ms_on_item => v."msOnItem",
    p_snapshot => jsonb_strip_nulls(jsonb_build_object(
      'url', im."url", 'prompt', im."meta"->>'prompt', 'negativePrompt', im."meta"->>'negativePrompt'
    )),
    p_phash => im."pHash",
    p_owner_user_id => im."userId"
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure(v_src, SQLSTATE || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

-- An appeal decision answers image.appeal. The record holds the image as it was at decision time, so this
-- works after the image is gone.
CREATE OR REPLACE FUNCTION label_store.from_appeal_decision(a public."AppealDecisionRecord")
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, public, pg_temp
AS $$
DECLARE
  v_src TEXT := 'AppealDecisionRecord:' || a."appealId";
BEGIN
  RETURN label_store.record_label(
    p_subject_type => 'image',
    p_subject_id => a."imageId"::text,
    p_content_hash => label_store.text_hash(a."imageUrl"),
    p_family => 'appeal',
    p_question => 'image.appeal',
    p_value => lower(a."decision"),
    p_labeller_kind => 'appeal',
    p_labeller_ref => 'appeal-review',
    p_source_ref => v_src,
    p_labelled_at => a."decidedAt",
    p_snapshot => jsonb_strip_nulls(jsonb_build_object(
      'url', a."imageUrl", 'nsfwLevel', a."nsfwLevel", 'aiNsfwLevel', a."aiNsfwLevel",
      'blockedFor', a."blockedFor", 'nsfwLevelReason', a."nsfwLevelReason"
    )),
    p_phash => a."pHash"
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure(v_src, SQLSTATE || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

-- 30 days must not exceed the copy bucket's expiry (set outside this repo); training_examples hides the
-- pointer after bytesExpireAt.
CREATE OR REPLACE FUNCTION label_store.from_scan_label_copy(i public."ScanLabelItem")
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, public, pg_temp
AS $$
BEGIN
  UPDATE label_store.subject
  SET "bytesRef" = 'scan-label-copy:' || i."copyKey",
      "bytesExpireAt" = COALESCE(i."copiedAt", now()) + interval '30 days'
  WHERE "subjectType" = 'image' AND "subjectId" = i."imageId"::text AND "excludedAt" IS NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure('ScanLabelItem:' || i."id" || ':copy', SQLSTATE || ': ' || SQLERRM);
END;
$$;

-- A withdrawn copy takes the bytes with it. Withdrawn as excluded also takes the subject out of training.
CREATE OR REPLACE FUNCTION label_store.from_scan_label_withdrawal(o public."ScanLabelCopyObject")
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, public, pg_temp
AS $$
BEGIN
  UPDATE label_store.subject
  SET "bytesRef" = NULL, "bytesExpireAt" = NULL
  WHERE "bytesRef" = 'scan-label-copy:' || o."key";
  IF o."withdrawReason" = 'excluded' THEN
    PERFORM label_store.exclude('image', o."imageId"::text, 'safety');
  END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure('ScanLabelCopyObject:' || o."key", SQLSTATE || ': ' || SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_scan_label_flag() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, public, pg_temp AS $$
BEGIN
  PERFORM label_store.from_scan_label_flag(NEW);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_scan_label_vote() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, public, pg_temp AS $$
BEGIN
  PERFORM label_store.from_scan_label_vote(NEW);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_appeal_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, public, pg_temp AS $$
BEGIN
  PERFORM label_store.from_appeal_decision(NEW);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_scan_label_copy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, public, pg_temp AS $$
BEGIN
  PERFORM label_store.from_scan_label_copy(NEW);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_scan_label_withdrawal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, public, pg_temp AS $$
BEGIN
  PERFORM label_store.from_scan_label_withdrawal(NEW);
  RETURN NULL;
END;
$$;

-- Idempotent via sourceRef. Copies and withdrawals only update existing subjects, so they run after the
-- judgements, and withdrawals after copies.
CREATE OR REPLACE FUNCTION label_store.backfill()
RETURNS TABLE ("source" TEXT, "rows" BIGINT, "added" BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT 'ScanLabelFlag', count(*), count(label_store.from_scan_label_flag(f))
    FROM public."ScanLabelFlag" f;
  RETURN QUERY
    SELECT 'ScanLabelVote', count(*), count(label_store.from_scan_label_vote(v))
    FROM public."ScanLabelVote" v;
  RETURN QUERY
    SELECT 'AppealDecisionRecord', count(*), count(label_store.from_appeal_decision(a))
    FROM public."AppealDecisionRecord" a;
  PERFORM label_store.from_scan_label_copy(i)
  FROM public."ScanLabelItem" i
  WHERE i."copyState" = 'copied' AND i."copyKey" IS NOT NULL;
  PERFORM label_store.from_scan_label_withdrawal(o)
  FROM public."ScanLabelCopyObject" o
  WHERE o."withdrawnAt" IS NOT NULL;
END;
$$;

-- Readers see only these views, which run with their owner's rights. Never select "ownerHash" or the
-- secret here.

CREATE OR REPLACE VIEW label_store.labels_feed AS
SELECT
  l."id", l."subjectId", s."subjectType", s."subjectId" AS "siteId", s."contentHash", s."pHash",
  l."family", l."question", l."questionVersion", l."value", l."reason", l."reasonNote",
  l."labellerKind", l."labellerRef", l."sourceRef", l."labelledAt", l."msOnItem", l."recordedAt",
  s."excludedAt" IS NOT NULL AS "excluded"
FROM label_store.label l
JOIN label_store.subject s ON s."id" = l."subjectId";

CREATE OR REPLACE VIEW label_store.predictions_feed AS
SELECT
  p."id", p."subjectId", s."subjectType", s."subjectId" AS "siteId", s."contentHash", s."pHash",
  p."family", p."question", p."questionVersion", p."value", p."confidence", p."scores", p."modelRef",
  p."versions", p."inputHash", p."detail", p."sourceRef", p."predictedAt", p."recordedAt",
  s."excludedAt" IS NOT NULL AS "excluded"
FROM label_store.prediction p
JOIN label_store.subject s ON s."id" = p."subjectId";

-- Ids are assigned before commit, so a row can appear after a higher id: readers re-read a window behind
-- their cursor.
CREATE OR REPLACE VIEW label_store.changes_feed AS
SELECT "id", "kind", "subjectId", "question", "questionVersion", "refId", "at"
FROM label_store.change;

CREATE OR REPLACE VIEW label_store.training_examples AS
SELECT
  s."id" AS "subjectId", s."subjectType", s."subjectId" AS "siteId", s."contentHash", s."pHash",
  CASE WHEN s."bytesExpireAt" > now() THEN s."bytesRef" END AS "bytesRef",
  CASE WHEN s."bytesExpireAt" > now() THEN s."bytesExpireAt" END AS "bytesExpireAt",
  s."snapshot", c."question", c."questionVersion", c."outcome", c."humanLabels", c."agreeing",
  c."unanimous", c."rule", c."modelValue", c."modelRef", c."modelAgrees", c."computedAt"
FROM label_store.consensus c
JOIN label_store.subject s ON s."id" = c."subjectId"
WHERE c."trainable" AND s."excludedAt" IS NULL;

CREATE OR REPLACE VIEW label_store.pipeline_failures AS
SELECT * FROM label_store.training_examples WHERE "modelAgrees" = false;

-- Owner-only, except submit_prediction, granted to the writer below.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA label_store FROM PUBLIC;

-- The reader and writer roles are created by infra; grant when they exist. Re-run this block after.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_reader') THEN
    GRANT USAGE ON SCHEMA label_store TO label_reader;
    GRANT SELECT ON label_store.labels_feed, label_store.predictions_feed, label_store.changes_feed,
      label_store.training_examples, label_store.pipeline_failures TO label_reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_writer') THEN
    GRANT USAGE ON SCHEMA label_store TO label_writer;
    GRANT EXECUTE ON FUNCTION label_store.submit_prediction(
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER, REAL, JSONB, JSONB, TEXT, JSONB
    ) TO label_writer;
  END IF;
END;
$$;

SET lock_timeout = '5s';

CREATE OR REPLACE TRIGGER label_store_flag
AFTER INSERT ON "ScanLabelFlag"
FOR EACH ROW EXECUTE FUNCTION label_store.trg_scan_label_flag();

CREATE OR REPLACE TRIGGER label_store_vote
AFTER INSERT ON "ScanLabelVote"
FOR EACH ROW EXECUTE FUNCTION label_store.trg_scan_label_vote();

CREATE OR REPLACE TRIGGER label_store_appeal
AFTER INSERT ON "AppealDecisionRecord"
FOR EACH ROW EXECUTE FUNCTION label_store.trg_appeal_decision();

CREATE OR REPLACE TRIGGER label_store_copy
AFTER UPDATE OF "copyState" ON "ScanLabelItem"
FOR EACH ROW
WHEN (NEW."copyState" = 'copied' AND OLD."copyState" IS DISTINCT FROM 'copied' AND NEW."copyKey" IS NOT NULL)
EXECUTE FUNCTION label_store.trg_scan_label_copy();

CREATE OR REPLACE TRIGGER label_store_withdrawal
AFTER UPDATE OF "withdrawnAt" ON "ScanLabelCopyObject"
FOR EACH ROW
WHEN (NEW."withdrawnAt" IS NOT NULL AND OLD."withdrawnAt" IS NULL)
EXECUTE FUNCTION label_store.trg_scan_label_withdrawal();

RESET lock_timeout;

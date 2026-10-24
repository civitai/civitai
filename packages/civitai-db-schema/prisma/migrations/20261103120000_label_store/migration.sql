-- The label store: one record of every moderation judgement, from people and models. Features write
-- through these functions; see docs/features/label-store.md.
--
-- Its own schema, outside Prisma: the drift guard reads `public` only. Apply as the owner of the site
-- tables, so the site's own writes need no grants. One scoped role, created by infra, reads the views at
-- the bottom. Pipelines submit predictions through an authenticated site endpoint, never a DB login.
--
-- Site-write paths catch their own errors into record_failure (the count to watch), so a bad label
-- never fails the vote, flag or appeal that produced it. They wait at most 2s for a lock; a statement
-- timeout still cancels the write. submit_prediction raises.
--
-- Apply after 20261023140000 (scan label copy sweep) and 20261020120000 (appeal decision record). Then
-- run CALL label_store.backfill_batches() once, outside a transaction: it commits per batch, so live
-- writes are never held behind it. It is idempotent; so is backfill(), the one-transaction form, for
-- tests only.
--
-- 🔴 CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE (blocks writes) on each source table. Each one
-- runs in its own transaction with lock_timeout = 5s; re-run the file on a timeout.

CREATE SCHEMA IF NOT EXISTS label_store;

-- Key for the person hashes below. Generated per database; never leaves it.
CREATE TABLE IF NOT EXISTS label_store.secret (
  "id"  BOOLEAN PRIMARY KEY DEFAULT true CHECK ("id"),
  "key" TEXT NOT NULL
);
INSERT INTO label_store.secret ("key")
VALUES (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT DO NOTHING;

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
  "sourceRef"       TEXT NOT NULL,
  "predictedAt"     TIMESTAMPTZ(3) NOT NULL,
  "recordedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- One pipeline run can answer many subjects and questions under one ref.
  UNIQUE ("sourceRef", "subjectId", "question", "questionVersion")
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
  "kind"            TEXT NOT NULL
    CHECK ("kind" IN ('label', 'prediction', 'consensus', 'subject', 'exclusion', 'deletion')),
  "subjectId"       BIGINT NOT NULL,
  "question"        TEXT,
  "questionVersion" INTEGER,
  "refId"           BIGINT,   -- the label or prediction id
  "at"              TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- Ids are assigned before commit, so a cursor on id alone can skip a row; readers page on (txid, id).
  "txid"            BIGINT NOT NULL DEFAULT (pg_current_xact_id()::text::bigint)
);
CREATE INDEX IF NOT EXISTS change_txid_idx ON label_store.change ("txid", "id");

-- Erased subjects and owners, so a backfill or a late label cannot bring them back.
CREATE TABLE IF NOT EXISTS label_store.erased_subject (
  "subjectType" TEXT NOT NULL,
  "subjectId"   TEXT NOT NULL,
  "erasedAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("subjectType", "subjectId")
);
CREATE TABLE IF NOT EXISTS label_store.erased_owner (
  "ownerHash" TEXT PRIMARY KEY,
  "erasedAt"  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
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

-- Writers hold it shared and erasure exclusive, so a write in flight when an erasure starts either
-- commits before the erasure deletes or sees its tombstone.
CREATE OR REPLACE FUNCTION label_store.erasure_lock_key(p_kind TEXT, p_ref TEXT)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT hashtextextended('label_store:' || p_kind || ':' || p_ref, 0)
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
-- pipeline-submitted subjects stay erasable. Raises for an erased subject or owner. Writes the row only
-- to fill a field it lacks, so a repeat judgement takes no row lock.
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
SET search_path = label_store, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  v_owner      INTEGER := p_owner_user_id;
  v_owner_hash TEXT;
  v_subject    BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    label_store.erasure_lock_key('subject', p_subject_type || ':' || p_subject_id)
  );
  IF EXISTS (
    SELECT 1 FROM label_store.erased_subject e
    WHERE e."subjectType" = p_subject_type AND e."subjectId" = p_subject_id
  ) THEN
    RAISE EXCEPTION 'subject % % was erased', p_subject_type, p_subject_id;
  END IF;

  IF v_owner IS NULL AND p_subject_type = 'image' AND p_subject_id ~ '^[0-9]{1,10}$' THEN
    IF p_subject_id::bigint <= 2147483647 THEN
      SELECT m."userId" INTO v_owner FROM public."Image" m WHERE m."id" = p_subject_id::integer;
    END IF;
  END IF;
  IF v_owner IS NOT NULL THEN
    v_owner_hash := label_store.person_hash('owner', v_owner);
    PERFORM pg_advisory_xact_lock_shared(label_store.erasure_lock_key('owner', v_owner_hash));
    IF EXISTS (SELECT 1 FROM label_store.erased_owner e WHERE e."ownerHash" = v_owner_hash) THEN
      RAISE EXCEPTION 'the owner of subject % % was erased', p_subject_type, p_subject_id;
    END IF;
  END IF;

  INSERT INTO label_store.subject ("subjectType", "subjectId", "contentHash", "pHash", "snapshot", "ownerHash")
  VALUES (p_subject_type, p_subject_id, p_content_hash, p_phash, p_snapshot, v_owner_hash)
  ON CONFLICT ("subjectType", "subjectId", "contentHash") DO NOTHING
  RETURNING "id" INTO v_subject;
  IF v_subject IS NOT NULL THEN
    RETURN v_subject;
  END IF;

  UPDATE label_store.subject s SET
    -- An excluded subject keeps no content, whatever a later judgement brings.
    "pHash" = CASE WHEN s."excludedAt" IS NULL THEN COALESCE(s."pHash", p_phash) END,
    "snapshot" = CASE WHEN s."excludedAt" IS NULL THEN COALESCE(s."snapshot", p_snapshot) END,
    "ownerHash" = COALESCE(s."ownerHash", v_owner_hash)
  WHERE s."subjectType" = p_subject_type AND s."subjectId" = p_subject_id
    AND s."contentHash" = p_content_hash
    AND ((s."pHash" IS NULL AND s."excludedAt" IS NULL AND p_phash IS NOT NULL)
      OR (s."snapshot" IS NULL AND s."excludedAt" IS NULL AND p_snapshot IS NOT NULL)
      OR (s."ownerHash" IS NULL AND v_owner_hash IS NOT NULL))
  RETURNING s."id" INTO v_subject;
  IF v_subject IS NOT NULL THEN
    INSERT INTO label_store.change ("kind", "subjectId") VALUES ('subject', v_subject);
    RETURN v_subject;
  END IF;

  SELECT s."id" INTO v_subject FROM label_store.subject s
  WHERE s."subjectType" = p_subject_type AND s."subjectId" = p_subject_id
    AND s."contentHash" = p_content_hash;
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

-- Returns the new id, or NULL when sourceRef was already recorded.
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
  ON CONFLICT ("sourceRef", "subjectId", "question", "questionVersion") DO NOTHING
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
SET lock_timeout = '2s'
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
SET lock_timeout = '2s'
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
DECLARE
  v_id BIGINT;
BEGIN
  IF p_subject_type IS NULL OR p_subject_id IS NULL OR p_content_hash IS NULL OR p_question IS NULL
     OR p_value IS NULL OR p_model_ref IS NULL OR p_source_ref IS NULL THEN
    RAISE EXCEPTION 'submit_prediction: subject type, subject id, content hash, question, value, model ref and source ref are required';
  END IF;
  v_id := label_store.put_prediction(
    label_store.upsert_subject(p_subject_type, p_subject_id, p_content_hash, NULL, NULL, NULL),
    -- Prefixed, so a pipeline cannot take a ref a site producer will write later.
    'pipeline', p_question, p_question_version, p_value, p_model_ref, 'pipeline:' || p_source_ref, p_predicted_at,
    p_confidence, p_scores, p_versions, p_input_hash, p_detail
  );
  IF p_subject_type = 'image' AND p_subject_id ~ '^[0-9]{1,10}$' THEN
    IF p_subject_id::bigint <= 2147483647 THEN
      IF label_store.image_excluded(p_subject_id::integer) THEN
        PERFORM label_store.exclude('image', p_subject_id, 'safety');
      END IF;
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

-- The endpoint's batch: a JSON array of submit_prediction arguments in camelCase. Each item stands
-- alone, so one refused item (an erased subject) does not refuse the rest. status: 'recorded',
-- 'duplicate' (this sourceRef was already recorded for the subject, question and version) or
-- 'rejected' with the reason.
CREATE OR REPLACE FUNCTION label_store.submit_predictions(p_items JSONB)
RETURNS TABLE ("ord" INTEGER, "id" BIGINT, "status" TEXT, "error" TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
DECLARE
  e JSONB;
  n INTEGER;
BEGIN
  FOR e, n IN SELECT t.e, t.n::int FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, n) LOOP
    "ord" := n;
    "id" := NULL;
    "error" := NULL;
    BEGIN
      "id" := label_store.submit_prediction(
        p_subject_type => e->>'subjectType',
        p_subject_id => e->>'subjectId',
        p_content_hash => e->>'contentHash',
        p_question => e->>'question',
        p_value => e->>'value',
        p_model_ref => e->>'modelRef',
        p_source_ref => e->>'sourceRef',
        p_predicted_at => COALESCE((e->>'predictedAt')::timestamptz, now()),
        p_question_version => COALESCE((e->>'questionVersion')::integer, 1),
        p_confidence => (e->>'confidence')::real,
        p_scores => e->'scores',
        p_versions => e->'versions',
        p_input_hash => e->>'inputHash',
        p_detail => e->'detail'
      );
      "status" := CASE WHEN "id" IS NULL THEN 'duplicate' ELSE 'recorded' END;
    EXCEPTION WHEN OTHERS THEN
      "status" := 'rejected';
      "error" := SQLERRM;
    END;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- 'erasure' deletes the subjects and everything under them, and tombstones them; any other reason
-- keeps the judgements (so counts stay honest), drops the content (snapshot, pHash, bytes) and untrains.
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
    PERFORM pg_advisory_xact_lock(label_store.erasure_lock_key('subject', p_subject_type || ':' || p_subject_id));
    INSERT INTO label_store.erased_subject ("subjectType", "subjectId")
    VALUES (p_subject_type, p_subject_id)
    ON CONFLICT DO NOTHING;
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
        "pHash" = NULL,
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
  v_hash TEXT := label_store.person_hash('owner', p_user_id);
  v_n    INTEGER;
BEGIN
  -- Each subject (for a writer that cannot see the owner), then the owner: the order writers take them.
  PERFORM pg_advisory_xact_lock(label_store.erasure_lock_key('subject', s."subjectType" || ':' || s."subjectId"))
  FROM label_store.subject s WHERE s."ownerHash" = v_hash;
  PERFORM pg_advisory_xact_lock(label_store.erasure_lock_key('owner', v_hash));
  INSERT INTO label_store.erased_owner ("ownerHash") VALUES (v_hash) ON CONFLICT DO NOTHING;
  WITH gone AS (
    DELETE FROM label_store.subject WHERE "ownerHash" = v_hash
    RETURNING "id", "subjectType", "subjectId"
  ), tomb AS (
    INSERT INTO label_store.erased_subject ("subjectType", "subjectId")
    SELECT DISTINCT "subjectType", "subjectId" FROM gone
    ON CONFLICT DO NOTHING
  )
  INSERT INTO label_store.change ("kind", "subjectId") SELECT 'deletion', "id" FROM gone;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- The site's exclusion rule for one image row. Restated by `excludedImageRow` and by the inline SQL of
-- `sweepLabelStore` (src/server/jobs/appeal-decision-records.ts); edit all three together. A report's
-- image id is compared as text, as the sweep does.
CREATE OR REPLACE FUNCTION label_store.image_row_excluded(p_image_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."Image" i
    WHERE i."id" = p_image_id AND (
      i."needsReview" = 'csam' OR i."blockedFor" = 'CSAM'
      OR i."userId" IN (SELECT c."userId" FROM public."CsamReport" c WHERE c."userId" IS NOT NULL)
    )
  ) OR EXISTS (
    SELECT 1
    FROM public."CsamReport" c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c."images") = 'array' THEN c."images" ELSE '[]' END) e
    WHERE e->>'id' = p_image_id::text
  )
$$;

-- An image is excluded when it, or another image sharing its stored file, is. Checked when a judgement
-- lands, so such an image is never trainable while it waits for the sweep.
CREATE OR REPLACE FUNCTION label_store.image_excluded(p_image_id INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = label_store, pg_temp
AS $$
  SELECT label_store.image_row_excluded(p_image_id) OR EXISTS (
    SELECT 1 FROM public."Image" i JOIN public."Image" o ON o."url" = i."url" AND o."id" <> i."id"
    WHERE i."id" = p_image_id AND label_store.image_row_excluded(o."id")
  )
$$;

-- Site producers take a source row, so the trigger and the backfill run the same code.

-- 'control-sample' flags are a sampling marker, not a verdict, and record nothing.
CREATE OR REPLACE FUNCTION label_store.from_scan_label_flag(f public."ScanLabelFlag")
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  v_src TEXT := 'ScanLabelFlag:' || f."workflowId";
  im    RECORD;
  v_id  BIGINT;
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
  v_id := label_store.record_prediction(
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
  IF label_store.image_excluded(im.id) THEN
    PERFORM label_store.exclude('image', im.id::text, 'safety');
  END IF;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure(v_src, SQLSTATE || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.from_scan_label_vote(v public."ScanLabelVote")
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  v_src TEXT := 'ScanLabelVote:' || v."itemId";
  im    RECORD;
  v_id  BIGINT;
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
  v_id := label_store.record_label(
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
  IF label_store.image_excluded(im.id) THEN
    PERFORM label_store.exclude('image', im.id::text, 'safety');
  END IF;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure(v_src, SQLSTATE || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

-- Built from the record alone, so it works after the image is gone. The appellant owns the image.
CREATE OR REPLACE FUNCTION label_store.from_appeal_decision(a public."AppealDecisionRecord")
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
SET lock_timeout = '2s'
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
    p_phash => a."pHash",
    p_owner_user_id => (SELECT ap."userId" FROM public."Appeal" ap WHERE ap."id" = a."appealId")
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
SET search_path = label_store, pg_temp
SET lock_timeout = '2s'
AS $$
BEGIN
  WITH hit AS (
    UPDATE label_store.subject
    SET "bytesRef" = 'scan-label-copy:' || i."copyKey",
        "bytesExpireAt" = COALESCE(i."copiedAt", now()) + interval '30 days'
    WHERE "subjectType" = 'image' AND "subjectId" = i."imageId"::text AND "excludedAt" IS NULL
      AND "bytesRef" IS DISTINCT FROM 'scan-label-copy:' || i."copyKey"
    RETURNING "id"
  )
  INSERT INTO label_store.change ("kind", "subjectId") SELECT 'subject', "id" FROM hit;
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure('ScanLabelItem:' || i."id" || ':copy', SQLSTATE || ': ' || SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION label_store.from_scan_label_withdrawal(o public."ScanLabelCopyObject")
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
SET lock_timeout = '2s'
AS $$
BEGIN
  WITH hit AS (
    UPDATE label_store.subject
    SET "bytesRef" = NULL, "bytesExpireAt" = NULL
    WHERE "subjectType" = 'image' AND "subjectId" = o."imageId"::text
      AND "bytesRef" = 'scan-label-copy:' || o."key"
    RETURNING "id"
  )
  INSERT INTO label_store.change ("kind", "subjectId") SELECT 'subject', "id" FROM hit;
  IF o."withdrawReason" = 'excluded' THEN
    PERFORM label_store.exclude('image', o."imageId"::text, 'safety');
  END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure('ScanLabelCopyObject:' || o."key", SQLSTATE || ': ' || SQLERRM);
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_scan_label_flag() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, pg_temp AS $$
BEGIN
  PERFORM label_store.from_scan_label_flag(NEW);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_scan_label_vote() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, pg_temp AS $$
BEGIN
  PERFORM label_store.from_scan_label_vote(NEW);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_appeal_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, pg_temp AS $$
BEGIN
  PERFORM label_store.from_appeal_decision(NEW);
  RETURN NULL;
END;
$$;

-- The appeal sweep deletes a record when its image stops being eligible or ages out; either way the
-- image leaves training.
CREATE OR REPLACE FUNCTION label_store.trg_appeal_decision_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, pg_temp SET lock_timeout = '2s' AS $$
BEGIN
  PERFORM label_store.exclude('image', g."imageId"::text, 'removed')
  FROM (SELECT DISTINCT o."imageId" FROM gone o) g;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure('AppealDecisionRecord:delete', SQLSTATE || ': ' || SQLERRM);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_scan_label_copy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, pg_temp AS $$
BEGIN
  PERFORM label_store.from_scan_label_copy(NEW);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION label_store.trg_scan_label_withdrawal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = label_store, pg_temp AS $$
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
SET search_path = label_store, pg_temp
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

-- backfill(), committing every p_batch source rows so live writes never wait behind it. A row opens two
-- subtransactions, and a transaction holding more than 64 slows every snapshot on the primary and its
-- replicas, hence 25. CALL outside a transaction block. Transaction control rules out SECURITY DEFINER
-- and a SET clause, so this runs as the caller (the owner) with every name qualified.
CREATE OR REPLACE PROCEDURE label_store.backfill_batches(p_batch INTEGER DEFAULT 25)
LANGUAGE plpgsql
AS $$
DECLARE
  f     public."ScanLabelFlag";
  v     public."ScanLabelVote";
  a     public."AppealDecisionRecord";
  i     public."ScanLabelItem";
  o     public."ScanLabelCopyObject";
  n     BIGINT;
  added BIGINT;
BEGIN
  n := 0; added := 0;
  FOR f IN SELECT * FROM public."ScanLabelFlag" ORDER BY "id" LOOP
    IF label_store.from_scan_label_flag(f) IS NOT NULL THEN added := added + 1; END IF;
    n := n + 1;
    IF n % p_batch = 0 THEN COMMIT; END IF;
  END LOOP;
  COMMIT;
  RAISE NOTICE 'ScanLabelFlag: % rows, % added', n, added;

  n := 0; added := 0;
  FOR v IN SELECT * FROM public."ScanLabelVote" ORDER BY "itemId", "userId" LOOP
    IF label_store.from_scan_label_vote(v) IS NOT NULL THEN added := added + 1; END IF;
    n := n + 1;
    IF n % p_batch = 0 THEN COMMIT; END IF;
  END LOOP;
  COMMIT;
  RAISE NOTICE 'ScanLabelVote: % rows, % added', n, added;

  n := 0; added := 0;
  FOR a IN SELECT * FROM public."AppealDecisionRecord" ORDER BY "id" LOOP
    IF label_store.from_appeal_decision(a) IS NOT NULL THEN added := added + 1; END IF;
    n := n + 1;
    IF n % p_batch = 0 THEN COMMIT; END IF;
  END LOOP;
  COMMIT;
  RAISE NOTICE 'AppealDecisionRecord: % rows, % added', n, added;

  n := 0;
  FOR i IN SELECT * FROM public."ScanLabelItem" WHERE "copyState" = 'copied' AND "copyKey" IS NOT NULL ORDER BY "id" LOOP
    PERFORM label_store.from_scan_label_copy(i);
    n := n + 1;
    IF n % p_batch = 0 THEN COMMIT; END IF;
  END LOOP;
  COMMIT;
  RAISE NOTICE 'copies: % rows', n;

  n := 0;
  FOR o IN SELECT * FROM public."ScanLabelCopyObject" WHERE "withdrawnAt" IS NOT NULL ORDER BY "key" LOOP
    PERFORM label_store.from_scan_label_withdrawal(o);
    n := n + 1;
    IF n % p_batch = 0 THEN COMMIT; END IF;
  END LOOP;
  COMMIT;
  RAISE NOTICE 'withdrawals: % rows', n;
END;
$$;

-- Readers see only these views, which run with their owner's rights. Never select "ownerHash" or the
-- secret here. security_barrier: a reader's own conditions run only on rows a view returns.

CREATE OR REPLACE VIEW label_store.labels_feed WITH (security_barrier) AS
SELECT
  l."id", l."subjectId", s."subjectType", s."subjectId" AS "siteId", s."contentHash", s."pHash",
  l."family", l."question", l."questionVersion", l."value", l."reason", l."reasonNote",
  l."labellerKind", l."labellerRef", l."sourceRef", l."labelledAt", l."msOnItem", l."recordedAt",
  s."excludedAt" IS NOT NULL AS "excluded"
FROM label_store.label l
JOIN label_store.subject s ON s."id" = l."subjectId";

CREATE OR REPLACE VIEW label_store.predictions_feed WITH (security_barrier) AS
SELECT
  p."id", p."subjectId", s."subjectType", s."subjectId" AS "siteId", s."contentHash", s."pHash",
  p."family", p."question", p."questionVersion", p."value", p."confidence", p."scores", p."modelRef",
  p."versions", p."inputHash", p."detail", p."sourceRef", p."predictedAt", p."recordedAt",
  s."excludedAt" IS NOT NULL AS "excluded"
FROM label_store.prediction p
JOIN label_store.subject s ON s."id" = p."subjectId";

-- Only rows from transactions older than every running one, so nothing can later appear below a
-- reader's (txid, id) cursor.
CREATE OR REPLACE VIEW label_store.changes_feed WITH (security_barrier) AS
SELECT "txid", "id", "kind", "subjectId", "question", "questionVersion", "refId", "at"
FROM label_store.change
WHERE "txid" < pg_snapshot_xmin(pg_current_snapshot())::text::bigint;

CREATE OR REPLACE VIEW label_store.training_examples WITH (security_barrier) AS
SELECT
  s."id" AS "subjectId", s."subjectType", s."subjectId" AS "siteId", s."contentHash", s."pHash",
  CASE WHEN s."bytesExpireAt" > now() THEN s."bytesRef" END AS "bytesRef",
  CASE WHEN s."bytesExpireAt" > now() THEN s."bytesExpireAt" END AS "bytesExpireAt",
  s."snapshot", c."question", c."questionVersion", c."outcome", c."humanLabels", c."agreeing",
  c."unanimous", c."rule", c."modelValue", c."modelRef", c."modelAgrees", c."computedAt"
FROM label_store.consensus c
JOIN label_store.subject s ON s."id" = c."subjectId"
WHERE c."trainable" AND s."excludedAt" IS NULL;

CREATE OR REPLACE VIEW label_store.pipeline_failures WITH (security_barrier) AS
SELECT * FROM label_store.training_examples WHERE "modelAgrees" = false;

-- Covers only routines that exist now: a routine added later needs its own REVOKE.
REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA label_store FROM PUBLIC;

-- label_reader is created by infra; re-run this block once it exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'label_reader') THEN
    GRANT USAGE ON SCHEMA label_store TO label_reader;
    GRANT SELECT ON label_store.labels_feed, label_store.predictions_feed, label_store.changes_feed,
      label_store.training_examples, label_store.pipeline_failures TO label_reader;
  END IF;
END;
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE TRIGGER label_store_flag
AFTER INSERT ON "ScanLabelFlag"
FOR EACH ROW EXECUTE FUNCTION label_store.trg_scan_label_flag();
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE TRIGGER label_store_vote
AFTER INSERT ON "ScanLabelVote"
FOR EACH ROW EXECUTE FUNCTION label_store.trg_scan_label_vote();
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE TRIGGER label_store_appeal
AFTER INSERT ON "AppealDecisionRecord"
FOR EACH ROW EXECUTE FUNCTION label_store.trg_appeal_decision();
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE TRIGGER label_store_appeal_deleted
AFTER DELETE ON "AppealDecisionRecord"
REFERENCING OLD TABLE AS gone
FOR EACH STATEMENT EXECUTE FUNCTION label_store.trg_appeal_decision_deleted();
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE TRIGGER label_store_copy
AFTER UPDATE OF "copyState" ON "ScanLabelItem"
FOR EACH ROW
WHEN (NEW."copyState" = 'copied' AND OLD."copyState" IS DISTINCT FROM 'copied' AND NEW."copyKey" IS NOT NULL)
EXECUTE FUNCTION label_store.trg_scan_label_copy();
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE TRIGGER label_store_withdrawal
AFTER UPDATE OF "withdrawnAt" ON "ScanLabelCopyObject"
FOR EACH ROW
WHEN (NEW."withdrawnAt" IS NOT NULL AND OLD."withdrawnAt" IS NULL)
EXECUTE FUNCTION label_store.trg_scan_label_withdrawal();
COMMIT;

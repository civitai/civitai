-- Points a label-store subject at bytes the site already keeps, for producers whose content is not an
-- image upload copied by the scan-label sweep (Creator Shop artwork). Apply as the owner of the site
-- tables, after 20261103120000_label_store.

-- Sets the pointer once: a subject whose bytesRef is already set, or that is excluded, is left alone.
-- p_expire_at NULL means the site keeps the bytes indefinitely; training_examples shows a pointer only
-- before its expiry, so that is stored as 'infinity'.
CREATE OR REPLACE FUNCTION label_store.attach_bytes(
  p_subject_type TEXT,
  p_subject_id   TEXT,
  p_content_hash TEXT,
  p_bytes_ref    TEXT,
  p_expire_at    TIMESTAMPTZ DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = label_store, pg_temp
SET lock_timeout = '2s'
AS $$
DECLARE
  v_subject BIGINT;
BEGIN
  IF p_bytes_ref IS NULL OR p_bytes_ref = '' THEN
    RETURN false;
  END IF;
  UPDATE label_store.subject s
  SET "bytesRef" = p_bytes_ref,
      "bytesExpireAt" = COALESCE(p_expire_at, 'infinity'::timestamptz)
  WHERE s."subjectType" = p_subject_type AND s."subjectId" = p_subject_id
    AND s."contentHash" = p_content_hash
    AND s."bytesRef" IS NULL AND s."excludedAt" IS NULL
  RETURNING s."id" INTO v_subject;
  IF v_subject IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO label_store.change ("kind", "subjectId") VALUES ('subject', v_subject);
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION label_store.attach_bytes(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;

-- A csam-realistic vote is excluded from the label store as it is recorded, before the image is flagged.
--
-- Apply after 20261103120000_label_store and before 20261230140000_scan_label_csam_hold's build ships,
-- so no such vote is ever recorded unexcluded. The body is the one in 20261103120000_label_store except
-- for the exclusion condition and the exclusion retried in the error handler.

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
  IF v."reason" = 'csam-realistic' OR label_store.image_excluded(im.id) THEN
    PERFORM label_store.exclude('image', im.id::text, 'safety');
  END IF;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  PERFORM label_store.note_failure(v_src, SQLSTATE || ': ' || SQLERRM);
  -- The image may already be a subject (from its scan flag): exclude it even when recording failed.
  IF v."reason" = 'csam-realistic' THEN
    BEGIN
      PERFORM label_store.exclude('image', i."imageId"::text, 'safety')
      FROM public."ScanLabelItem" i WHERE i."id" = v."itemId";
    EXCEPTION WHEN OTHERS THEN
      PERFORM label_store.note_failure(v_src, 'csam exclusion: ' || SQLSTATE || ': ' || SQLERRM);
    END;
  END IF;
  RETURN NULL;
END;
$$;

-- The label store's image exclusion reads a CSAM block anywhere in "blockedFor", a comma list of block reasons
-- (`csamInBlockedForSql`, packages/civitai-shared/src/csam-blocked-for.ts), instead of only the exact value 'CSAM'.
-- Its TypeScript twins are `excludedImageRow` and `sweepLabelStore` in src/server/jobs/appeal-decision-records.ts;
-- edit all three together. `label_store.image_excluded` calls this function, so it follows.
--
-- Apply MANUALLY, per environment, before deploying the web release carrying the twins. Re-runnable.
-- CREATE OR REPLACE keeps the function's owner and grants.

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
      i."needsReview" = 'csam'
      OR EXISTS (
        SELECT 1 FROM unnest(string_to_array(i."blockedFor", ',')) AS mw_reason(value)
        WHERE lower(btrim(mw_reason.value)) = 'csam'
      )
      OR i."userId" IN (SELECT c."userId" FROM public."CsamReport" c WHERE c."userId" IS NOT NULL)
    )
  ) OR EXISTS (
    SELECT 1
    FROM public."CsamReport" c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c."images") = 'array' THEN c."images" ELSE '[]' END) e
    WHERE e->>'id' = p_image_id::text
  )
$$;

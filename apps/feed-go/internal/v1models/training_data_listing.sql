
    SELECT mf.id, mf."virusScanResult", mf.metadata -> 'nsfwLevel' AS "nsfwLevel",
      mf.metadata -> 'fullyRated' AS "fullyRated", ((
    (m."userId") = -1
    OR EXISTS (
      SELECT 1 FROM "CsamReport" tr
      WHERE tr."userId" = m."userId" OR tr.details ->> 'secondaryUserId' = (m."userId")::text
    )
    OR EXISTS (SELECT 1 FROM "Image" ti WHERE ti."userId" = m."userId" AND ti."needsReview" = 'csam')
    OR EXISTS (SELECT 1 FROM "Image" ti WHERE ti."userId" = m."userId" AND ti."blockedFor" = 'CSAM')
    OR (m."userId") IN (
      SELECT ri."userId" FROM (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) l
      JOIN "Image" ri ON ri.id = CASE WHEN l.id ~ '^[0-9]{1,9}$' THEN l.id::int END
    )
  )
      OR (EXISTS (
    SELECT 1 FROM "ModelVersion" hv JOIN "Model" hm ON hm.id = hv."modelId"
    WHERE hv.id = mv.id AND (hm.poi OR hm.minor OR hm."tosViolation")
  ) OR EXISTS (
    SELECT 1 FROM "Post" hp JOIN "Image" hi ON hi."postId" = hp.id
    WHERE hp."modelVersionId" = mv.id
      AND (hi."needsReview" IS NOT NULL OR hi."blockedFor" IS NOT NULL OR hi.ingestion = 'Blocked')
  ))) AS restricted
    FROM "ModelFile" mf
    JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mf."modelVersionId" = ANY($1::int[]) AND mf.type = 'Training Data'
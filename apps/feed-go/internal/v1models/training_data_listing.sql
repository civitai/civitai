
    SELECT mf.id, mf."virusScanResult", mf.metadata -> 'nsfwLevel' AS "nsfwLevel",
      mf.metadata -> 'fullyRated' AS "fullyRated", ((((
    m."userId" = -1
    OR ((m."userId")::text IN (
  SELECT hc."userId"::text AS "userId"
  FROM "CsamReport" hc
  WHERE hc."userId" IS NOT NULL AND (
    hc."reportSentAt" IS NULL
    OR hc."archivedAt" IS NULL
    OR hc."reportSentAt" > now() - interval '1 year'
  )
  UNION
  SELECT hs.details ->> 'secondaryUserId'
  FROM "CsamReport" hs
  WHERE hs.details ->> 'secondaryUserId' IS NOT NULL AND (
    hs."reportSentAt" IS NULL
    OR hs."archivedAt" IS NULL
    OR hs."reportSentAt" > now() - interval '1 year'
  )
))
    OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" ehu WHERE ehu."userId" = m."userId")
  ) OR (((m."userId")::text IN (
  SELECT hc."userId"::text AS "userId"
  FROM "CsamReport" hc
  WHERE hc."userId" IS NOT NULL AND (
    hc."reportSentAt" IS NULL
    OR hc."archivedAt" IS NULL
    OR hc."reportSentAt" > now() - interval '1 year'
  )
  UNION
  SELECT hs.details ->> 'secondaryUserId'
  FROM "CsamReport" hs
  WHERE hs.details ->> 'secondaryUserId' IS NOT NULL AND (
    hs."reportSentAt" IS NULL
    OR hs."archivedAt" IS NULL
    OR hs."reportSentAt" > now() - interval '1 year'
  )
)) OR (m."userId") IS DISTINCT FROM -2 AND EXISTS (
      SELECT 1 FROM "Image" hr WHERE hr."userId" = m."userId" AND hr."needsReview" = 'csam'
    ) OR (m."userId") IS DISTINCT FROM -2 AND EXISTS (
      SELECT 1 FROM "Image" bi
      WHERE bi."userId" = m."userId" AND bi."blockedFor" = 'CSAM'
        AND NOT EXISTS (
          SELECT 1 FROM "CsamReport" sc
          WHERE (sc."userId" = m."userId" OR sc.details ->> 'secondaryUserId' = (m."userId")::text)
            AND sc."reportSentAt" IS NOT NULL
            AND sc.images @> jsonb_build_array(jsonb_build_object('id', bi.id))
        )
    ) OR (m."userId") IS DISTINCT FROM -2 AND ((m."userId") IN (
  SELECT ri."userId"
  FROM "CsamReport" rr
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(rr.images) = 'array' THEN rr.images ELSE '[]'::jsonb END
  ) re
  JOIN "Image" ri
    ON ri.id = CASE WHEN (re ->> 'id') ~ '^[0-9]{1,18}$' THEN (re ->> 'id')::bigint END
  WHERE (
    rr."reportSentAt" IS NULL
    OR rr."archivedAt" IS NULL
    OR rr."reportSentAt" > now() - interval '1 year'
  )
)) OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = m."userId"))) OR EXISTS (
    SELECT 1 FROM "CsamReport" tr
    WHERE tr."userId" = m."userId" OR tr.details ->> 'secondaryUserId' = (m."userId")::text
  ))
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
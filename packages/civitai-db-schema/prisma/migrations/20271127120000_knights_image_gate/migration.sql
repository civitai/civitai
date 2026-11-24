-- "KnightsImageGate" and knights_ensure_vote_partition: what the Knights app's database role reads and runs instead of
-- the moderation tables behind them and the "KnightsVote" DDL only its owner may run.
--
-- Apply MANUALLY, per environment, BEFORE the Knights release that reads the view. Apply as the owner of "Image" and
-- "KnightsVote" (from a superuser session: SET ROLE <that owner>;), never as a superuser: the file refuses, so neither
-- object can end up owned by one. Re-runnable: CREATE OR REPLACE, and REVOKE/GRANT are idempotent. One transaction, so
-- neither object ever exists with PUBLIC still holding access. The REVOKEs of the tables the view replaces are a separate
-- file (20271127120100_knights_image_gate_revokes), applied once that release is live: the release before it still reads
-- some of them.
--
-- "KnightsImageGate": one row per image on a post, four booleans and nothing else, so the role can read whether it may
-- show an image but never why one is out. Every column but "sweepServable" implies "servable". The SELECT is generated
-- from the TypeScript predicates (`imageGateViewSql` in apps/knights/src/lib/server/image-gate.ts), and a test fails when
-- this copy differs: regenerate it rather than editing it here. Names in it resolve when the view is created, under the
-- search_path set below, not when it is read. Keep "KnightsImageGate" WHERE-free with only imageId and boolean columns;
-- adding a filter or another column means marking it security_barrier.
--
-- knights_ensure_vote_partition(year, month): creates that month's "KnightsVote" partition, which only the table's owner
-- may do. SECURITY DEFINER with a pinned search_path; integers only, the name built inside; only a month from the
-- previous one to three ahead; nothing but that one CREATE TABLE ... PARTITION OF, under the app's partition lock.

BEGIN;

DO $$
BEGIN
  IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'apply as the owner of "Image" and "KnightsVote" (SET ROLE <owner>), not a superuser';
  END IF;
END
$$;

SET LOCAL search_path = pg_catalog, public;

CREATE OR REPLACE VIEW public."KnightsImageGate" AS
-- generated: imageGateViewSql
select "img"."id" as "imageId", COALESCE(((("img"."type" = 'image' and "img"."nsfwLevel" not in (0, 32) and "img"."ingestion" != 'Blocked' and "img"."blockedFor" is null and "img"."needsReview" is null and "img"."acceptableMinor" = false and "img"."poi" = false and "img"."minor" = false and "img"."tosViolation" = false and /* servable-image-content */ true and NOT COALESCE((
    img."needsReview" = 'csam'
    OR img."blockedFor" = 'CSAM'
    OR (img."userId" <> -1
      AND img."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND (
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = img."userId")
      -- Compared as text, the form "CsamReport_secondaryUserId_idx" indexes, so Postgres picks an
      -- index probe per row for a few rows or one hashed read per statement for many.
      -- secondaryUserId is stored as a JSON number; a writer that stores text must normalize it.
      -- A hand-written "007" matches no one; the pattern keeps a negative id matching no one.
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' = (img."userId")::text
          AND hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      )
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = img."userId")
    ))
  ), false) and (img.id)::text NOT IN (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) and not exists (select 1 as "one" from "User" as "owner" where "owner"."id" = "img"."userId" and "owner"."deletedAt" is not null) and not exists (select 1 as "one" from "ModelVersion" as "mv" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "mv"."id" = "p"."modelVersionId" and ("mv"."status" in ('Deleted', 'UnpublishedViolation') or "m"."status" in ('Deleted', 'UnpublishedViolation') or "m"."deletedAt" is not null))) and "p"."publishedAt" is not null and "p"."publishedAt" < (now() AT TIME ZONE 'utc')) and "p"."availability" in ('Public', 'Unsearchable', 'EarlyAccess') and (not exists (select 1 as "one" from "User" as "owner" where "owner"."id" = "img"."userId" and ("owner"."bannedAt" is not null or "owner"."muted" = true)) and not exists (select 1 as "one" from "ModelVersion" as "mv" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "mv"."id" = "p"."modelVersionId" and ("mv"."status" != 'Published' or "mv"."availability" = 'Private' or "m"."status" != 'Published' or "m"."availability" = 'Private')))), false) as "servable", COALESCE(("img"."type" = 'image' and "img"."nsfwLevel" not in (0, 32) and "img"."ingestion" != 'Blocked' and "img"."blockedFor" is null and "img"."needsReview" is null and "img"."acceptableMinor" = false and "img"."poi" = false and "img"."minor" = false and "img"."tosViolation" = false and /* servable-image-content */ true and NOT COALESCE((
    img."needsReview" = 'csam'
    OR img."blockedFor" = 'CSAM'
    OR (img."userId" <> -1
      AND img."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND (
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = img."userId")
      -- Compared as text, the form "CsamReport_secondaryUserId_idx" indexes, so Postgres picks an
      -- index probe per row for a few rows or one hashed read per statement for many.
      -- secondaryUserId is stored as a JSON number; a writer that stores text must normalize it.
      -- A hand-written "007" matches no one; the pattern keeps a negative id matching no one.
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' = (img."userId")::text
          AND hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      )
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = img."userId")
    ))
  ), false) and (img.id)::text NOT IN (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) and not exists (select 1 as "one" from "User" as "owner" where "owner"."id" = "img"."userId" and "owner"."deletedAt" is not null) and not exists (select 1 as "one" from "ModelVersion" as "mv" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "mv"."id" = "p"."modelVersionId" and ("mv"."status" in ('Deleted', 'UnpublishedViolation') or "m"."status" in ('Deleted', 'UnpublishedViolation') or "m"."deletedAt" is not null))), false) as "sweepServable", COALESCE((((("img"."type" = 'image' and "img"."nsfwLevel" not in (0, 32) and "img"."ingestion" != 'Blocked' and "img"."blockedFor" is null and "img"."needsReview" is null and "img"."acceptableMinor" = false and "img"."poi" = false and "img"."minor" = false and "img"."tosViolation" = false and /* servable-image-content */ true and NOT COALESCE((
    img."needsReview" = 'csam'
    OR img."blockedFor" = 'CSAM'
    OR (img."userId" <> -1
      AND img."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND (
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = img."userId")
      -- Compared as text, the form "CsamReport_secondaryUserId_idx" indexes, so Postgres picks an
      -- index probe per row for a few rows or one hashed read per statement for many.
      -- secondaryUserId is stored as a JSON number; a writer that stores text must normalize it.
      -- A hand-written "007" matches no one; the pattern keeps a negative id matching no one.
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' = (img."userId")::text
          AND hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      )
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = img."userId")
    ))
  ), false) and (img.id)::text NOT IN (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) and not exists (select 1 as "one" from "User" as "owner" where "owner"."id" = "img"."userId" and "owner"."deletedAt" is not null) and not exists (select 1 as "one" from "ModelVersion" as "mv" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "mv"."id" = "p"."modelVersionId" and ("mv"."status" in ('Deleted', 'UnpublishedViolation') or "m"."status" in ('Deleted', 'UnpublishedViolation') or "m"."deletedAt" is not null))) and "p"."publishedAt" is not null and "p"."publishedAt" < (now() AT TIME ZONE 'utc')) and "p"."availability" in ('Public', 'Unsearchable', 'EarlyAccess') and (not exists (select 1 as "one" from "User" as "owner" where "owner"."id" = "img"."userId" and ("owner"."bannedAt" is not null or "owner"."muted" = true)) and not exists (select 1 as "one" from "ModelVersion" as "mv" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "mv"."id" = "p"."modelVersionId" and ("mv"."status" != 'Published' or "mv"."availability" = 'Private' or "m"."status" != 'Published' or "m"."availability" = 'Private')))) and "img"."tosViolation" = false and NOT COALESCE((
    img."needsReview" = 'csam'
    OR img."blockedFor" = 'CSAM'
    OR (img."userId" <> -1
      AND img."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND (
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = img."userId")
      -- Compared as text, the form "CsamReport_secondaryUserId_idx" indexes, so Postgres picks an
      -- index probe per row for a few rows or one hashed read per statement for many.
      -- secondaryUserId is stored as a JSON number; a writer that stores text must normalize it.
      -- A hand-written "007" matches no one; the pattern keeps a negative id matching no one.
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' = (img."userId")::text
          AND hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      )
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = img."userId")
    ))
  ), false) and NOT COALESCE((
    EXISTS (
      SELECT 1 FROM "BlockedImage" sb WHERE sb.hash = img."pHash" AND sb.reason = 'CSAM'
    )
    OR EXISTS (
      SELECT 1 FROM "ScanLabelItem" si
      WHERE si."imageId" = img.id AND (
        si."voidReason" = 'csam-hold'
        OR EXISTS (
          SELECT 1 FROM "ScanLabelFlag" sf WHERE sf."itemId" = si.id AND sf.snapshot ->> 'csam' = 'true'
        )
        OR EXISTS (
          SELECT 1 FROM "ScanLabelVote" sv WHERE sv."itemId" = si.id AND sv.reason = 'csam-realistic'
        )
      )
    )
  ), false) and not exists (select 1 as "one" from "ScanLabelItem" as "si" where "si"."imageId" = "img"."id" and (exists (select 1 as "one" from "ScanLabelFlag" as "sf" where "sf"."itemId" = "si"."id" and sf.snapshot ->> 'minorDetected' = 'true') or exists (select 1 as "one" from "ScanLabelVote" as "sv" where "sv"."itemId" = "si"."id" and ("sv"."reason" = 'school-nsfw' or "sv"."reason" like 'minor-%')))) and NOT COALESCE((img."ingestion"::text NOT IN ('Scanned', 'Blocked')), false) and NOT (
    EXISTS (SELECT 1 FROM "Image" rl_i WHERE rl_i.url = img."url" AND rl_i.id IN (SELECT CASE WHEN rl_ids.id ~ '^[0-9]{1,18}$' THEN (rl_ids.id)::bigint END
  FROM (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) rl_ids))
    OR EXISTS (
      SELECT 1 FROM "ImageCdnModeratorDelete" rl_d
      WHERE rl_d.url = img."url" AND rl_d."imageId" IN (SELECT CASE WHEN rl_ids.id ~ '^[0-9]{1,18}$' THEN (rl_ids.id)::bigint END
  FROM (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) rl_ids)
    )
    OR EXISTS (
      SELECT 1 FROM "Image" rl_p
      -- ARRAY(...) is uncorrelated, so it is computed once per statement, not per outer row.
      WHERE rl_p.url = img."url" AND rl_p."pHash" = ANY(ARRAY(
        SELECT rl_x."pHash" FROM "Image" rl_x
        WHERE rl_x.id IN (SELECT CASE WHEN rl_ids.id ~ '^[0-9]{1,18}$' THEN (rl_ids.id)::bigint END
  FROM (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) rl_ids) AND rl_x."pHash" IS NOT NULL
      ))
    )
  ) and NOT (
    EXISTS (
      SELECT 1 FROM "EvidenceHoldImage" eh_h JOIN "Image" eh_i ON eh_i.id = eh_h."imageId"
      WHERE eh_i.url = img."url"
    )
    OR EXISTS (
      SELECT 1 FROM "EvidenceHoldImage" eh_h
      JOIN "ImageCdnModeratorDelete" eh_d ON eh_d."imageId" = eh_h."imageId"
      WHERE eh_d.url = img."url"
    )
  ) and not exists (select 1 as "one" from "EvidenceHoldPost" as "ehp" where "ehp"."postId" = "img"."postId") and not exists (select 1 as "one" from "ImageReport" as "ir" inner join "Report" as "rep" on "rep"."id" = "ir"."reportId" where "ir"."imageId" = "img"."id" and "rep"."status" in ('Pending', 'Processing')) and not exists (select 1 as "one" from "PostReport" as "pr" inner join "Report" as "rep" on "rep"."id" = "pr"."reportId" where "pr"."postId" = "img"."postId" and "rep"."status" in ('Pending', 'Processing')) and not exists (select 1 as "one" from "ImageResourceNew" as "irn" inner join "ModelVersion" as "mv" on "mv"."id" = "irn"."modelVersionId" inner join "ModelReport" as "mr" on "mr"."modelId" = "mv"."modelId" inner join "Report" as "rep" on "rep"."id" = "mr"."reportId" where "irn"."imageId" = "img"."id" and "rep"."status" in ('Pending', 'Processing')) and not exists (select 1 as "one" from "UserReport" as "ur" inner join "Report" as "rep" on "rep"."id" = "ur"."reportId" where "ur"."userId" = "img"."userId" and "rep"."status" in ('Pending', 'Processing')) and not exists (select 1 as "one" from "ImageFlag" as "f" where "f"."imageId" = "img"."id" and ("f"."promptNsfw" = true or "f"."resourcesNsfw" = true)) and not exists (select 1 as "one" from "Appeal" as "a" where "a"."entityType" = 'Image' and "a"."entityId" = "img"."id" and "a"."status" = 'Pending') and not exists (select 1 as "one" from "TextScanHold" as "t" where "t"."status" = 'Pending' and (("t"."entityType" = 'Image' and "t"."entityId" = "img"."id") or ("t"."entityType" = 'Post' and "t"."entityId" = "img"."postId"))) and not exists (select 1 as "one" from "User" as "u" where "u"."id" = "img"."userId" and ("u"."bannedAt" is not null or "u"."deletedAt" is not null or "u"."muted" = true)) and not exists (select 1 as "one" from "ImageResourceNew" as "irn" inner join "ModelVersion" as "mv" on "mv"."id" = "irn"."modelVersionId" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "irn"."imageId" = "img"."id" and ("m"."minor" = true or "m"."poi" = true)) and not exists (select 1 as "one" from "KnightsQueueItem" as "qi" where "qi"."imageId" = "img"."id" and "qi"."status" in ('Inquisitor', 'Ruling'))), false) as "skillCheckEligible", COALESCE((((("img"."type" = 'image' and "img"."nsfwLevel" not in (0, 32) and "img"."ingestion" != 'Blocked' and "img"."blockedFor" is null and "img"."needsReview" is null and "img"."acceptableMinor" = false and "img"."poi" = false and "img"."minor" = false and "img"."tosViolation" = false and /* servable-image-content */ true and NOT COALESCE((
    img."needsReview" = 'csam'
    OR img."blockedFor" = 'CSAM'
    OR (img."userId" <> -1
      AND img."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND (
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = img."userId")
      -- Compared as text, the form "CsamReport_secondaryUserId_idx" indexes, so Postgres picks an
      -- index probe per row for a few rows or one hashed read per statement for many.
      -- secondaryUserId is stored as a JSON number; a writer that stores text must normalize it.
      -- A hand-written "007" matches no one; the pattern keeps a negative id matching no one.
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' = (img."userId")::text
          AND hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      )
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = img."userId")
    ))
  ), false) and (img.id)::text NOT IN (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) and not exists (select 1 as "one" from "User" as "owner" where "owner"."id" = "img"."userId" and "owner"."deletedAt" is not null) and not exists (select 1 as "one" from "ModelVersion" as "mv" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "mv"."id" = "p"."modelVersionId" and ("mv"."status" in ('Deleted', 'UnpublishedViolation') or "m"."status" in ('Deleted', 'UnpublishedViolation') or "m"."deletedAt" is not null))) and "p"."publishedAt" is not null and "p"."publishedAt" < (now() AT TIME ZONE 'utc')) and "p"."availability" in ('Public', 'Unsearchable', 'EarlyAccess') and (not exists (select 1 as "one" from "User" as "owner" where "owner"."id" = "img"."userId" and ("owner"."bannedAt" is not null or "owner"."muted" = true)) and not exists (select 1 as "one" from "ModelVersion" as "mv" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "mv"."id" = "p"."modelVersionId" and ("mv"."status" != 'Published' or "mv"."availability" = 'Private' or "m"."status" != 'Published' or "m"."availability" = 'Private')))) and "img"."tosViolation" = false and NOT COALESCE((
    img."needsReview" = 'csam'
    OR img."blockedFor" = 'CSAM'
    OR (img."userId" <> -1
      AND img."blockedFor" IS DISTINCT FROM 'AiNotVerified' AND (
      EXISTS (SELECT 1 FROM "CsamReport" hr WHERE hr."userId" = img."userId")
      -- Compared as text, the form "CsamReport_secondaryUserId_idx" indexes, so Postgres picks an
      -- index probe per row for a few rows or one hashed read per statement for many.
      -- secondaryUserId is stored as a JSON number; a writer that stores text must normalize it.
      -- A hand-written "007" matches no one; the pattern keeps a negative id matching no one.
      OR EXISTS (
        SELECT 1 FROM "CsamReport" hs
        WHERE hs.details ->> 'secondaryUserId' = (img."userId")::text
          AND hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
      )
      OR EXISTS (SELECT 1 FROM "EvidenceHeldUser" he WHERE he."userId" = img."userId")
    ))
  ), false) and NOT COALESCE((
    EXISTS (
      SELECT 1 FROM "BlockedImage" sb WHERE sb.hash = img."pHash" AND sb.reason = 'CSAM'
    )
    OR EXISTS (
      SELECT 1 FROM "ScanLabelItem" si
      WHERE si."imageId" = img.id AND (
        si."voidReason" = 'csam-hold'
        OR EXISTS (
          SELECT 1 FROM "ScanLabelFlag" sf WHERE sf."itemId" = si.id AND sf.snapshot ->> 'csam' = 'true'
        )
        OR EXISTS (
          SELECT 1 FROM "ScanLabelVote" sv WHERE sv."itemId" = si.id AND sv.reason = 'csam-realistic'
        )
      )
    )
  ), false) and not exists (select 1 as "one" from "ScanLabelItem" as "si" where "si"."imageId" = "img"."id" and (exists (select 1 as "one" from "ScanLabelFlag" as "sf" where "sf"."itemId" = "si"."id" and sf.snapshot ->> 'minorDetected' = 'true') or exists (select 1 as "one" from "ScanLabelVote" as "sv" where "sv"."itemId" = "si"."id" and ("sv"."reason" = 'school-nsfw' or "sv"."reason" like 'minor-%')))) and NOT (
    EXISTS (SELECT 1 FROM "Image" rl_i WHERE rl_i.url = img."url" AND rl_i.id IN (SELECT CASE WHEN rl_ids.id ~ '^[0-9]{1,18}$' THEN (rl_ids.id)::bigint END
  FROM (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) rl_ids))
    OR EXISTS (
      SELECT 1 FROM "ImageCdnModeratorDelete" rl_d
      WHERE rl_d.url = img."url" AND rl_d."imageId" IN (SELECT CASE WHEN rl_ids.id ~ '^[0-9]{1,18}$' THEN (rl_ids.id)::bigint END
  FROM (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) rl_ids)
    )
    OR EXISTS (
      SELECT 1 FROM "Image" rl_p
      -- ARRAY(...) is uncorrelated, so it is computed once per statement, not per outer row.
      WHERE rl_p.url = img."url" AND rl_p."pHash" = ANY(ARRAY(
        SELECT rl_x."pHash" FROM "Image" rl_x
        WHERE rl_x.id IN (SELECT CASE WHEN rl_ids.id ~ '^[0-9]{1,18}$' THEN (rl_ids.id)::bigint END
  FROM (SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL) rl_ids) AND rl_x."pHash" IS NOT NULL
      ))
    )
  ) and NOT (
    EXISTS (
      SELECT 1 FROM "EvidenceHoldImage" eh_h JOIN "Image" eh_i ON eh_i.id = eh_h."imageId"
      WHERE eh_i.url = img."url"
    )
    OR EXISTS (
      SELECT 1 FROM "EvidenceHoldImage" eh_h
      JOIN "ImageCdnModeratorDelete" eh_d ON eh_d."imageId" = eh_h."imageId"
      WHERE eh_d.url = img."url"
    )
  ) and not exists (select 1 as "one" from "EvidenceHoldPost" as "ehp" where "ehp"."postId" = "img"."postId") and not exists (select 1 as "one" from "ImageFlag" as "f" where "f"."imageId" = "img"."id" and ("f"."promptNsfw" = true or "f"."resourcesNsfw" = true)) and not exists (select 1 as "one" from "User" as "u" where "u"."id" = "img"."userId" and ("u"."bannedAt" is not null or "u"."deletedAt" is not null or "u"."muted" = true)) and not exists (select 1 as "one" from "ImageResourceNew" as "irn" inner join "ModelVersion" as "mv" on "mv"."id" = "irn"."modelVersionId" inner join "Model" as "m" on "m"."id" = "mv"."modelId" where "irn"."imageId" = "img"."id" and ("m"."minor" = true or "m"."poi" = true))), false) as "skillCheckLasting" from "Image" as "img" inner join "Post" as "p" on "p"."id" = "img"."postId"
-- end generated
;

REVOKE ALL ON public."KnightsImageGate" FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.knights_ensure_vote_partition(p_year integer, p_month integer)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  month_start date;
  this_month date := date_trunc('month', now())::date;
BEGIN
  IF p_year IS NULL OR p_month IS NULL OR p_month NOT BETWEEN 1 AND 12 THEN
    RAISE EXCEPTION 'knights_ensure_vote_partition: no month %-%', p_year, p_month;
  END IF;
  month_start := make_date(p_year, p_month, 1);
  IF month_start < this_month - interval '1 month' OR month_start > this_month + interval '3 months' THEN
    RAISE EXCEPTION 'knights_ensure_vote_partition: % is outside the previous month to three months ahead', month_start;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('KnightsVote partitions'));
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public."KnightsVote" FOR VALUES FROM (%L) TO (%L)',
    'KnightsVote_' || to_char(month_start, 'YYYY_MM'),
    month_start,
    (month_start + interval '1 month')::date
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.knights_ensure_vote_partition(integer, integer) FROM PUBLIC;

-- knights_app is created outside this repo; re-run this block once it exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'knights_app') THEN
    GRANT SELECT ON public."KnightsImageGate" TO knights_app;
    GRANT EXECUTE ON FUNCTION public.knights_ensure_vote_partition(integer, integer) TO knights_app;
  END IF;
END
$$;

COMMIT;

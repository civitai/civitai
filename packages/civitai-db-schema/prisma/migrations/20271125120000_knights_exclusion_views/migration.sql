-- Id-only views for the Knights app's moderator-review eligibility check.
--
-- The Knights app excludes from its review queues every image whose owner is held, every image
-- listed on a CsamReport and every image with an open report. It reads these three views instead of
-- "CsamReport", "EvidenceHeldUser", "Report" and "ImageReport", so it sees only the ids it excludes,
-- never a report's details, reporter or dates. Each view returns one column and nothing else, and
-- never a NULL (one NULL would make every `NOT IN` over it unknown). An id can appear more than once.
--
-- Each view is the set its helper in packages/civitai-shared/src/held-media.ts (or the open-report
-- check) decides, so the app's exclusions match the rest of the site. A change to `heldUserSql` or
-- `CSAM_REPORT_LISTED_IMAGE_IDS_SQL` needs the same change here, in a new migration:
-- src/server/services/__tests__/knights-exclusion-views.test.ts loads this file and fails when the
-- two disagree.
--
-- The views depend on "CsamReport"."userId", "details" and "images", "Report"."status" and "id",
-- "ImageReport"."imageId" and "reportId", and the "EvidenceHeldUser" view: a later migration that
-- alters or replaces any of them must drop and recreate these views.
--
-- security_barrier: a reader's own conditions run only on rows a view returns. Such a view is not
-- flattened into the query reading it, so a per-row check written as a correlated
-- `NOT EXISTS (SELECT 1 FROM view v WHERE v.id = x)` plans as an anti-join over the whole view.
-- Check per row with a scalar subquery instead, which gets an index lookup:
--   (SELECT 1 FROM "KnightsOpenReportImage" o WHERE o."imageId" = img.id LIMIT 1) IS NULL
--
-- Needs 20261019220000_evidence_hold ("EvidenceHeldUser"). Applied by hand per environment;
-- idempotent. Read access to the views is managed outside this repo.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- `heldUserSql`'s three legs: a report's subject, a report's numeric secondary user, and an active
-- evidence hold. The CASE as well as the filter, as there: Postgres may cast before it tests the
-- pattern, and one malformed value would fail every read.
CREATE OR REPLACE VIEW "KnightsHeldUser" ("userId") WITH (security_barrier = true) AS
SELECT hr."userId"::bigint
FROM "CsamReport" hr
WHERE hr."userId" IS NOT NULL
UNION ALL
SELECT CASE WHEN hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
            THEN (hs.details ->> 'secondaryUserId')::bigint END
FROM "CsamReport" hs
WHERE hs.details ->> 'secondaryUserId' ~ '^[0-9]{1,18}$'
UNION ALL
SELECT he."userId"::bigint
FROM "EvidenceHeldUser" he
WHERE he."userId" IS NOT NULL;

-- `CSAM_REPORT_LISTED_IMAGE_IDS_SQL`, as written there: text ids.
CREATE OR REPLACE VIEW "KnightsCsamListedImage" ("imageId") WITH (security_barrier = true) AS
SELECT listed.id FROM (
    SELECT CASE jsonb_typeof(le) WHEN 'object' THEN le ->> 'id' ELSE le #>> '{}' END AS id
    FROM "CsamReport" lr
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(lr.images) = 'array' THEN lr.images ELSE '[]'::jsonb END
    ) le
  ) listed
  WHERE listed.id IS NOT NULL;

-- Images with a report still Pending or Processing.
CREATE OR REPLACE VIEW "KnightsOpenReportImage" ("imageId") WITH (security_barrier = true) AS
SELECT ir."imageId"
FROM "ImageReport" ir
JOIN "Report" r ON r.id = ir."reportId"
WHERE r.status IN ('Pending', 'Processing');

COMMENT ON VIEW "KnightsHeldUser" IS
  'Id-only, for the Knights app: the users heldUserSql treats as held (named on a CsamReport, or under an active evidence hold).';
COMMENT ON VIEW "KnightsCsamListedImage" IS
  'Id-only, for the Knights app: every image id (text) listed on any CsamReport.';
COMMENT ON VIEW "KnightsOpenReportImage" IS
  'Id-only, for the Knights app: every image with a Pending or Processing report.';

COMMIT;

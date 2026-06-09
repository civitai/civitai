-- Clamp ModelVersion.publishedAt and resync Model.lastVersionAt where prior
-- republishes bumped them past their original publish date. Companion to the
-- anti-bump guards added at the publish write sites (see commit notes /
-- ClickUp 868jne3fd). One-shot data fix — the application code now enforces
-- the "publishedAt is immutable once <= NOW()" invariant going forward.
--
-- NOTE: This file is for review/history only. Per the project migration
-- policy, this SQL is NOT applied automatically by `prisma migrate deploy`.
-- It must be applied manually to preview / staging / prod by a human.

BEGIN;

-- 1) Clamp ModelVersion.publishedAt where we have direct evidence of an
--    earlier publish that got bumped: a stashed `meta.unpublishedAt` (set by
--    the cron job that demoted the version to Draft, or by the unpublish
--    handler) is the tightest upper bound on the real publish date — you
--    cannot unpublish before publishing. `createdAt` is the *lower* bound
--    (publish can never precede creation), so it belongs in the floor
--    (`GREATEST`), not in the candidate list — using it as a candidate
--    collapses every row with an `unpublishedAt` to its creation timestamp
--    and loses the best evidence we have.
--
--    Scoped tightly: only Published rows where `meta.unpublishedAt` exists
--    AND `publishedAt` was bumped past it. Rows without the breadcrumb (no
--    evidence of a prior publish) or rows where publishedAt is still <=
--    unpublishedAt (not bumped) are left alone — this matches the bump-bug
--    story exactly and avoids no-op tuple rewrites on the rest of the table.
--    Scheduled rows (future publishedAt) are not touched — those are still
--    mutable by the invariant.
UPDATE "ModelVersion"
SET "publishedAt" = GREATEST(
  "createdAt",
  LEAST(
    "publishedAt",
    (meta->>'unpublishedAt')::timestamptz
  )
)
WHERE "publishedAt" IS NOT NULL
  AND "publishedAt" <= NOW()
  AND status = 'Published'
  AND meta->>'unpublishedAt' IS NOT NULL
  AND (meta->>'unpublishedAt')::timestamptz < "publishedAt";

-- 2) Resync Model.lastVersionAt to MAX(version.publishedAt) for models whose
--    versions were clamped in step 1. lastVersionAt drives the Newest-feed
--    sort (see model.service.ts orderBy on `mm."lastVersionAt"`); a bumped
--    version.publishedAt cascaded into lastVersionAt via
--    updateModelLastVersionAt and pinned the model to the top of the feed.
--
--    Scope is the set of modelIds whose versions step 1 touched — narrower
--    than "every model with drift" so legacy drift unrelated to the bump bug
--    (e.g. historical imports where Model.lastVersionAt was set manually)
--    is not rewritten here.
UPDATE "Model" m
SET "lastVersionAt" = sub.last_pub
FROM (
  SELECT "modelId", MAX("publishedAt") AS last_pub
  FROM "ModelVersion"
  WHERE status = 'Published'
    AND "publishedAt" IS NOT NULL
    AND "publishedAt" <= NOW()
  GROUP BY "modelId"
) sub
WHERE m.id = sub."modelId"
  AND m."lastVersionAt" IS DISTINCT FROM sub.last_pub
  AND m.id IN (
    SELECT DISTINCT "modelId"
    FROM "ModelVersion"
    WHERE "publishedAt" IS NOT NULL
      AND "publishedAt" <= NOW()
      AND status = 'Published'
      AND meta->>'unpublishedAt' IS NOT NULL
      AND (meta->>'unpublishedAt')::timestamptz < "publishedAt"
  );

-- 3) Reclassify legacy cron-demoted rows from Draft -> Unpublished.
--    The reset-to-draft-without-requirements job now writes 'Unpublished'
--    (see job source for rationale). Rows it touched under the old code path
--    remain status='Draft' with the job's breadcrumb keys; convert them so
--    the controller's `republishing` check (status !== Draft && != Scheduled)
--    fires correctly on the user's next republish — preventing an unintended
--    Model.lastVersionAt bump on what is semantically a republish, not a
--    first publish.
--
--    Scope is tight: we only touch rows that carry the job's own breadcrumb
--    keys (`unpublishedAt` set AND `unpublishedReason` is one the job emits).
--    Legitimate user-authored Drafts have no `unpublishedReason` and are not
--    affected.
UPDATE "ModelVersion"
SET status = 'Unpublished'::"ModelStatus"
WHERE status = 'Draft'::"ModelStatus"
  AND meta->>'unpublishedAt'     IS NOT NULL
  AND meta->>'unpublishedReason' IN ('no-files', 'no-posts');

UPDATE "Model" m
SET status = 'Unpublished'::"ModelStatus"
WHERE m.status = 'Draft'::"ModelStatus"
  AND m.meta->>'unpublishedAt'     IS NOT NULL
  AND m.meta->>'unpublishedReason' = 'no-versions';

COMMIT;

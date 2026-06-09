-- Clamp ModelVersion.publishedAt, Post.publishedAt, and resync
-- Model.lastVersionAt / Model.publishedAt where prior republishes bumped
-- them past their original publish date. Companion to the anti-bump guards
-- added at the publish write sites (see commit notes / ClickUp 868jne3fd).
-- One-shot data fix — the application code now enforces the "publishedAt is
-- immutable once <= NOW()" invariant going forward (Model, ModelVersion, Post).
--
-- !!! DO NOT RUN THIS SQL DIRECTLY !!!
--
-- Execution goes through the admin webhook endpoint:
--   POST /api/admin/temp/clamp-publishedat-bumps?token=$WEBHOOK_TOKEN&dryRun=true
--   POST /api/admin/temp/clamp-publishedat-bumps?token=$WEBHOOK_TOKEN
--
-- The endpoint runs this SQL inside a single transaction AND queues the
-- Meilisearch index updates (Model + Image docs both carry publishedAtUnix
-- and would otherwise stay stuck on the bumped sort keys) AND refreshes
-- dataForModelsCache + bustMvCache so feed reads pick up the new sort
-- without waiting for TTL. Running this file standalone leaves search +
-- caches stale and is not safe.
--
-- This file is kept for SQL review/history. Per the project migration
-- policy it is NOT applied automatically by `prisma migrate deploy`.
--
-- IMPORTANT: Scope for steps 1a/1b is captured upfront in temp tables
-- because the evidence those steps use to *find* bumped rows is the same
-- evidence the steps then *consume* by clamping. Without snapshotting,
-- downstream steps (2, 2b) that filter by the same modelIds would see an
-- empty set after 1a/1b ran inside the transaction.

BEGIN;

-- Snapshot bump-evidence rowsets BEFORE any clamp runs.
CREATE TEMP TABLE op1a_versions ON COMMIT DROP AS
SELECT id, "modelId"
FROM "ModelVersion"
WHERE "publishedAt" IS NOT NULL
  AND "publishedAt" <= NOW()
  AND status = 'Published'
  AND meta->>'unpublishedAt' IS NOT NULL
  AND (meta->>'unpublishedAt')::timestamptz < "publishedAt";

CREATE TEMP TABLE op1b_versions ON COMMIT DROP AS
SELECT DISTINCT mv.id, mv."modelId"
FROM "ModelVersion" mv
JOIN "Post" p ON p."modelVersionId" = mv.id
JOIN "Model" mm ON mm.id = mv."modelId" AND mm."userId" = p."userId"
WHERE mv.status = 'Published'
  AND mv."publishedAt" IS NOT NULL
  AND mv."publishedAt" <= NOW()
  AND p.metadata->>'unpublishedAt' IS NOT NULL
  AND p."publishedAt" IS NOT NULL
  AND p."publishedAt" < mv."publishedAt";

-- 1a) Clamp ModelVersion.publishedAt where we have direct evidence of an
--     earlier publish that got bumped: a stashed `meta.unpublishedAt` (set by
--     the cron job that demoted the version to Draft, or by the unpublish
--     handler) is the tightest upper bound on the real publish date — you
--     cannot unpublish before publishing. `createdAt` is the *lower* bound
--     (publish can never precede creation), so it belongs in the floor
--     (`GREATEST`), not in the candidate list — using it as a candidate
--     collapses every row with an `unpublishedAt` to its creation timestamp
--     and loses the best evidence we have.
UPDATE "ModelVersion"
SET "publishedAt" = GREATEST(
  "createdAt",
  LEAST(
    "publishedAt",
    (meta->>'unpublishedAt')::timestamptz
  )
)
WHERE id IN (SELECT id FROM op1a_versions);

-- 1b) Clamp ModelVersion.publishedAt using owner-post evidence for versions
--     where the version-level `meta.unpublishedAt` breadcrumb was stripped on
--     republish (controller destructure pattern in model-version.controller.ts
--     line ~580 removes `unpublishedAt`/`unpublishedBy` from version meta
--     before persisting). On those rows step 1a finds no breadcrumb on the
--     version itself, but the owner-attached Posts still carry their own
--     `metadata.unpublishedAt`. Post.publishedAt was preserved across the
--     unpublish/republish cycle via `prevPublishedAt` restore, so it gives
--     us the real original Post publish date — the version had to be public
--     when its owner-post was published, making MIN(owner-post.publishedAt)
--     a tight upper bound on the original version.publishedAt.
--
--     Only owner-attached posts count (`p.userId = m.userId`) so unrelated
--     image-only posts by other users on the same version don't pull the
--     clamp earlier than the real publish.
UPDATE "ModelVersion" mv
SET "publishedAt" = GREATEST(
  mv."createdAt",
  LEAST(
    mv."publishedAt",
    (
      SELECT MIN(p."publishedAt")
      FROM "Post" p
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE p."modelVersionId" = mv.id
        AND p."userId" = m."userId"
        AND p.metadata->>'unpublishedAt' IS NOT NULL
        AND p."publishedAt" IS NOT NULL
    )
  )
)
WHERE mv.id IN (SELECT id FROM op1b_versions);

-- 2) Resync Model.lastVersionAt to MAX(version.publishedAt) for models whose
--    versions were clamped in step 1a or 1b. lastVersionAt drives the
--    Newest-feed sort (see model.service.ts orderBy on `mm."lastVersionAt"`);
--    a bumped version.publishedAt cascaded into lastVersionAt via
--    updateModelLastVersionAt and pinned the model to the top of the feed.
--
--    Scope is the union of modelIds touched by 1a and 1b — narrower than
--    "every model with drift" so legacy drift unrelated to the bump bug
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
    SELECT "modelId" FROM op1a_versions
    UNION
    SELECT "modelId" FROM op1b_versions
  );

-- 2b) Clamp Model.publishedAt to MIN(version.publishedAt) for models touched
--     by step 1b. Model.publishedAt drives the "Published X ago" badge and
--     search-index `publishedAtUnix`; when a model went through the
--     unpublish-republish cycle, pre-fix code wrote model.publishedAt = NOW()
--     in the same transaction as the bumped version.publishedAt, so the
--     model value is bumped wherever the version is.
--
--     Restricted to 1b scope (post breadcrumb evidence) so we only touch
--     models where we have *direct* evidence the model went through the
--     unpublish cycle — broader Model.publishedAt drift (rows where
--     Model.publishedAt > MIN(version.publishedAt) without breadcrumbs) is
--     left alone here. Those numbers (~12k models with drift) almost
--     certainly include legitimate historical state we shouldn't rewrite.
UPDATE "Model" m
SET "publishedAt" = sub.first_pub
FROM (
  SELECT "modelId", MIN("publishedAt") AS first_pub
  FROM "ModelVersion"
  WHERE status = 'Published'
    AND "publishedAt" IS NOT NULL
    AND "publishedAt" <= NOW()
  GROUP BY "modelId"
) sub
WHERE m.id = sub."modelId"
  AND m."publishedAt" IS NOT NULL
  AND m."publishedAt" > sub.first_pub
  AND m.id IN (SELECT "modelId" FROM op1b_versions);

-- 3) Clamp Post.publishedAt where prior republishes bumped it past the
--    original publish date. Posts stash `metadata.prevPublishedAt` on
--    unpublish (unpublishModelById / unpublishModelVersionById set
--    `prevPublishedAt = "publishedAt"` before nulling publishedAt), so when
--    publishedAt > prevPublishedAt the post has been re-written past its
--    original date — almost certainly via the unguarded `updatePost` path
--    (post.service.ts), which spreads user-supplied `publishedAt` straight
--    into `prisma.post.update` without the anti-bump SQL guard. Controller
--    (`updatePostHandler`) only blocks re-write when current publishedAt is
--    set AND in past; unpublished posts (publishedAt=NULL) sail through.
--
--    `prevPublishedAt` is the authoritative original publish date — the
--    unpublish handler stashes the live `publishedAt` value verbatim. Floor
--    with createdAt defensively (some rows have prev_pub < createdAt due to
--    historical import quirks; without the floor the clamp could land
--    before the row physically existed).
--
--    Self-contained: WHERE filter encodes "is currently bumped past
--    prevPublishedAt", which only flips false once the UPDATE writes the
--    new value to the same row — single-row, single-pass. No transient-
--    evidence problem like steps 1a/1b have with downstream filters.
UPDATE "Post"
SET "publishedAt" = GREATEST(
  "createdAt",
  LEAST(
    "publishedAt",
    (metadata->>'prevPublishedAt')::timestamptz
  )
)
WHERE metadata->>'prevPublishedAt' IS NOT NULL
  AND "publishedAt" IS NOT NULL
  AND "publishedAt" > (metadata->>'prevPublishedAt')::timestamptz;

-- 4) Reclassify legacy cron-demoted rows from Draft -> Unpublished.
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

-- Two indexes on "Placement". They are unrelated to each other; they ship
-- together because both fell out of the same review of the remix-gallery
-- submit path.
--
-- 🔴 APPLY BY HAND, ONE STATEMENT AT A TIME. This repo does not run
--    `prisma migrate deploy`. CONCURRENTLY cannot run inside a transaction
--    block, and `psql -c` with two statements opens one implicitly, so the
--    server refuses. A cancelled CONCURRENTLY build leaves an INVALID index
--    behind: check `pg_index.indisvalid`, not the command's exit code, and drop
--    an invalid one before retrying.

-- ============================================================
-- 1. One image, one gallery — enforced by the DATABASE
-- ============================================================
-- `assertNotAlreadySubmitted` is a `findFirst` and the insert is five statements
-- later, with no transaction and no lock between them. Two concurrent submits of
-- the same (gallery, image) both read nothing, both insert, and both take an
-- escrow hold against different placement ids: the submitter is charged twice,
-- occupies two slots of one gallery with one picture, and on decline pays the
-- owner two decline fees. That is precisely the abuse the read-side guard's
-- docblock says it exists to prevent, and nothing behind it enforced it —
-- `Placement` carries seven indexes and no unique constraint.
--
-- Scoped to the two live statuses so the app-level guard and the database agree
-- exactly. A declined or expired submission may be made again; only a submission
-- that is currently pending or approved occupies a slot.
--
-- Safe to build: measured on prod 2026-09-01, 893 rows match the predicate and
-- 893 distinct keys — zero duplicates. Re-run that count before applying if this
-- sits unapplied for long, because a duplicate makes the build fail rather than
-- the constraint fail.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Placement_surface_target_image_live_key"
  ON "Placement" (surface, "targetType", "targetId", (data ->> 'imageId'))
  WHERE status IN ('pending', 'approved') AND (data ->> 'imageId') IS NOT NULL;

-- ============================================================
-- 2. The undelivered notification's own lookup
-- ============================================================
-- `remix-gallery-undelivered` selects expired remix-gallery placements carrying
-- the `undeliverable` marker, resolved since the last send. Measured on prod
-- 2026-09-01 without this index:
--
--   Index Scan using "Placement_surface_targetType_targetId_status_idx"
--     Index Cond: (surface='remixGallery' AND "targetType"='image' AND status='expired')
--     Filter: ("resolvedAt" > $1 AND (data ->> 'undeliverable') = 'true')
--     Rows Removed by Filter: 116
--     Buffers: shared hit=119
--
-- The same three complaints as `20260827070000`: `targetId` is skipped in the
-- composite index so `status` is an in-index recheck rather than a scan
-- boundary, and both selective predicates are heap filters. 119 buffers to
-- return nothing.
--
-- It matters more than that plan looks, because `send-notifications` runs
-- `*/1` — 1,440 times a day against the readiness job's 288 — and the cost
-- grows with every remix-gallery placement that has ever expired, with no time
-- bound. The sibling `Placement_resolvedAt_approved_idx` exists because this was
-- already hit once on the approved side.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Placement_resolvedAt_undelivered_idx"
  ON "Placement" ("resolvedAt")
  WHERE "targetType" = 'image'
    AND status = 'expired'
    AND (data ->> 'undeliverable') = 'true';

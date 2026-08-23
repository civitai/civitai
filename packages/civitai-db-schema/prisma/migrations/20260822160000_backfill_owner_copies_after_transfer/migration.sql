-- Backfill: the two denormalised owner copies that model transfers used to leave behind.
--
-- NOT AUTO-APPLIED. Migrations in this repo are run by hand — see CLAUDE.md → Database.
--
-- PaidAccess.ownerId and DonationGoal.userId are denormalised copies of Model.userId. Model transfers
-- moved the model and left both copies behind; the transfer now moves them in the same transaction
-- (src/server/services/model.service.ts). This resyncs anything transferred before that.
--
-- Both statements are idempotent and no-ops once the transfer fix is deployed. Safe to run before or
-- after that deploy: each only ever moves a row to the owner the model already has.
--
-- Expected size, measured on the prod PRIMARY 2026-08-23: 0 rows, both tables. This has never had
-- anything to remediate, and it is kept only for a transfer that lands before the fix deploys.
--
-- 🔴 An earlier revision of this file reported 92 DonationGoal rows (68 active) as transfer drift.
-- That was wrong, and running it would have been harmful. All 92 resolve to Model.userId = -1 (the
-- `civitai` system account) with a DELETED account still named on the goal: they are account-deletion
-- residue, where deletion reassigns the model and leaves the goal behind. Resyncing them would have
-- moved 68 ACTIVE goals onto the system account, and donateToGoal pays goal.userId. Hence the
-- `m."userId" <> -1` guard below — this statement fixes transfer drift and nothing else.
-- The deleted-account goals are being handled separately (Justin's call: delete them, not re-own them).

-- Counts, before changing anything:
--   SELECT COUNT(*) FROM "PaidAccess" pa
--     JOIN "ModelVersion" mv ON mv.id = pa."entityId"
--     JOIN "Model" m ON m.id = mv."modelId"
--    WHERE pa."entityType" = 'ModelVersion' AND pa."ownerId" <> m."userId";
--
--   SELECT COUNT(DISTINCT dg.id) AS total, COUNT(DISTINCT dg.id) FILTER (WHERE dg.active) AS active
--     FROM "DonationGoal" dg
--     JOIN "ModelVersion" mv ON (dg."modelVersionId" = mv.id
--                            OR (dg."entityType" = 'ModelVersion' AND dg."entityId" = mv.id))
--     JOIN "Model" m ON m.id = mv."modelId"
--    WHERE m."userId" <> -1 AND dg."userId" <> m."userId";
--
-- Drop the `m."userId" <> -1` from that count and it reports the deleted-account rows too — which is
-- how the wrong number above was produced. Group by m."userId" before believing a nonzero result.

UPDATE "PaidAccess" pa
SET "ownerId" = m."userId", "updatedAt" = NOW()
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE pa."entityType" = 'ModelVersion'
  AND pa."entityId" = mv.id
  AND pa."ownerId" <> m."userId";

-- The goal's target is dual-written (legacy modelVersionId + polymorphic entityType/entityId), so both
-- spellings move. Two statements rather than one OR: an OR across them makes the planner drive from
-- DonationGoal and seq-scan the whole table (176ms/155k buffers on prod, against ~20ms/3k split), and
-- the `userId <> m."userId"` guard makes the second a no-op for anything the first already moved.
-- The ORDER is load-bearing: for a goal whose two spellings point at versions of DIFFERENT models, the
-- second statement wins, so the polymorphic target decides the owner. That is the going-forward
-- identity and the column phase 2 keeps. Swapping these two silently flips that precedence.
-- Inactive and completed goals move too: a stale userId on one has no upside, and it can be reactivated.
UPDATE "DonationGoal" dg
SET "userId" = m."userId"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE dg."modelVersionId" = mv.id
  AND m."userId" <> -1
  AND dg."userId" <> m."userId";

UPDATE "DonationGoal" dg
SET "userId" = m."userId"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE dg."entityType" = 'ModelVersion'
  AND dg."entityId" = mv.id
  AND m."userId" <> -1
  AND dg."userId" <> m."userId";

-- After running: purge the caches that carry an owner, or they serve the old one until they expire.
--   packed:caches:entity-availability:model-versions:*   Model.userId, TTL 1 DAY — the longest-lived
--   packed:caches:paid-access:ModelVersion:*             the gate row (TTL 1h, SWR off)
--   packed:caches:paid-access:ModelSales:*               the model-card sale badge
--   the modelVersionPublicDonationGoals cache            carries the goal's userId
--
-- ComicChapter PaidAccess rows are deliberately untouched: nothing transfers a comic's owner, so a
-- mismatch there would mean something else is wrong and should not be papered over by this.
--
-- Donation rows are history and are NOT retargeted — only who the NEXT donation pays changes.

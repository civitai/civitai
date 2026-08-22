-- Backfill: the two denormalised owner copies that model transfers used to leave behind.
--
-- NOT AUTO-APPLIED. Migrations in this repo are run by hand — see CLAUDE.md → Database.
--
-- transferModelOwnership moved Model.userId and left both of these on the previous owner:
--
--   PaidAccess.ownerId   decides who generates free from a gated version and whose scheduled sales may
--                        reprice it, while the model-card sale badge resolves the owner from
--                        Model.userId — so a stale row makes those two answers disagree.
--   DonationGoal.userId  is who a donation PAYS (donation-goal.service). A stale row means a donation
--                        made on the new owner's model page pays the previous owner.
--
-- Both statements are idempotent and no-ops once the transfer fix is deployed. Safe to run before or
-- after that deploy: each only ever moves a row to the owner the model already has.
--
-- Measured on the prod replica 2026-08-22, before the fix shipped:
--   PaidAccess    0 stale, against 4773 ModelVersion gates that all matched and 0 orphans (so the
--                 query could see a mismatch, and there were none)
--   DonationGoal  92 stale, 68 of them still active, against 21996 that matched

-- Counts, before changing anything:
--   SELECT COUNT(*) FROM "PaidAccess" pa
--     JOIN "ModelVersion" mv ON mv.id = pa."entityId"
--     JOIN "Model" m ON m.id = mv."modelId"
--    WHERE pa."entityType" = 'ModelVersion' AND pa."ownerId" <> m."userId";
--
--   SELECT COUNT(*) FILTER (WHERE dg.active) AS active, COUNT(*) AS total
--     FROM "DonationGoal" dg
--     JOIN "ModelVersion" mv ON mv.id = dg."modelVersionId"
--     JOIN "Model" m ON m.id = mv."modelId"
--    WHERE dg."userId" <> m."userId";

UPDATE "PaidAccess" pa
SET "ownerId" = m."userId", "updatedAt" = NOW()
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE pa."entityType" = 'ModelVersion'
  AND pa."entityId" = mv.id
  AND pa."ownerId" <> m."userId";

-- The goal's target is dual-written (legacy modelVersionId + polymorphic entityType/entityId), so both
-- spellings are matched. Inactive and completed goals move too: a stale userId on one has no upside,
-- and a goal can be reactivated.
UPDATE "DonationGoal" dg
SET "userId" = m."userId"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE (
    dg."modelVersionId" = mv.id
    OR (dg."entityType" = 'ModelVersion' AND dg."entityId" = mv.id)
  )
  AND dg."userId" <> m."userId";

-- After running: purge the caches, or the previous owner is authorised — and displayed — for up to
-- another hour.
--   packed:caches:paid-access:ModelVersion:*                 the gate row (TTL 1h, SWR off)
--   packed:caches:paid-access:ModelSales:*                   the model-card sale badge
--   the modelVersionPublicDonationGoals cache                carries the goal's userId
--
-- ComicChapter PaidAccess rows are deliberately untouched: nothing transfers a comic's owner, so a
-- mismatch there would mean something else is wrong and should not be papered over by this.
--
-- Donation rows are history and are NOT retargeted — only who the NEXT donation pays changes.

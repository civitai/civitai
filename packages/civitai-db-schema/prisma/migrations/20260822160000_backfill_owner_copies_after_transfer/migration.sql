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
-- Expected size, measured on the prod replica 2026-08-22:
--   PaidAccess    0 rows out of step, against 4773 ModelVersion gates in step and 0 orphans (so the
--                 query could see one, and there were none)
--   DonationGoal  92 rows out of step (68 active), against 21996 in step. Counted with the same
--                 predicate the statements below use — 0 rows are polymorphic-only today, so both
--                 spellings give the same number, but only the wider one stays true once phase 2
--                 drops modelVersionId.

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
--    WHERE dg."userId" <> m."userId";

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
  AND dg."userId" <> m."userId";

UPDATE "DonationGoal" dg
SET "userId" = m."userId"
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE dg."entityType" = 'ModelVersion'
  AND dg."entityId" = mv.id
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

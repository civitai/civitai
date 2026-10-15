-- Storylines: an owner can appeal a takedown made by the title scan, so `Appeal.entityType` needs a
-- value for a storyline.
--
-- Idempotent: applied by hand, possibly more than once.
--
-- 🔴 APPLY BEFORE THE DEPLOY THAT USES IT: the new code filters appeals by this value, and Postgres
-- refuses an enum label it does not have, which would fail the owner's page of a taken-down
-- storyline. Safe ahead of the code: no row uses the value until that code writes one. Additive;
-- appended last, so no existing label moves.
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'Storyline';

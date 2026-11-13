-- Storylines: an owner can appeal a title-scan takedown, so `Appeal.entityType` needs a Storyline value.
-- Idempotent: applied by hand, possibly more than once.
-- 🔴 APPLY BEFORE THE DEPLOY THAT USES IT: the new code filters appeals by this value, and Postgres
-- rejects an enum label it does not have, which would fail the page of a taken-down storyline. Safe
-- ahead of the code: no row carries the value until that code writes one.
ALTER TYPE "EntityType" ADD VALUE IF NOT EXISTS 'Storyline';

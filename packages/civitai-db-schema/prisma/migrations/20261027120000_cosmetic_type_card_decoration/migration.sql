-- Idempotent: applied by hand, possibly more than once.
--
-- A glow around the creator card, in its own slot so it stacks with a badge. First granted by the
-- Mythic Creator Score tier (20261027130000_creator_milestone_mythic); sellable through the shop.
--
-- 🔴 APPLY AFTER THE REGENERATED CLIENT DEPLOYS, and before the Mythic data migration: Prisma
-- throws on reading an enum label it does not know, so no row may use this value until every pod
-- can decode it.
ALTER TYPE "CosmeticType" ADD VALUE IF NOT EXISTS 'CardDecoration';

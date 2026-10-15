-- Idempotent: applied by hand, possibly more than once.
--
-- 🔴 APPLY AFTER THE REGENERATED CLIENT DEPLOYS: Prisma throws on reading an enum label it does not
-- know, so no row may use this value until every pod can decode it.
ALTER TYPE "CosmeticType" ADD VALUE IF NOT EXISTS 'CardDecoration';

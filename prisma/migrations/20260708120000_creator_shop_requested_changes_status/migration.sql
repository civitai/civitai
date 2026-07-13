-- Adds the `RequestedChanges` review outcome (re-submittable), distinct from
-- `Rejected` (terminal), for Creator Shop items.
-- NOTE: applied manually (we do not run `prisma migrate deploy`).
ALTER TYPE "CosmeticShopItemStatus" ADD VALUE IF NOT EXISTS 'RequestedChanges' BEFORE 'Archived';

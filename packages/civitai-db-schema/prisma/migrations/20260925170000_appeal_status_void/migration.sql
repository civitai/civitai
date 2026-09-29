-- Apply only AFTER the build carrying the regenerated client is deployed: Prisma rejects an
-- unknown enum label on read, and void-orphaned-appeals starts writing it on its next run.
ALTER TYPE "AppealStatus" ADD VALUE IF NOT EXISTS 'Void';

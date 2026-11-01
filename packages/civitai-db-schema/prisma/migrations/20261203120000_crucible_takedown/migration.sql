-- Apply by hand, BEFORE the deploy that ships these columns: Prisma selects every scalar column on
-- any crucible query without an explicit `select`, so new code against an old table errors.
-- Old code ignores the columns, so applying them early is safe. Idempotent.
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "takenDownAt" TIMESTAMP(3);
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "takenDownById" INTEGER;
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "takedownReason" TEXT;
-- A constant default makes this a metadata-only change; it does not rewrite the table.
ALTER TABLE "Crucible" ADD COLUMN IF NOT EXISTS "takedownRefundsCreator" BOOLEAN NOT NULL DEFAULT false;

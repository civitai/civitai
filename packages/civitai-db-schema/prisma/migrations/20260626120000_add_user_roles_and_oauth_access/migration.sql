-- OAuth login gating + generic per-user roles.
--
-- `OauthClient.accessMode` controls who may complete the /authorize flow for a client:
--   "open"     — anyone (default; preserves current behaviour)
--   "testers"  — only users holding the "tester" role in "UserRole"
--   "disabled" — no one
-- First-party (spoke) clients have no OauthClient row, so they are never gated by this.
--
-- "UserRole" is a generic (userId, role) grant table read directly by the auth hub.
--
-- Applied MANUALLY (this repo does not use `prisma migrate deploy`), so the DDL is idempotent — re-running
-- it on a DB where the column/table already exists is a no-op rather than an error.

ALTER TABLE "OauthClient" ADD COLUMN IF NOT EXISTS "accessMode" TEXT NOT NULL DEFAULT 'open';

CREATE TABLE IF NOT EXISTS "UserRole" (
    "userId" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "note" TEXT,
    "addedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId", "role")
);

CREATE INDEX IF NOT EXISTS "UserRole_role_idx" ON "UserRole"("role");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserRole_userId_fkey'
  ) THEN
    ALTER TABLE "UserRole"
      ADD CONSTRAINT "UserRole_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Auth hub: emailed sign-in invites from system apps (POST /api/auth/invite).
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Apply it before the auth hub build that sends invites deploys; nothing else reads the table.
-- Additive and idempotent; safe to re-run.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "OauthInvite" (
    "tokenHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "returnUrl" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OauthInvite_pkey" PRIMARY KEY ("tokenHash")
);

CREATE INDEX IF NOT EXISTS "OauthInvite_clientId_email_idx" ON "OauthInvite"("clientId", "email");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OauthInvite_clientId_fkey') THEN
    ALTER TABLE "OauthInvite" ADD CONSTRAINT "OauthInvite_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "OauthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

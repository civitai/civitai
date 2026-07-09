-- Add OAuth token types (idempotent — may already exist from prior migration)
DO $$ BEGIN
  ALTER TYPE "ApiKeyType" ADD VALUE IF NOT EXISTS 'Access';
  ALTER TYPE "ApiKeyType" ADD VALUE IF NOT EXISTS 'Refresh';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- OAuth Client registration
CREATE TABLE "OauthClient" (
    "id" TEXT NOT NULL,
    "secret" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "logoUrl" TEXT,
    "redirectUris" TEXT[] NOT NULL DEFAULT '{}',
    "grants" TEXT[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
    "allowedScopes" INTEGER NOT NULL DEFAULT 33554431,
    "isConfidential" BOOLEAN NOT NULL DEFAULT true,
    "userId" INTEGER NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OauthClient_pkey" PRIMARY KEY ("id")
);

-- OAuth Consent records (remember user's authorization decision)
CREATE TABLE "OauthConsent" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,
    "scope" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OauthConsent_pkey" PRIMARY KEY ("id")
);

-- Link API keys to OAuth clients (null = user-created key)
ALTER TABLE "ApiKey" ADD COLUMN "clientId" TEXT;

-- Foreign keys
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "OauthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "OauthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes
CREATE UNIQUE INDEX "OauthConsent_userId_clientId_key" ON "OauthConsent"("userId", "clientId");
CREATE INDEX "OauthClient_userId_idx" ON "OauthClient"("userId");
CREATE INDEX "ApiKey_clientId_idx" ON "ApiKey"("clientId");

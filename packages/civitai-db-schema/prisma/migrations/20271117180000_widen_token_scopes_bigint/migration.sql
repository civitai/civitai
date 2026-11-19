-- Token scopes past bit 30: scope bitmasks become bigint.
--
-- Apply BEFORE the code that reads and writes these columns deploys. Every step is re-runnable.
--
-- "ApiKey" is a large table and also holds OAuth access and refresh tokens, so its existing
-- "tokenScope" integer column is left alone. A nullable bigint column with no default is added
-- beside it: a catalog-only change, no table rewrite. New code writes both columns (the whole
-- scope here, the low 31 bits in "tokenScope") and reads "tokenScopeWide" first, so pods still on
-- the previous build keep reading "tokenScope". No backfill: every existing row fits "tokenScope".
--
-- "OauthClient"."allowedScopes" and "OauthConsent"."scope" are small tables; each type change
-- rewrites its table under an ACCESS EXCLUSIVE lock, briefly.
SET lock_timeout = '3s';

ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "tokenScopeWide" BIGINT;

ALTER TABLE "OauthClient" ALTER COLUMN "allowedScopes" TYPE BIGINT;

ALTER TABLE "OauthConsent" ALTER COLUMN "scope" TYPE BIGINT;

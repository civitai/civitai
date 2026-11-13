-- Staff-managed settings for system OAuth apps (owned by the civitai system account, User id -1 — the
-- first-party convention), edited on the auth hub's admin OAuth Apps page.
--
-- `OauthClient.skipConsent`: signed-in users go straight through /authorize with no consent screen, as
--   first-party (spoke) clients already do. Off for every existing app.
-- `OauthClient.tokenRateLimit`: the app's own /oauth/token limit per minute, used once a request is past the
--   per-IP limit and the client has proved its secret. Null (every existing app) = the per-IP limit only.
--
-- Apply BEFORE deploying code that reads these columns: the regenerated clients select them.
-- Applied MANUALLY, so the DDL is idempotent.

ALTER TABLE "OauthClient" ADD COLUMN IF NOT EXISTS "skipConsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OauthClient" ADD COLUMN IF NOT EXISTS "tokenRateLimit" INTEGER;

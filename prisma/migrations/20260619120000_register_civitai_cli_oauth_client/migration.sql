-- Register the first-party `civitai-cli` OAuth client.
--
-- This is a PUBLIC (no-secret) client used by the official `civitai` CLI to log
-- in via the OAuth device-authorization grant (RFC 8628) and obtain a token that
-- the App Blocks submit endpoint (api/v1/blocks/submit-version) accepts. The CLI
-- hardcodes the stable client id `civitai-cli`.
--
-- allowedScopes = TokenScope.UserRead | TokenScope.AppBlocksSubmit
--               = 1 | 33554432
--               = 33554433
-- (AppBlocksSubmit, bit 25 = 1<<25 = 33554432, is opt-in and INTENTIONALLY
--  excluded from TokenScope.Full = 33554431. This client is the only first-party
--  consumer that requests it.)
--
-- Owner: the civitai system account (User id -1) — the first-party convention.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING on the PK so re-applying is a no-op. The
-- WHERE EXISTS guard avoids an FK violation if the civitai system User row is
-- absent in a given environment (in that case this inserts nothing and the row
-- must be created manually with a valid owner userId).
--
-- ⚠️ MANUAL-APPLY: per the cluster ops rule, civitai DB migrations are NOT
-- auto-applied. A human applies this to prod (CNPG nvme0) and the dev clone.
INSERT INTO "OauthClient" (
  "id",
  "secret",
  "name",
  "description",
  "logoUrl",
  "redirectUris",
  "allowedOrigins",
  "grants",
  "allowedScopes",
  "isConfidential",
  "userId",
  "isVerified",
  "createdAt",
  "updatedAt"
)
SELECT
  'civitai-cli',
  NULL,
  'Civitai CLI',
  'Official Civitai command-line tool. Used to submit App Blocks for review and manage your apps from the terminal.',
  NULL,
  ARRAY['http://127.0.0.1/callback', 'http://localhost/callback']::TEXT[],
  ARRAY[]::TEXT[],
  ARRAY['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']::TEXT[],
  33554433,
  false,
  -1,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "User" WHERE "id" = -1)
ON CONFLICT ("id") DO NOTHING;

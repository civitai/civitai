-- Register the first-party `civitai-link-desktop` OAuth client.
--
-- This is a PUBLIC (no-secret) client used by the Civitai Link desktop app to sign in via the
-- OAuth device-authorization grant (RFC 8628). It replaces the six-character pairing code: the
-- app introduces itself to link-service with the resulting access token, link-service
-- introspects it against the hub, and mints the instance key. The app hardcodes the stable
-- client id `civitai-link-desktop`.
--
-- authorization_code is deliberately ABSENT: the app has no deep-link handler, so it cannot
-- receive a redirect. Device grant + refresh_token only.
--
-- allowedScopes = TokenScope.UserRead | VaultRead | VaultWrite | LinkConnect
--               = 1 | 8388608 | 16777216 | 134217728
--               = 159383553
-- (LinkConnect, bit 27 = 1<<27 = 134217728, is opt-in and INTENTIONALLY excluded from
--  TokenScope.Full = 33554431. VaultRead/VaultWrite replace the hand-pasted API key the app
--  used for Vault and /api/v1/me.)
--
-- Owner: the civitai system account (User id -1) — the first-party convention.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING on the PK so re-applying is a no-op. The WHERE EXISTS guard
-- avoids an FK violation if the civitai system User row is absent in a given environment (in
-- that case this inserts nothing and the row must be created manually with a valid owner userId).
--
-- ⚠️ MANUAL-APPLY: per the cluster ops rule, civitai DB migrations are NOT auto-applied. A human
-- applies this to prod (CNPG nvme0) and the dev clone.
--
-- ⚠️ ORDER: apply this AFTER the hub deploy that ships TokenScope.LinkConnect. A hub whose
-- ALL_SCOPES still stops at bit 26 clamps a requested 159383553 to 0 and answers invalid_scope.
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
  "accessMode",
  "userId",
  "isVerified",
  "createdAt",
  "updatedAt"
)
SELECT
  'civitai-link-desktop',
  NULL,
  'Civitai Link',
  'Official Civitai Link desktop app. Connects your local Stable Diffusion install to Civitai so you can send models to it from the site, and reads your Vault.',
  NULL,
  ARRAY[]::TEXT[],
  ARRAY[]::TEXT[],
  ARRAY['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']::TEXT[],
  159383553,
  false,
  'open',
  -1,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "User" WHERE "id" = -1)
ON CONFLICT ("id") DO NOTHING;

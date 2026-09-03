-- Register the first-party `civitai-link-service` OAuth client.
--
-- This is a CONFIDENTIAL client, and it is the ONLY caller of POST /api/auth/oauth/introspect.
-- link-service presents it as HTTP Basic to introspect the Civitai Link desktop app's access token
-- before it mints an instance key. It never runs a user-facing flow, so:
--
--   grants        = []  — no authorization_code, no device_code, no refresh. No bearer token can ever
--                        be minted FOR this client; it only authenticates itself to introspection.
--   allowedScopes = 0   — the ceiling for tokens issued to this client, which is moot given grants:[].
--                        Deliberately not `Full`, so it can never become a superset of it.
--
-- Owner: the civitai system account (User id -1) — the first-party convention, same as
-- `civitai-link-desktop`. Registering it through account settings instead would tie it to a real
-- person and mint a random uuid, which cannot be named in OAUTH_INTROSPECTION_CLIENT_IDS ahead of time.
--
-- ⚠️ `secret` IS NULL ON PURPOSE. The introspection endpoint reads
-- `if (!client?.isConfidential || !client.secret) return invalidClient()`, so until a secret is set the
-- client EXISTS and CANNOT AUTHENTICATE — it fails closed, it does not 500. Set it per environment with
-- a separate manual statement; it is never committed, and because the stored value is salted with that
-- environment's NEXTAUTH_SECRET the same input produces a different value in each one, so a value taken
-- from one environment is useless in another.
--
-- ⚠️ TWO MORE STEPS, or introspection stays down: give the same plaintext to link-service as
-- OAUTH_CLIENT_SECRET, and add this client id to the hub's OAUTH_INTROSPECTION_CLIENT_IDS allowlist.
-- That allowlist fails closed — a missing entry answers a flat 401, which reads like a broken
-- integration rather than a config gap.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING on the PK, so re-applying is a no-op and will NOT clobber a secret
-- already set. The WHERE EXISTS guard avoids an FK violation if the civitai system User row is absent in
-- a given environment (in that case this inserts nothing and the row must be created with a valid owner).
--
-- ⚠️ MANUAL-APPLY: per the cluster ops rule, civitai DB migrations are NOT auto-applied.
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
  'civitai-link-service',
  NULL,
  'Civitai Link Service',
  'First-party Civitai service that mints Civitai Link instance keys from an OAuth access token.',
  NULL,
  ARRAY[]::TEXT[],
  ARRAY[]::TEXT[],
  ARRAY[]::TEXT[],
  0,
  true,
  'open',
  -1,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "User" WHERE "id" = -1)
ON CONFLICT ("id") DO NOTHING;

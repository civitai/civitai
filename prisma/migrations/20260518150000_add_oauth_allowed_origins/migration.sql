-- Add per-client allowed-origins enforcement for OAuth public clients.
--
-- Public OAuth clients (isConfidential=false) currently rely on PKCE alone for
-- token-exchange identity because /api/auth/oauth/token responds with
-- Access-Control-Allow-Origin: *. This column lets us pin the token and revoke
-- endpoints to a registered set of browser origins, closing the residual
-- code-interception window that PKCE leaves open for browser-only public
-- clients.
--
-- For existing rows we backfill the allowedOrigins set from the origin part of
-- every redirectUri, so any currently-registered app continues to work without
-- a manual update from the owner. Confidential clients (the bulk of today's
-- traffic) skip the new check entirely.
ALTER TABLE "OauthClient" ADD COLUMN "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[];

UPDATE "OauthClient"
SET "allowedOrigins" = sub.origins
FROM (
  SELECT
    id,
    COALESCE(
      ARRAY(
        SELECT DISTINCT
          regexp_replace(uri, '^(https?://[^/]+).*$', '\1')
        FROM unnest("redirectUris") AS uri
        WHERE uri ~ '^https?://[^/]+'
      ),
      ARRAY[]::TEXT[]
    ) AS origins
  FROM "OauthClient"
) AS sub
WHERE "OauthClient".id = sub.id;

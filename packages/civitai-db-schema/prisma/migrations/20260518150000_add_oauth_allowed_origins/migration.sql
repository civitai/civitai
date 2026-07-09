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
-- every redirectUri (lowercased host, default ports stripped) so any
-- currently-registered app keeps working without a manual update. Custom-scheme
-- URIs (e.g. myapp://) yield no origin and fall back to the empty default —
-- owner must set via UI. Confidential clients (the bulk of today's traffic)
-- skip the runtime check entirely.
ALTER TABLE "OauthClient"
  ADD COLUMN "allowedOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "OauthClient"
SET "allowedOrigins" = sub.origins
FROM (
  SELECT
    "OauthClient".id,
    COALESCE(
      ARRAY(
        SELECT DISTINCT
          CASE
            WHEN lo LIKE 'https://%:443' THEN regexp_replace(lo, ':443$', '')
            WHEN lo LIKE 'http://%:80'   THEN regexp_replace(lo, ':80$', '')
            ELSE lo
          END
        FROM (
          -- `[^/?#]+` stops at the first /, ?, or # so URIs like
          -- `https://example.com?foo=1` don't backfill `https://example.com?foo=1`
          -- (browser Origin strips query/fragment). Case-insensitive on the
          -- scheme so `HTTPS://...` URIs aren't skipped before lowercasing.
          SELECT lower(regexp_replace(uri, '^(https?://[^/?#]+).*$', '\1')) AS lo
          FROM unnest("redirectUris") AS uri
          WHERE uri ~* '^https?://[^/?#]+'
        ) AS normalized
      ),
      ARRAY[]::TEXT[]
    ) AS origins
  FROM "OauthClient"
) AS sub
WHERE "OauthClient".id = sub.id;

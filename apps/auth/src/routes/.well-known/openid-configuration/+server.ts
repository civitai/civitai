import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { maybeCreateSessionSigner } from '@civitai/auth';
import { tokenScopeLabels } from '@civitai/auth/token-scope';

// GET /.well-known/openid-configuration — OIDC discovery. Ported from the main app's
// src/pages/api/.well-known/openid-configuration.ts. Authoritative now that the provider lives in the hub.
//
// `issuer` MUST equal the id_token `iss` (the hub signer sets it from AUTH_JWT_ISSUER) for RPs to accept
// the token, so it's pinned to AUTH_JWT_ISSUER (falling back to the request origin in dev/local). JWKS is
// advertised only when the hub ES256 keys are configured.
const oidcSigningEnabled = !!maybeCreateSessionSigner();

export const GET: RequestHandler = ({ url }) => {
  const issuer = env.AUTH_JWT_ISSUER || url.origin;

  return json(
    {
      issuer,
      authorization_endpoint: `${issuer}/api/auth/oauth/authorize`,
      token_endpoint: `${issuer}/api/auth/oauth/token`,
      userinfo_endpoint: `${issuer}/api/auth/oauth/userinfo`,
      revocation_endpoint: `${issuer}/api/auth/oauth/revoke`,
      device_authorization_endpoint: `${issuer}/api/auth/oauth/device`,
      ...(oidcSigningEnabled
        ? {
            jwks_uri: `${issuer}/.well-known/jwks.json`,
            // Must match the hub signer's algorithm (@civitai/auth sign.ts → ES256 / EC P-256).
            id_token_signing_alg_values_supported: ['ES256'],
          }
        : {}),
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
      scopes_supported: Object.keys(tokenScopeLabels),
      subject_types_supported: ['public'],
      claims_supported: ['sub', 'name', 'preferred_username', 'picture', 'email', 'email_verified'],
    },
    { headers: { 'Cache-Control': 'public, max-age=86400' } }
  );
};

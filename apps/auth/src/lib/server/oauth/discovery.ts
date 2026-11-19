import { env } from '$env/dynamic/private';
import { maybeCreateSessionSigner } from '@civitai/auth';
import { tokenScopeLabels } from '@civitai/auth/token-scope';
import { SUPPORTED_SCOPE_NAMES } from './scope';
import { TOKEN_EXCHANGE_GRANT } from './constants';

// The hub's authorization server metadata, served at both /.well-known/openid-configuration (OIDC
// discovery) and /.well-known/oauth-authorization-server (RFC 8414) from this one function.
//
// `issuer` MUST equal the id_token `iss` (the hub signer sets it from AUTH_JWT_ISSUER) for RPs to accept
// the token, so it's pinned to AUTH_JWT_ISSUER (falling back to the request origin in dev/local). JWKS is
// advertised only when the hub ES256 keys are configured.
const oidcSigningEnabled = !!maybeCreateSessionSigner();

export function authorizationServerMetadata(url: URL): Record<string, unknown> {
  const issuer = env.AUTH_JWT_ISSUER || url.origin;
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth/token`,
    userinfo_endpoint: `${issuer}/api/auth/oauth/userinfo`,
    revocation_endpoint: `${issuer}/api/auth/oauth/revoke`,
    introspection_endpoint: `${issuer}/api/auth/oauth/introspect`,
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
      TOKEN_EXCHANGE_GRANT,
    ],
    code_challenge_methods_supported: ['S256'],
    // The library authenticates a Basic header at /token.
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    // Scope names (and OIDC's openid/profile/email/offline_access), then the decimal bitmask values this
    // listed before, unchanged so nothing reading them sees a value disappear.
    scopes_supported: [...SUPPORTED_SCOPE_NAMES, ...Object.keys(tokenScopeLabels)],
    subject_types_supported: ['public'],
    claims_supported: ['sub', 'name', 'preferred_username', 'picture', 'email', 'email_verified'],
  };
}

export const DISCOVERY_HEADERS = { 'Cache-Control': 'public, max-age=86400' };

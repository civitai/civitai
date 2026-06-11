import { env } from '~/env/server';
import { tokenScopeNameToFlag } from '~/shared/constants/token-scope.constants';

/**
 * Shared OAuth/OIDC server metadata, used by both the OIDC discovery document
 * (`/.well-known/openid-configuration`) and the RFC 8414 authorization server
 * metadata document (`/.well-known/oauth-authorization-server`).
 *
 * `scopes_supported` uses the CANONICAL scope NAMES (RFC 6749 string scopes),
 * which is what the MCP server and DCR clients speak — NOT the internal bitmask
 * labels. `full` is excluded from the advertised list (it's an internal
 * umbrella, never requested by name over the wire).
 */
export function buildOAuthServerMetadata() {
  const issuer = env.NEXTAUTH_URL;

  return {
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth/token`,
    userinfo_endpoint: `${issuer}/api/auth/oauth/userinfo`,
    revocation_endpoint: `${issuer}/api/auth/oauth/revoke`,
    registration_endpoint: `${issuer}/api/auth/oauth/register`,
    device_authorization_endpoint: `${issuer}/api/auth/oauth/device`,
    response_types_supported: ['code'],
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'client_credentials',
      'urn:ietf:params:oauth:grant-type:device_code',
    ],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: Object.keys(tokenScopeNameToFlag).filter((name) => name !== 'full'),
  };
}

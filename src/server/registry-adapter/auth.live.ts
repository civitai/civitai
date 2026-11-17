import { getBearerTokenUser, getSessionFromBearerToken } from '~/server/auth/bearer-token';
import type { VerifyToken } from '~/server/registry-adapter/auth';
import {
  DEFAULT_HUB_ISSUER,
  createHubJwtVerifier,
  routeVerifyToken,
} from '~/server/registry-adapter/auth.jwt';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * The site's verification of an opaque registry token. The auth extension accepts OAuth access
 * tokens only, so this is the site's bearer lookup (`getSessionFromBearerToken`, the same one every
 * `/api/v1` route uses, which refuses an unknown, expired, revoked or client-credentials-only
 * token, and a banned user's) narrowed to an OAuth access token: one issued to a client on a
 * user's behalf. A personal or system API key is not an OAuth token and is refused.
 */
export const verifyOpaqueCivitaiToken: VerifyToken = async (token) => {
  const session = await getSessionFromBearerToken(token);
  if (
    !session?.user ||
    session.apiKeyType !== ApiKeyType.Access ||
    session.subject.type !== 'oauth'
  ) {
    return null;
  }
  return {
    subject: `user:${session.user.id}/client:${session.subject.id}`,
    user: session.user,
    expiresAt: session.expiresAt,
  };
};

export type CivitaiTokenConfig = {
  /** This source's resource identifier (REGISTRY_ADAPTER_RESOURCE_URL). Unset: no JWT is accepted. */
  resource: string | undefined;
  /** The hub's issuer identifier (AUTH_JWT_ISSUER); default {@link DEFAULT_HUB_ISSUER}. */
  issuer?: string;
  /** The hub's JWKS (AUTH_JWKS_URI); default `{issuer}/.well-known/jwks.json`. */
  jwksUri?: string;
};

/**
 * The site's verification of a registry token: a hub access token issued for this source
 * (`auth.jwt.ts`), or an opaque civitai OAuth access token ({@link verifyOpaqueCivitaiToken}).
 */
export function createCivitaiTokenVerifier(config: CivitaiTokenConfig): VerifyToken {
  const issuer = (config.issuer || DEFAULT_HUB_ISSUER).replace(/\/+$/, '');
  const jwksUri = config.jwksUri || `${issuer}/.well-known/jwks.json`;
  return routeVerifyToken({
    opaque: verifyOpaqueCivitaiToken,
    jwt: createHubJwtVerifier(
      { issuer, jwksUri, audience: config.resource || undefined },
      { loadUser: getBearerTokenUser }
    ),
  });
}

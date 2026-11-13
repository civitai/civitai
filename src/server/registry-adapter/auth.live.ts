import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import type { VerifyToken } from '~/server/registry-adapter/auth';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

/**
 * The site's verification of a registry token. The auth extension accepts OAuth access tokens
 * only, so this is the site's bearer lookup (`getSessionFromBearerToken`, the same one every
 * `/api/v1` route uses, which refuses an unknown, expired, revoked or client-credentials-only
 * token, and a banned user's) narrowed to an OAuth access token: one issued to a client on a
 * user's behalf. A personal or system API key is not an OAuth token and is refused.
 */
export const verifyCivitaiToken: VerifyToken = async (token) => {
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

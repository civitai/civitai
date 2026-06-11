import { dbWrite } from '~/server/db/client';
import { generateKey, generateSecretHash } from '~/server/utils/key-generator';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { OAUTH_TOKEN_PREFIX, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from './constants';

interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * Create an OAuth access + refresh token pair stored as ApiKey rows.
 * Used by both the OAuth model (saveToken) and device authorization flow.
 */
export async function createOAuthTokenPair(
  userId: number,
  clientId: string,
  scope: number
): Promise<TokenPair> {
  const now = new Date();

  // UserRead is a mandatory baseline on every OAuth token: an app acting on a
  // user's behalf must always be able to identify whose account it's on (and
  // read profile/email via the userinfo endpoint). Force the bit on regardless
  // of what was requested so it can never be dropped by any grant flow.
  scope = scope | TokenScope.UserRead;

  // Access token
  const accessToken = OAUTH_TOKEN_PREFIX + generateKey(36);
  const accessHash = generateSecretHash(accessToken);
  const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL * 1000);

  await dbWrite.apiKey.create({
    data: {
      key: accessHash,
      name: `oauth:${clientId}`,
      tokenScope: scope,
      userId,
      type: 'Access',
      expiresAt: accessTokenExpiresAt,
      clientId,
    },
  });

  // Refresh token
  const refreshToken = OAUTH_TOKEN_PREFIX + generateKey(36);
  const refreshHash = generateSecretHash(refreshToken);
  const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL * 1000);

  await dbWrite.apiKey.create({
    data: {
      key: refreshHash,
      name: `oauth-refresh:${clientId}`,
      tokenScope: scope,
      userId,
      type: 'Refresh',
      expiresAt: refreshTokenExpiresAt,
      clientId,
    },
  });

  // Mark the client as recently used. Fire-and-forget: this is informational
  // (drives DCR GC tuning + admin visibility) and must never add latency to or
  // fail the token grant. Errors are swallowed.
  dbWrite.oauthClient
    .update({ where: { id: clientId }, data: { lastUsedAt: now } })
    .catch(() => undefined);

  return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
}

import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { OAUTH_TOKEN_PREFIX, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from './constants';

interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/**
 * Create an OAuth access + refresh token pair stored as ApiKey rows.
 * Used by both the OAuth model (saveToken) and the device authorization flow.
 *
 * Ported from the main app's src/server/oauth/token-helpers.ts; Prisma `dbWrite.apiKey.create` → Kysely
 * `db.insertInto('ApiKey')`. The hashing (generateSecretHash) and token prefix/TTLs are SHARED with the
 * main app, so a token minted here validates in the main app's bearer path unchanged.
 */
export async function createOAuthTokenPair(
  userId: number,
  clientId: string,
  scope: number
): Promise<TokenPair> {
  const now = new Date();

  // UserRead is a mandatory baseline on every OAuth token: an app acting on a user's behalf must always
  // be able to identify whose account it's on (and read profile/email via the userinfo endpoint). Force
  // the bit on regardless of what was requested so it can never be dropped by any grant flow.
  scope = scope | TokenScope.UserRead;

  // Access token
  const accessToken = OAUTH_TOKEN_PREFIX + generateKey(36);
  const accessHash = generateSecretHash(accessToken);
  const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL * 1000);

  await db
    .insertInto('ApiKey')
    .values({
      key: accessHash,
      name: `oauth:${clientId}`,
      tokenScope: scope,
      userId,
      type: 'Access',
      expiresAt: accessTokenExpiresAt,
      clientId,
    })
    .execute();

  // Refresh token
  const refreshToken = OAUTH_TOKEN_PREFIX + generateKey(36);
  const refreshHash = generateSecretHash(refreshToken);
  const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL * 1000);

  await db
    .insertInto('ApiKey')
    .values({
      key: refreshHash,
      name: `oauth-refresh:${clientId}`,
      tokenScope: scope,
      userId,
      type: 'Refresh',
      expiresAt: refreshTokenExpiresAt,
      clientId,
    })
    .execute();

  return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
}

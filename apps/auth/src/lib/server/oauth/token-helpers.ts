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

async function insertToken(opts: {
  userId: number;
  clientId: string;
  scope: number;
  type: 'Access' | 'Refresh';
  expiresAt: Date;
}): Promise<string> {
  const token = OAUTH_TOKEN_PREFIX + generateKey(36);
  await db
    .insertInto('ApiKey')
    .values({
      key: generateSecretHash(token),
      name: `${opts.type === 'Access' ? 'oauth' : 'oauth-refresh'}:${opts.clientId}`,
      tokenScope: opts.scope,
      userId: opts.userId,
      type: opts.type,
      expiresAt: opts.expiresAt,
      clientId: opts.clientId,
    })
    .execute();
  return token;
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

  const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL * 1000);
  const accessToken = await insertToken({
    userId,
    clientId,
    scope,
    type: 'Access',
    expiresAt: accessTokenExpiresAt,
  });

  const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL * 1000);
  const refreshToken = await insertToken({
    userId,
    clientId,
    scope,
    type: 'Refresh',
    expiresAt: refreshTokenExpiresAt,
  });

  return { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt };
}

/** Access-only mint for app blocks: no refresh token, caller-bounded TTL, same prefix/hash as the pair. */
export async function createAppAccessToken(
  userId: number,
  clientId: string,
  scope: number,
  ttlSeconds: number
): Promise<{ accessToken: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const accessToken = await insertToken({
    userId,
    clientId,
    scope: scope | TokenScope.UserRead,
    type: 'Access',
    expiresAt,
  });
  return { accessToken, expiresAt };
}

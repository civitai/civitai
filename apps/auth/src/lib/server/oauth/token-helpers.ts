import { error } from '@sveltejs/kit';
import { isRefusedModerationAccount } from '$lib/server/auth/moderation-account';
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

/** The ApiKey `name` prefix of an access token minted by the client_credentials grant. */
export const CLIENT_CREDENTIALS_TOKEN_NAME_PREFIX = 'oauth-cc:';

async function insertToken(opts: {
  userId: number;
  clientId: string;
  scope: number;
  type: 'Access' | 'Refresh';
  expiresAt: Date;
  clientCredentials?: boolean;
}): Promise<string> {
  const token = OAUTH_TOKEN_PREFIX + generateKey(36);
  const prefix = opts.clientCredentials
    ? CLIENT_CREDENTIALS_TOKEN_NAME_PREFIX
    : `${opts.type === 'Access' ? 'oauth' : 'oauth-refresh'}:`;
  await db
    .insertInto('ApiKey')
    .values({
      key: generateSecretHash(token),
      name: `${prefix}${opts.clientId}`,
      tokenScope: opts.scope,
      userId: opts.userId,
      type: opts.type,
      expiresAt: opts.expiresAt,
      clientId: opts.clientId,
    })
    .execute();
  return token;
}

const AI_SERVICES_SCOPES = TokenScope.AIServicesRead | TokenScope.AIServicesWrite;

/** Whether `user` (undefined: not found) may not hold `scope`: a restricted account gets no AI Services scope. */
export function accountRefusesScope(
  user: { muted: boolean; bannedAt: Date | null } | undefined,
  scope: number
): boolean {
  if ((scope & AI_SERVICES_SCOPES) === 0) return false;
  return !user || user.muted || !!user.bannedAt;
}

/** A restricted account gets no AI Services token from any grant, issue or refresh; other scopes still issue. */
async function assertScopeAllowedForAccount(userId: number, scope: number) {
  if ((scope & AI_SERVICES_SCOPES) === 0) return;
  const user = await db
    .selectFrom('User')
    .select(['muted', 'bannedAt'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (accountRefusesScope(user, scope))
    error(403, 'This account cannot be granted AI Services access.');
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
  if (isRefusedModerationAccount({ id: userId }, 'oauth-token'))
    error(403, 'This account cannot sign in.');
  await assertScopeAllowedForAccount(userId, scope);
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

/**
 * Access-only mint for app blocks and the client_credentials grant: no refresh token, caller-bounded TTL,
 * same prefix/hash as the pair. A client_credentials token is named `oauth-cc:<clientId>`.
 */
export async function createAppAccessToken(
  userId: number,
  clientId: string,
  scope: number,
  ttlSeconds: number,
  opts: { clientCredentials?: boolean } = {}
): Promise<{ accessToken: string; expiresAt: Date }> {
  await assertScopeAllowedForAccount(userId, scope);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const accessToken = await insertToken({
    userId,
    clientId,
    scope: scope | TokenScope.UserRead,
    type: 'Access',
    expiresAt,
    clientCredentials: opts.clientCredentials,
  });
  return { accessToken, expiresAt };
}

import { error } from '@sveltejs/kit';
import { isRefusedModerationAccount } from '$lib/server/auth/moderation-account';
import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { db } from '$lib/server/db/db';
import { apiKeyScopeInsert } from './scope';
import { lockAppBlockSuspended } from './app-block-mint-lock';
import { OAUTH_TOKEN_PREFIX, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from './constants';
import { offlineDb, type MintOrigin } from './offline-columns';
import type { MintPlan } from './offline-grant';

interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

/** A grant's tokens under the offline-grant flag: the refresh token only when the plan has one. */
interface PlannedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken?: string;
  refreshTokenExpiresAt?: Date;
}

/** The offline-grant columns of one row. Present only with the `oauth-offline-grant` flag on. */
type OfflineColumns = { mintOrigin: MintOrigin | null; refreshFamilyId?: string };

/** The ApiKey `name` prefix of an access token minted by the client_credentials grant. */
export const CLIENT_CREDENTIALS_TOKEN_NAME_PREFIX = 'oauth-cc:';

/** The ApiKey `name` prefix of an access token minted by the block token exchange (block-exchange.ts). */
export const BLOCK_EXCHANGE_TOKEN_NAME_PREFIX = 'oauth-block:';

async function insertToken(opts: {
  executor?: Kysely<DB>;
  userId: number;
  clientId: string;
  scope: bigint;
  type: 'Access' | 'Refresh';
  expiresAt: Date;
  clientCredentials?: boolean;
  /** Overrides the name prefix the type would give the row. */
  namePrefix?: string;
  /** Only with the offline-grant flag on; absent, the row is written exactly as before the flag. */
  offline?: OfflineColumns;
}): Promise<string> {
  const token = OAUTH_TOKEN_PREFIX + generateKey(36);
  const prefix =
    opts.namePrefix ??
    (opts.clientCredentials
      ? CLIENT_CREDENTIALS_TOKEN_NAME_PREFIX
      : `${opts.type === 'Access' ? 'oauth' : 'oauth-refresh'}:`);
  const values = {
    key: generateSecretHash(token),
    name: `${prefix}${opts.clientId}`,
    ...apiKeyScopeInsert(opts.scope),
    userId: opts.userId,
    type: opts.type,
    expiresAt: opts.expiresAt,
    clientId: opts.clientId,
  };
  if (opts.offline) {
    await offlineDb(opts.executor ?? db)
      .insertInto('ApiKey')
      .values({ ...values, ...opts.offline })
      .execute();
  } else {
    await (opts.executor ?? db).insertInto('ApiKey').values(values).execute();
  }
  return token;
}

const AI_SERVICES_SCOPES = TokenScope.AIServicesRead | TokenScope.AIServicesWrite;

/** Whether `user` (undefined: not found) may not hold `scope`: a restricted account gets no AI Services scope. */
export function accountRefusesScope(
  user: { muted: boolean; bannedAt: Date | null } | undefined,
  scope: bigint
): boolean {
  if ((scope & AI_SERVICES_SCOPES) === 0n) return false;
  return !user || user.muted || !!user.bannedAt;
}

/** A restricted account gets no AI Services token from any grant, issue or refresh; other scopes still issue. */
async function assertScopeAllowedForAccount(userId: number, scope: bigint) {
  if ((scope & AI_SERVICES_SCOPES) === 0n) return;
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
  scope: bigint
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
 * `createOAuthTokenPair` under the `oauth-offline-grant` flag: the same account checks and UserRead
 * baseline, with each row's mint origin recorded, and a refresh token (with its family and expiry)
 * only when `plan.refresh` says so.
 */
export async function createPlannedOAuthTokens(
  userId: number,
  clientId: string,
  scope: bigint,
  plan: MintPlan
): Promise<PlannedTokens> {
  if (isRefusedModerationAccount({ id: userId }, 'oauth-token'))
    error(403, 'This account cannot sign in.');
  await assertScopeAllowedForAccount(userId, scope);
  const now = new Date();
  scope = scope | TokenScope.UserRead;

  const accessTokenExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL * 1000);
  const accessToken = await insertToken({
    userId,
    clientId,
    scope,
    type: 'Access',
    expiresAt: accessTokenExpiresAt,
    offline: { mintOrigin: plan.accessOrigin },
  });
  if (!plan.refresh) return { accessToken, accessTokenExpiresAt };

  const refreshTokenExpiresAt = plan.refresh.expiresAt;
  const refreshToken = await insertToken({
    userId,
    clientId,
    scope,
    type: 'Refresh',
    expiresAt: refreshTokenExpiresAt,
    offline: { mintOrigin: plan.refresh.rootOrigin, refreshFamilyId: plan.refresh.familyId },
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
  scope: bigint,
  ttlSeconds: number,
  opts: {
    clientCredentials?: boolean;
    refuseSuspendedAppBlock?: boolean;
    /** Recorded on the row only when set, i.e. with the offline-grant flag on. */
    mintOrigin?: MintOrigin;
  } = {}
): Promise<{ accessToken: string; expiresAt: Date }> {
  await assertScopeAllowedForAccount(userId, scope);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const insert = (executor?: Kysely<DB>) =>
    insertToken({
      executor,
      userId,
      clientId,
      scope: scope | TokenScope.UserRead,
      type: 'Access',
      expiresAt,
      clientCredentials: opts.clientCredentials,
      offline: opts.mintOrigin ? { mintOrigin: opts.mintOrigin } : undefined,
    });
  if (!opts.refuseSuspendedAppBlock) return { accessToken: await insert(), expiresAt };

  const accessToken = await db.transaction().execute(async (trx) => {
    if (await lockAppBlockSuspended(trx, clientId)) throw new AppBlockSuspendedError();
    return insert(trx);
  });
  return { accessToken, expiresAt };
}

/**
 * The access token the block token exchange mints: one Access row for (user, app) holding EXACTLY `scope`
 * (no UserRead baseline, unlike every other mint here), expiring at `expiresAt`, with no refresh token. The
 * insert runs under the app-block suspension lock, so a suspension's token delete either sees the row or the
 * mint sees the suspension and throws {@link AppBlockSuspendedError}.
 */
export async function createBlockExchangeToken(
  userId: number,
  clientId: string,
  scope: bigint,
  expiresAt: Date
): Promise<string> {
  return db.transaction().execute(async (trx) => {
    if (await lockAppBlockSuspended(trx, clientId)) throw new AppBlockSuspendedError();
    return insertToken({
      executor: trx,
      userId,
      clientId,
      scope,
      type: 'Access',
      expiresAt,
      namePrefix: BLOCK_EXCHANGE_TOKEN_NAME_PREFIX,
    });
  });
}

export class AppBlockSuspendedError extends Error {
  constructor() {
    super('app block suspended');
    this.name = 'AppBlockSuspendedError';
  }
}

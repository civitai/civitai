import { REDIS_SYS_KEYS } from '@civitai/redis';
import { TokenScope, tokenScopeMaskToList } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { getSysRedis } from '$lib/server/redis';
import { isRefusedModerationAccount } from '$lib/server/auth/moderation-account';
import { checkClientAccess, userHasRole } from './access';
import { SYSTEM_USER_ID, SYSTEM_WORKLOAD_ROLE } from './constants';
import { carriesNonUserScope } from './scope';
import { accountRefusesScope, CLIENT_CREDENTIALS_TOKEN_NAME_PREFIX } from './token-helpers';
import type { ExchangeResource } from './exchange-resources';

// What the user token exchange (user-exchange.ts) and introspection of the JWT it mints
// (jwt-introspection.ts) both check, so a token is judged the same way when it is minted and when it is read.

/** An exchanged JWT lives at most this long, and never past the access token it came from. */
export const EXCHANGED_TOKEN_MAX_TTL = 15 * 60;

/** A live OAuth access token, as the exchange reads it. */
export interface SubjectToken {
  id: number;
  userId: number;
  clientId: string;
  tokenScope: number;
  expiresAt: Date;
  name: string;
}

function subjectTokenQuery(now: Date) {
  return db
    .selectFrom('ApiKey')
    .select(['id', 'userId', 'clientId', 'tokenScope', 'expiresAt', 'name'])
    .where('type', '=', 'Access')
    .where('clientId', 'is not', null)
    .where('expiresAt', '>', now);
}

function asSubject(row: {
  id: number;
  userId: number;
  clientId: string | null;
  tokenScope: number;
  expiresAt: Date | null;
  name: string;
}): SubjectToken | undefined {
  if (!row.clientId || !row.expiresAt) return undefined;
  return { ...row, clientId: row.clientId, expiresAt: row.expiresAt };
}

/** The unexpired OAuth access token with this hash (a null expiry never matches). */
export async function findSubjectTokenByHash(
  hash: string,
  now: Date
): Promise<SubjectToken | undefined> {
  const row = await subjectTokenQuery(now).where('key', '=', hash).executeTakeFirst();
  return row && asSubject(row);
}

/** The unexpired OAuth access token with this id. Revoking a token deletes its row. */
export async function findSubjectTokenById(
  id: number,
  now: Date
): Promise<SubjectToken | undefined> {
  const row = await subjectTokenQuery(now).where('id', '=', id).executeTakeFirst();
  return row && asSubject(row);
}

export interface ExchangeClient {
  id: string;
  allowedScopes: number;
  accessMode: string;
}

export async function findExchangeClient(id: string): Promise<ExchangeClient | undefined> {
  return db
    .selectFrom('OauthClient')
    .select(['id', 'allowedScopes', 'accessMode'])
    .where('id', '=', id)
    .executeTakeFirst();
}

/** Why the subject token may not be exchanged, or null. */
export async function subjectTokenRefusal(subject: SubjectToken): Promise<string | null> {
  if (subject.name.startsWith(CLIENT_CREDENTIALS_TOKEN_NAME_PREFIX))
    return 'client credentials token';
  if (carriesNonUserScope(subject.tokenScope)) return 'client-only scope';
  if (subject.userId === SYSTEM_USER_ID) return 'system account';
  if (await userHasRole(subject.userId, SYSTEM_WORKLOAD_ROLE)) return 'workload account';
  return null;
}

/**
 * Why `userId` may not hold an exchanged token for `scope` through `app`, or null. Throws when a lookup
 * fails. `refusal` is what the exchange answers: the app is closed to everyone, or this user may not have it.
 */
export async function userRefusal(
  userId: number,
  scope: number,
  app: ExchangeClient
): Promise<{ reason: string; refusal: 'unauthorized_client' | 'invalid_grant' } | null> {
  const access = await checkClientAccess(app.accessMode, userId);
  if (!access.allowed) {
    return access.reason === 'disabled'
      ? { reason: 'app disabled', refusal: 'unauthorized_client' }
      : { reason: 'app limited to testers', refusal: 'invalid_grant' };
  }
  const user = await db
    .selectFrom('User')
    .select(['id', 'username', 'deletedAt', 'bannedAt', 'muted'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return { reason: 'user not found', refusal: 'invalid_grant' };
  if (user.deletedAt) return { reason: 'user deleted', refusal: 'invalid_grant' };
  if (user.bannedAt) return { reason: 'user banned', refusal: 'invalid_grant' };
  if (isRefusedModerationAccount(user, 'oauth-token')) {
    return { reason: 'moderation account', refusal: 'invalid_grant' };
  }
  if (accountRefusesScope(user, scope))
    return { reason: 'user restricted', refusal: 'invalid_grant' };
  return null;
}

/** The most an exchanged token may carry: the subject's scope within the resource's and the app's. */
export function exchangeScopeCeiling(
  subjectScope: number,
  resource: ExchangeResource,
  app: ExchangeClient
): number {
  // UserRead rides every OAuth token; the resource never receives it (registry validation refuses it).
  return subjectScope & resource.scopes & app.allowedScopes & ~TokenScope.UserRead;
}

/** Space-separated scope names, in bit order. */
export function scopeNames(scope: number): string {
  return tokenScopeMaskToList(scope)
    .map((s) => s.key)
    .join(' ');
}

// ─── The exchange record ─────────────────────────────────────

/** What introspection needs to tie an exchanged JWT back to the access token it came from. */
export interface ExchangeRecord {
  subjectKeyId: number;
  userId: number;
  clientId: string;
  actor: string | null;
  resource: string;
  scopeBits: number;
  exp: number;
}

const recordKey = (jti: string) => `${REDIS_SYS_KEYS.OAUTH.TOKEN_EXCHANGES}:${jti}` as const;

type StringRedis = {
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

/** How long an exchange record read or write may wait (the client queues while reconnecting). */
const RECORD_TIMEOUT_MS = 2000;

function withTimeout<T>(op: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('exchange record timed out')), RECORD_TIMEOUT_MS);
  });
  return Promise.race([op, timeout]).finally(() => clearTimeout(timer));
}

function redisOrThrow(): StringRedis {
  const redis = getSysRedis();
  if (!redis) throw new Error('REDIS_SYS_URL is not configured');
  return redis as unknown as StringRedis;
}

/** Store the record until a minute past the JWT's expiry. Throws when it cannot be stored. */
export async function writeExchangeRecord(
  jti: string,
  record: ExchangeRecord,
  nowSeconds: number
): Promise<void> {
  const ttl = Math.max(1, record.exp - nowSeconds + 60);
  await withTimeout(redisOrThrow().set(recordKey(jti), JSON.stringify(record), { EX: ttl }));
}

/** The record for `jti`, or null when there is none. Throws when Redis cannot answer. */
export async function readExchangeRecord(jti: string): Promise<ExchangeRecord | null> {
  const raw = await withTimeout(redisOrThrow().get(recordKey(jti)));
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as ExchangeRecord;
  } catch {
    return null;
  }
}

import { REDIS_SYS_KEYS } from '@civitai/redis';
import type { AccessTokenJwtClaims, SessionSigner } from '@civitai/auth';
import { logToAxiom } from '$lib/server/axiom';
import { parseTokenScope, TokenScope, tokenScopeMaskToList } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { getSysRedis } from '$lib/server/redis';
import { waitForRedisReady } from '$lib/server/redis-ready';
import { raceTimeout } from './timeout';
import { isRefusedModerationAccount } from '$lib/server/auth/moderation-account';
import { isMemorializedFlags } from '@civitai/shared/memorial';
import { checkClientAccess, userHasRole } from './access';
import { SYSTEM_USER_ID, SYSTEM_WORKLOAD_ROLE } from './constants';
import { apiKeyRowScope, carriesNonUserScope, scopeFromColumn } from './scope';
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
  tokenScope: bigint;
  expiresAt: Date;
  name: string;
}

function subjectTokenQuery(now: Date) {
  return db
    .selectFrom('ApiKey')
    .select(['id', 'userId', 'clientId', 'tokenScope', 'tokenScopeWide', 'expiresAt', 'name'])
    .where('type', '=', 'Access')
    .where('clientId', 'is not', null)
    .where('expiresAt', '>', now);
}

function asSubject(row: {
  id: number;
  userId: number;
  clientId: string | null;
  tokenScope: number;
  tokenScopeWide: string | number | null;
  expiresAt: Date | null;
  name: string;
}): SubjectToken | undefined {
  if (!row.clientId || !row.expiresAt) return undefined;
  return {
    id: row.id,
    userId: row.userId,
    clientId: row.clientId,
    tokenScope: apiKeyRowScope(row),
    expiresAt: row.expiresAt,
    name: row.name,
  };
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
  allowedScopes: bigint;
  accessMode: string;
}

export async function findExchangeClient(id: string): Promise<ExchangeClient | undefined> {
  const row = await db
    .selectFrom('OauthClient')
    .select(['id', 'allowedScopes', 'accessMode'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row && { ...row, allowedScopes: scopeFromColumn(row.allowedScopes) };
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
  scope: bigint,
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
    .select(['id', 'username', 'deletedAt', 'bannedAt', 'muted', 'flags'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return { reason: 'user not found', refusal: 'invalid_grant' };
  if (user.deletedAt) return { reason: 'user deleted', refusal: 'invalid_grant' };
  if (user.bannedAt) return { reason: 'user banned', refusal: 'invalid_grant' };
  if (isMemorializedFlags(user.flags))
    return { reason: 'user memorialized', refusal: 'invalid_grant' };
  if (isRefusedModerationAccount(user, 'oauth-token')) {
    return { reason: 'moderation account', refusal: 'invalid_grant' };
  }
  if (accountRefusesScope(user, scope))
    return { reason: 'user restricted', refusal: 'invalid_grant' };
  return null;
}

/** The most an exchanged token may carry: the subject's scope within the resource's and the app's. */
export function exchangeScopeCeiling(
  subjectScope: bigint,
  resource: ExchangeResource,
  app: ExchangeClient
): bigint {
  // UserRead rides every OAuth token; the resource never receives it (registry validation refuses it).
  return subjectScope & resource.scopes & app.allowedScopes & ~TokenScope.UserRead;
}

/** Space-separated scope names, in bit order. */
export function scopeNames(scope: bigint): string {
  return tokenScopeMaskToList(scope)
    .map((s) => s.key)
    .join(' ');
}

// ─── The exchange record ─────────────────────────────────────

/** What introspection needs to tie an exchanged JWT back to the access token it came from. */
export interface ExchangeRecord {
  kind?: undefined;
  subjectKeyId: number;
  userId: number;
  clientId: string;
  actor: string | null;
  resource: string;
  scopeBits: bigint;
  exp: number;
}

/** What introspection needs to tie a service token back to its client and resource. */
export interface ServiceTokenRecord {
  kind: 'service';
  clientId: string;
  resource: string;
  scopeBits: bigint;
  exp: number;
}

/**
 * What ties a token minted by a client token exchange (client-exchange.ts) to its client, the relay that
 * exchanged it and the token it came from. Introspection does not answer for these yet (it reads them as
 * inactive); a further exchange reads the record to know the hub issued the token.
 */
export interface ServiceExchangeRecord {
  kind: 'service-exchange';
  clientId: string;
  actor: string;
  resource: string;
  scopeBits: bigint;
  exp: number;
  /** The `jti` of the token it was exchanged from. */
  subjectJti: string;
}

/**
 * What ties a token minted by the block token exchange (block-exchange.ts) to its user, app, relay and the
 * block token it came from. Introspection does not answer for these (it reads them as inactive): the
 * registry adapter verifies them locally, and no further exchange accepts them as a subject.
 */
export interface BlockExchangeRecord {
  kind: 'block-exchange';
  userId: number;
  clientId: string;
  actor: string;
  resource: string;
  scopeBits: bigint;
  exp: number;
  /** The `jti` of the block token it was exchanged from. */
  blockJti: string;
}

export type TokenRecord =
  | ExchangeRecord
  | ServiceTokenRecord
  | ServiceExchangeRecord
  | BlockExchangeRecord;

/**
 * Mint an exchanged `at+jwt` and store its record: the one way the user exchange and the block exchange
 * issue a token. The record is written after signing and before the token is returned, so no token leaves
 * the hub without one. `logName` prefixes the error lines (`<logName>-sign-failed`,
 * `<logName>-record-failed`).
 */
export async function mintExchangedJwt(
  signer: SessionSigner,
  claims: AccessTokenJwtClaims,
  record: TokenRecord,
  logName: string
): Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }> {
  let accessToken: string;
  try {
    accessToken = await signer.mintAccessTokenJwt(claims);
  } catch (err) {
    void logToAxiom({ type: 'error', name: `${logName}-sign-failed`, message: String(err) });
    return { ok: false, reason: 'signing failed' };
  }
  try {
    await writeExchangeRecord(claims.jti, record, claims.iat);
  } catch (err) {
    void logToAxiom({ type: 'error', name: `${logName}-record-failed`, message: String(err) });
    return { ok: false, reason: 'exchange record not stored' };
  }
  return { ok: true, accessToken };
}

const recordKey = (jti: string) => `${REDIS_SYS_KEYS.OAUTH.TOKEN_EXCHANGES}:${jti}` as const;

type StringRedis = {
  isReady?: boolean;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

/** How long an exchange record read or write may wait, including for the client to be ready. */
const RECORD_TIMEOUT_MS = 2000;

// Throws when the client is not ready in time or the command overruns.
async function withSysRedis<T>(op: (redis: StringRedis) => Promise<T>): Promise<T> {
  const deadline = Date.now() + RECORD_TIMEOUT_MS;
  const redis = getSysRedis() as unknown as StringRedis | null;
  if (!redis) throw new Error('REDIS_SYS_URL is not configured');
  if (!(await waitForRedisReady(redis, RECORD_TIMEOUT_MS)))
    throw new Error('exchange record store not ready');
  return raceTimeout(op(redis), Math.max(0, deadline - Date.now()), 'exchange record timed out');
}

/** Store the record until a minute past the JWT's expiry. Throws when it cannot be stored. */
export async function writeExchangeRecord(
  jti: string,
  record: TokenRecord,
  nowSeconds: number
): Promise<void> {
  const ttl = Math.max(1, record.exp - nowSeconds + 60);
  const stored = { ...record, scopeBits: Number(record.scopeBits) };
  await withSysRedis((redis) => redis.set(recordKey(jti), JSON.stringify(stored), { EX: ttl }));
}

/** The record for `jti`, or null when there is none. Throws when Redis cannot answer. */
export async function readExchangeRecord(jti: string): Promise<TokenRecord | null> {
  const raw = await withSysRedis((redis) => redis.get(recordKey(jti)));
  if (raw == null) return null;
  try {
    const stored = JSON.parse(raw) as Omit<TokenRecord, 'scopeBits'> & { scopeBits: unknown };
    const scopeBits = parseTokenScope(stored.scopeBits);
    if (scopeBits === null) return null;
    return { ...stored, scopeBits } as TokenRecord;
  } catch {
    return null;
  }
}

import { createHash, randomUUID } from 'crypto';
import {
  SIMPLE_BUZZ_LIMIT_PERIODS,
  simpleBuzzLimitToBudgets,
  type SimpleBuzzLimit,
} from '@civitai/auth/buzz-limit';
import { REDIS_KEYS } from '@civitai/redis';
import { getRedis } from '$lib/server/redis';
import { isGlobalFlagOn } from '$lib/server/flipt';
import { logToAxiom } from '$lib/server/axiom';
import { db } from '$lib/server/db/db';
import { logOAuthEvent } from './audit-log';
import { OFFLINE_GRANT_FLAG, REFRESH_TOKEN_TTL, REFRESH_TOMBSTONE_TTL } from './constants';
import { offlineDb, type ChainOrigin, type MintOrigin } from './offline-columns';
import { scopeToColumn } from './scope';

// Offline access as a separate grant, behind the `oauth-offline-grant` Flipt flag. With the flag OFF
// none of this runs and the hub issues exactly what it did before: a refresh token on every
// authorization-code and device grant, rotated by the OAuth library with a fresh 30-day expiry.
//
// With the flag ON:
//   1. A refresh token is issued on an authorization-code grant only when the client asked for
//      `offline_access` AND the user's consent for that client carries an offline grant
//      (`OauthConsent.offlineGrantedAt`, set when they approve "Stay connected while you're away").
//      Otherwise the grant gets an access token alone. Disconnecting the app deletes the consent,
//      and the offline grant with it.
//   2. Refreshing a chain whose consent has no offline grant still rotates, but the new refresh
//      token keeps the presented one's expiry (non-sliding), so a chain issued before the flag lapses
//      at its current expiry, within 30 days. A chain under an offline grant gets a fresh 30 days.
//      A device-flow chain keeps the fresh 30 days: the device approval is its own grant, and this
//      change does not alter that flow.
//   3. Every rotation leaves a tombstone for the rotated token, keyed by its hash, pointing at the
//      chain's family id (`ApiKey.refreshFamilyId`). Presenting a tombstoned token is reuse: someone
//      holds a token that was already exchanged. The hub deletes every refresh token of that family
//      and every access token for that user and client, and records `token.reuse_detected` (a count
//      by event type; no user or client in the metric).
//   4. Every OAuth access token records how it was minted (`ApiKey.mintOrigin`), and an exchanged
//      at+jwt carries its subject token's origin as the `mint_origin` claim.
//
// Tombstones live on the cache redis, one key per rotated token with a TTL, not in Postgres: they are
// write-once, read only on a refresh that misses its row, and expire on their own, which is what a
// TTL key is and a table row is not (a table needs a purge job and grows a row per rotation). Losing
// one (redis unavailable or evicted) fails open to what the hub did before this change: the replayed
// token is simply invalid_grant, without the family being revoked. A tombstone lasts until the
// rotated token's own expiry, capped at REFRESH_TOMBSTONE_TTL (7 days).

export function isOfflineGrantOn(): Promise<boolean> {
  return isGlobalFlagOn(OFFLINE_GRANT_FLAG);
}

/** Whether the user's consent for this client carries an offline grant. */
export async function hasOfflineGrant(userId: number, clientId: string): Promise<boolean> {
  const row = await offlineDb()
    .selectFrom('OauthConsent')
    .select(['offlineGrantedAt'])
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .executeTakeFirst();
  return row?.offlineGrantedAt != null;
}

// ── The consent's offline grant and its Buzz cap ─────────────────────────────────────────────────
//
// The cap: an app asking for offline access may propose one in the authorize request
// (`offline_buzz_limit`, a positive whole number of Buzz, and `offline_buzz_period`, `day` | `week` |
// `month`, default `day`). The consent screen shows it on the offline line, prefilled with the
// consent's current cap if it has one, and the user may raise, lower or clear it. The approval stores
// it as the consent's `buzzLimit` (the same budgets array Connected apps edits), or null when cleared.
// What the cap applies to, and why null means no cap, is in the main app's
// src/server/orchestrator/offline-spend-cap.ts.

/** The largest cap the consent screen accepts, as a bound on a typo, not a policy. */
export const OFFLINE_BUZZ_LIMIT_MAX = 100_000_000;

/**
 * A cap from a limit and period field: null when the limit is absent or blank (no cap), `'invalid'`
 * when either field is malformed.
 */
export function parseOfflineBuzzCap(
  limit: unknown,
  period: unknown
): SimpleBuzzLimit | null | 'invalid' {
  if (limit === undefined || limit === null || limit === '') return null;
  if (typeof limit !== 'string' || !/^\d+$/.test(limit)) return 'invalid';
  const value = Number(limit);
  if (!Number.isSafeInteger(value) || value <= 0 || value > OFFLINE_BUZZ_LIMIT_MAX)
    return 'invalid';
  const p = period === undefined || period === '' ? 'day' : period;
  if (!(SIMPLE_BUZZ_LIMIT_PERIODS as readonly unknown[]).includes(p)) return 'invalid';
  return { limit: value, period: p as SimpleBuzzLimit['period'] };
}

/** A consent's columns the authorize flow reads with the flag on. */
export async function readConsentForOffline(
  userId: number,
  clientId: string
): Promise<
  { scope: string | number | bigint; offlineGrantedAt: Date | null; buzzLimit: unknown } | undefined
> {
  return offlineDb()
    .selectFrom('OauthConsent')
    .select(['scope', 'offlineGrantedAt', 'buzzLimit'])
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .executeTakeFirst();
}

/**
 * Record the user's approval of the offline line: the consent row (created if missing, so the grant
 * has something Connected apps lists and Disconnect removes) gets `offlineGrantedAt` and the chosen
 * cap. `scope` is written on a new row, and on an existing one only when `rememberScope` (the
 * "remember my decision" box), as the plain approval does.
 */
export async function grantOffline(opts: {
  userId: number;
  clientId: string;
  scope: bigint;
  rememberScope: boolean;
  cap: SimpleBuzzLimit | null;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  const budgets = simpleBuzzLimitToBudgets(opts.cap);
  // pg serializes a JS array as a Postgres array, not JSON, so the jsonb value goes as a string.
  const buzzLimit = budgets ? JSON.stringify(budgets) : null;
  await offlineDb()
    .insertInto('OauthConsent')
    .values({
      userId: opts.userId,
      clientId: opts.clientId,
      scope: scopeToColumn(opts.scope),
      offlineGrantedAt: now,
      buzzLimit,
    })
    .onConflict((oc) =>
      oc.columns(['userId', 'clientId']).doUpdateSet({
        offlineGrantedAt: now,
        buzzLimit,
        updatedAt: now,
        ...(opts.rememberScope && { scope: scopeToColumn(opts.scope) }),
      })
    )
    .execute();
}

/**
 * A client Civitai runs that skips the consent screen asked for offline access: there is no screen to
 * approve it on, so the grant is implied, as its scopes are. It is still recorded on a consent row,
 * so the user can see the app in Connected apps and disconnect it. An existing row keeps its scope
 * and cap.
 */
export async function grantOfflineImplied(opts: {
  userId: number;
  clientId: string;
  scope: bigint;
  now?: Date;
}): Promise<void> {
  const now = opts.now ?? new Date();
  await offlineDb()
    .insertInto('OauthConsent')
    .values({
      userId: opts.userId,
      clientId: opts.clientId,
      scope: scopeToColumn(opts.scope),
      offlineGrantedAt: now,
    })
    .onConflict((oc) => oc.columns(['userId', 'clientId']).doUpdateSet({ offlineGrantedAt: now }))
    .execute();
}

/** The user unticked the offline line: the consent, if any, loses its offline grant. */
export async function declineOffline(userId: number, clientId: string): Promise<void> {
  await offlineDb()
    .updateTable('OauthConsent')
    .set({ offlineGrantedAt: null })
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .executeTakeFirst();
}

/** A refresh chain as read off its live `Refresh` row (flag on only). */
export interface RefreshChain {
  /** The chain's family id; a chain from before the flag has none until this rotation gives it one. */
  familyId: string;
  /** The grant that started the chain; null for a chain from before the flag. */
  rootOrigin: ChainOrigin | null;
  /** The presented token's expiry. */
  expiresAt: Date | null;
}

/** The chain columns of the live `Refresh` row with this key hash. */
export async function readRefreshChainColumns(
  keyHash: string
): Promise<{ familyId: string | null; rootOrigin: ChainOrigin | null } | undefined> {
  const row = await offlineDb()
    .selectFrom('ApiKey')
    .select(['refreshFamilyId', 'mintOrigin'])
    .where('key', '=', keyHash)
    .where('type', '=', 'Refresh')
    .executeTakeFirst();
  if (!row) return undefined;
  const origin = row.mintOrigin;
  return {
    familyId: row.refreshFamilyId ?? null,
    rootOrigin: origin === 'auth_code' || origin === 'device_code' ? origin : null,
  };
}

export function newRefreshFamilyId(): string {
  return randomUUID();
}

/** What a user grant mints, with the flag on. */
export interface MintPlan {
  accessOrigin: MintOrigin;
  /** null: no refresh token. */
  refresh: null | { familyId: string; rootOrigin: ChainOrigin | null; expiresAt: Date };
}

/**
 * The tokens an authorization-code grant mints, flag on: a refresh token only when the client asked
 * for offline access and the consent carries the offline grant (re-read here, so a disconnect between
 * the approval and the code exchange still counts).
 */
export async function planAuthCodeGrant(opts: {
  userId: number;
  clientId: string;
  offlineRequested: boolean;
  now?: Date;
}): Promise<MintPlan> {
  const now = opts.now ?? new Date();
  const offline = opts.offlineRequested && (await hasOfflineGrant(opts.userId, opts.clientId));
  return {
    accessOrigin: 'auth_code',
    refresh: offline
      ? {
          familyId: newRefreshFamilyId(),
          rootOrigin: 'auth_code',
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL * 1000),
        }
      : null,
  };
}

/** The tokens a device-flow grant mints, flag on: a new chain, as before, now with a family. */
export function planDeviceGrant(now = new Date()): MintPlan {
  return {
    accessOrigin: 'device_code',
    refresh: {
      familyId: newRefreshFamilyId(),
      rootOrigin: 'device_code',
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL * 1000),
    },
  };
}

/**
 * The tokens a refresh grant mints, flag on. The new refresh token joins the presented one's family.
 * Its expiry slides to a fresh REFRESH_TOKEN_TTL only under an offline grant (or for a device-flow
 * chain); otherwise it keeps the presented token's expiry, so the chain lapses then.
 */
export async function planRefreshGrant(opts: {
  userId: number;
  clientId: string;
  chain: RefreshChain;
  now?: Date;
}): Promise<MintPlan> {
  const now = opts.now ?? new Date();
  const fresh = new Date(now.getTime() + REFRESH_TOKEN_TTL * 1000);
  const slides =
    opts.chain.rootOrigin === 'device_code' || (await hasOfflineGrant(opts.userId, opts.clientId));
  // A row with no expiry (none is written so, but the column allows it) is held to a fresh TTL, so
  // even it lapses; an expiry is never extended past what a fresh token would get.
  const kept = opts.chain.expiresAt && opts.chain.expiresAt < fresh ? opts.chain.expiresAt : fresh;
  return {
    accessOrigin: 'refresh',
    refresh: {
      familyId: opts.chain.familyId,
      rootOrigin: opts.chain.rootOrigin,
      expiresAt: slides ? fresh : kept,
    },
  };
}

/** The mint origin recorded on an `Access` row, or null (none recorded, or no such row). */
export async function readAccessMintOrigin(apiKeyId: number): Promise<MintOrigin | null> {
  const row = await offlineDb()
    .selectFrom('ApiKey')
    .select(['mintOrigin'])
    .where('id', '=', apiKeyId)
    .where('type', '=', 'Access')
    .executeTakeFirst();
  return row?.mintOrigin ?? null;
}

// ── Reuse detection ──────────────────────────────────────────────────────────────────────────────

/** The chain a rotated refresh token belonged to. */
export interface RefreshTombstone {
  familyId: string;
  userId: number;
  clientId: string;
}

const tombstoneKey = (refreshToken: string) =>
  `${REDIS_KEYS.OAUTH.REFRESH_TOMBSTONES}:${createHash('sha256')
    .update(refreshToken)
    .digest('hex')}` as const;

/**
 * Leave a tombstone for a refresh token the library just rotated. It lasts until the token's own
 * expiry, capped at REFRESH_TOMBSTONE_TTL; a token already past its expiry gets none. Best-effort: a
 * failure is logged and the rotation goes on.
 */
export async function tombstoneRotatedRefreshToken(
  refreshToken: string,
  tombstone: RefreshTombstone,
  expiresAt: Date | null,
  now = Date.now()
): Promise<void> {
  const remainingMs = expiresAt ? expiresAt.getTime() - now : Infinity;
  const ttlSeconds = Math.floor(Math.min(REFRESH_TOMBSTONE_TTL * 1000, remainingMs) / 1000);
  if (ttlSeconds <= 0) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.packed.set(tombstoneKey(refreshToken), tombstone, { EX: ttlSeconds });
  } catch (err) {
    void logToAxiom({
      type: 'error',
      name: 'oauth-refresh-tombstone-write-failed',
      message: String(err),
    });
  }
}

/** The tombstone left for this refresh token, or null (none, expired, or redis unavailable). */
export async function readRefreshTombstone(refreshToken: string): Promise<RefreshTombstone | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return (await redis.packed.get<RefreshTombstone>(tombstoneKey(refreshToken))) ?? null;
  } catch {
    return null;
  }
}

/**
 * A tombstoned refresh token was presented: revoke its whole family and every access token of that
 * user for that client, and record it. The deletes are scoped by user and client as well as family,
 * so a tombstone can never reach another user's keys.
 */
export async function revokeRefreshFamily(tombstone: RefreshTombstone): Promise<void> {
  const { familyId, userId, clientId } = tombstone;
  await offlineDb()
    .deleteFrom('ApiKey')
    .where('type', '=', 'Refresh')
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .where('refreshFamilyId', '=', familyId)
    .execute();
  await db
    .deleteFrom('ApiKey')
    .where('type', '=', 'Access')
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .execute();
  logOAuthEvent({ type: 'token.reuse_detected', userId, clientId });
}

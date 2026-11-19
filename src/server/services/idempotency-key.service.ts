import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * "Has this already been done?" markers for actions that must not run twice: a DM sent as Civitai,
 * a headless post, the AIR notice for a Stripe checkout.
 *
 * They live on sysRedis today, which is `volatile-lru`: every one of these keys carries a TTL, so
 * any of them can be evicted, and an evicted key repeats the action. The `idempotency-keys-pg`
 * flag moves them to the Postgres `IdempotencyKey` table (migration
 * `20271119120000_idempotency_key`, applied by hand).
 *
 * - Flag OFF (the default, and what Flipt being unreachable gives): sysRedis only, the same
 *   commands, keys, values and TTLs as before this module existed.
 * - Flag ON: Postgres decides. sysRedis is still written alongside (so turning the flag back off,
 *   or a pod that has not seen the flag yet, still sees every claim), and until
 *   `SYS_FALLBACK_UNTIL` a key Postgres has never seen is checked against sysRedis, so a key taken
 *   before the flag was turned on still counts.
 * - Flag ON and Postgres failing (the table not applied yet included): `IdempotencyUnavailableError`,
 *   thrown before anything is claimed anywhere. Each caller refuses rather than act unguarded.
 */

export type IdempotencyScope = keyof typeof SCOPES;

const SCOPES = {
  'message-as-civitai': {
    sysPrefix: REDIS_SYS_KEYS.MESSAGE_AS_CIVITAI.IDEMPOTENCY,
    // Long enough for any send to finish; a crash mid-send frees the key after this, not a day.
    pendingSeconds: 5 * 60,
    resultSeconds: 24 * 60 * 60,
    marker: false,
  },
  'headless-post': {
    sysPrefix: REDIS_SYS_KEYS.HEADLESS_POST.IDEMPOTENCY,
    // Longer than a post with a few images takes to ingest, so a slow first tap is not posted twice.
    pendingSeconds: 5 * 60,
    resultSeconds: 7 * 24 * 60 * 60,
    marker: false,
  },
  // A marker, not a result: taken before AIR is told, held for 30 days, freed only if telling AIR
  // failed. A crash in between leaves it held, so AIR hears about a checkout at most once. 30 days
  // is well past Stripe's retry window.
  'stripe-air': {
    sysPrefix: REDIS_SYS_KEYS.WEBHOOKS.STRIPE_AIR_NOTIFIED,
    pendingSeconds: 30 * 24 * 60 * 60,
    resultSeconds: 30 * 24 * 60 * 60,
    marker: true,
  },
} as const;

/**
 * Until this date a key Postgres has never seen is also looked up on sysRedis. It must be at least
 * one TTL after the flag is first turned on (30 days for stripe-air, 7 for headless-post, 1 for
 * message-as-civitai). If the flag is first turned on after 2027-01-02, move it.
 */
export const SYS_FALLBACK_UNTIL = new Date('2027-02-01T00:00:00.000Z');

const PENDING = 'pending';
const UNDEFINED_TABLE = '42P01';

export class IdempotencyUnavailableError extends Error {
  constructor(readonly scope: IdempotencyScope, readonly tableMissing: boolean, cause: unknown) {
    super(
      tableMissing
        ? `idempotency keys: the IdempotencyKey table does not exist (${scope})`
        : `idempotency keys: the store is unavailable (${scope})`,
      { cause }
    );
    this.name = 'IdempotencyUnavailableError';
  }
}

export type IdempotencyClaim = {
  /**
   * `claimed`: this caller holds the key and should act. `pending`: another caller is acting.
   * `done`: it was done; `result` is what was stored. `taken`: a marker scope's key is held.
   */
  status: 'claimed' | 'pending' | 'done' | 'taken';
  result?: string;
  /** Records the result for repeats. Throws when it could not be recorded. */
  store(value: string): Promise<void>;
  /** Frees this caller's claim so a retry can act. Throws when it could not be freed. */
  release(): Promise<void>;
};

type Store = { db: Kysely<DB>; now: () => number };
const defaults = (): Store => ({ db: kyselyWrite, now: Date.now });

export async function claimIdempotencyKey(
  scope: IdempotencyScope,
  key: string,
  deps: Partial<Store> = {}
): Promise<IdempotencyClaim> {
  const { db, now } = { ...defaults(), ...deps };
  const cfg = SCOPES[scope];
  const sysKey = `${cfg.sysPrefix}:${key}`;
  const sysClaimValue = cfg.marker ? '1' : PENDING;

  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.IDEMPOTENCY_KEYS_PG))) {
    const sys: Omit<IdempotencyClaim, 'status' | 'result'> = {
      store: async (value) => {
        await sysRedis.set(sysKey, value, { EX: cfg.resultSeconds });
      },
      release: async () => {
        await sysRedis.del(sysKey);
      },
    };
    const fresh = await sysRedis.set(sysKey, sysClaimValue, {
      NX: true,
      EX: cfg.pendingSeconds,
    });
    if (fresh !== null) return { status: 'claimed', ...sys };
    if (cfg.marker) return { status: 'taken', ...sys };
    return { ...readSys(await sysRedis.get(sysKey)), ...sys };
  }

  const pg = <T>(run: () => Promise<T>): Promise<T> =>
    run().catch((error) => {
      throw unavailable(scope, error);
    });
  const inWindow = () => now() < SYS_FALLBACK_UNTIL.getTime();
  const storeBoth = async (value: string) => {
    await pg(() => upsertDone(db, scope, key, value, cfg.resultSeconds));
    await sysRedis.set(sysKey, value, { EX: cfg.resultSeconds }).catch((error) => {
      // sysRedis is the rollback copy; Postgres is what answers while the flag is on.
      if (inWindow()) throw error;
      logSysFailure(scope, 'store', error);
    });
  };

  const fence = await pg(() => claimRow(db, scope, key, cfg.pendingSeconds));
  if (fence === null) {
    const row = await pg(() => readRow(db, scope, key));
    // Gone between the two statements (freed, or lapsed and purged): someone is mid-flight.
    const existing = row ? fromRow(row, cfg.marker) : { status: 'pending' as const };
    return {
      ...existing,
      store: storeBoth,
      // Not ours to free.
      release: async () => undefined,
    };
  }

  const releasePg = () => pg(() => releaseRow(db, scope, key, fence));
  const claimed: IdempotencyClaim = {
    status: 'claimed',
    store: storeBoth,
    release: async () => {
      await releasePg();
      await sysRedis.del(sysKey).catch((error) => {
        if (inWindow()) throw error;
        logSysFailure(scope, 'release', error);
      });
    },
  };

  // Written alongside, and the lookup for a key claimed before the flag: one NX does both.
  let sysFresh: string | null;
  try {
    sysFresh = await sysRedis.set(sysKey, sysClaimValue, { NX: true, EX: cfg.pendingSeconds });
  } catch (error) {
    if (!inWindow()) {
      logSysFailure(scope, 'claim', error);
      return claimed;
    }
    // Cannot tell whether sysRedis holds an older claim: refuse, as the sysRedis path would.
    await releasePg().catch(() => undefined);
    throw unavailable(scope, error);
  }
  if (sysFresh !== null || !inWindow()) return claimed;

  // sysRedis already held the key: a claim from before the flag, or from a pod without it.
  const answer = cfg.marker
    ? { status: 'taken' as const }
    : readSys(await sysRedis.get(sysKey).catch(() => null));
  await releasePg().catch(() => undefined);
  return { ...answer, store: storeBoth, release: async () => undefined };
}

/** Deletes rows past their expiry, in batches. Returns how many were deleted. */
export async function purgeExpiredIdempotencyKeys({
  db = kyselyWrite,
  batch = 5000,
  maxBatches = 100,
}: { db?: Kysely<DB>; batch?: number; maxBatches?: number } = {}) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { numAffectedRows } = await sql`
      DELETE FROM "IdempotencyKey"
      WHERE (scope, key) IN (
        SELECT scope, key FROM "IdempotencyKey" WHERE "expiresAt" < now() LIMIT ${batch}
      )`.execute(db);
    const n = Number(numAffectedRows ?? 0);
    deleted += n;
    if (n < batch) break;
  }
  return deleted;
}

export function isUndefinedTableError(error: unknown) {
  return (error as { code?: string } | null)?.code === UNDEFINED_TABLE;
}

type Row = { state: string; result: string | null };

/** The sysRedis value of a key that was not freshly claimed. */
function readSys(stored: string | null) {
  if (!stored || stored === PENDING) return { status: 'pending' as const };
  return { status: 'done' as const, result: stored };
}

function fromRow(row: Row, marker: boolean) {
  if (marker) return { status: 'taken' as const };
  if (row.state === 'done' && row.result !== null)
    return { status: 'done' as const, result: row.result };
  return { status: 'pending' as const };
}

/**
 * Claims the key, or takes it over when its row has expired, in one statement. Returns the claim's
 * `createdAt` (the fence `releaseRow` checks), or null when someone else holds it.
 *
 * An expired `done` row is taken over too, not only a stale `pending` one: on sysRedis an expired
 * result is simply gone, so a repeat after the TTL acts again, and the purge job's timing must not
 * stretch that.
 */
async function claimRow(db: Kysely<DB>, scope: string, key: string, pendingSeconds: number) {
  const { rows } = await sql<{ fence: string }>`
    INSERT INTO "IdempotencyKey" (scope, key, state, "createdAt", "expiresAt")
    VALUES (${scope}, ${key}, 'pending', now(), now() + make_interval(secs => ${pendingSeconds}))
    ON CONFLICT (scope, key) DO UPDATE
      SET state = 'pending', result = NULL,
          "createdAt" = EXCLUDED."createdAt", "expiresAt" = EXCLUDED."expiresAt"
      WHERE "IdempotencyKey"."expiresAt" < now()
    RETURNING "createdAt"::text AS fence`.execute(db);
  return rows[0]?.fence ?? null;
}

async function readRow(db: Kysely<DB>, scope: string, key: string) {
  const { rows } = await sql<Row>`
    SELECT state, result::text AS result FROM "IdempotencyKey"
    WHERE scope = ${scope} AND key = ${key} AND "expiresAt" >= now()`.execute(db);
  return rows[0];
}

async function upsertDone(
  db: Kysely<DB>,
  scope: string,
  key: string,
  value: string,
  resultSeconds: number
) {
  await sql`
    INSERT INTO "IdempotencyKey" (scope, key, state, result, "createdAt", "expiresAt")
    VALUES (${scope}, ${key}, 'done', ${value}::jsonb, now(),
            now() + make_interval(secs => ${resultSeconds}))
    ON CONFLICT (scope, key) DO UPDATE
      SET state = 'done', result = EXCLUDED.result, "expiresAt" = EXCLUDED."expiresAt"`.execute(db);
}

/** Frees only this caller's own pending claim: one taken over after it lapsed is someone else's. */
async function releaseRow(db: Kysely<DB>, scope: string, key: string, fence: string) {
  await sql`
    DELETE FROM "IdempotencyKey"
    WHERE scope = ${scope} AND key = ${key} AND state = 'pending'
      AND "createdAt" = ${fence}::timestamptz`.execute(db);
}

function unavailable(scope: IdempotencyScope, error: unknown) {
  if (error instanceof IdempotencyUnavailableError) return error;
  const tableMissing = isUndefinedTableError(error);
  logToAxiom({
    name: 'idempotency-key',
    type: 'error',
    scope,
    tableMissing,
    message: (error as Error)?.message,
  });
  return new IdempotencyUnavailableError(scope, tableMissing, error);
}

function logSysFailure(scope: IdempotencyScope, op: string, error: unknown) {
  logToAxiom({
    name: 'idempotency-key',
    type: 'warning',
    scope,
    message: `sysRedis ${op} failed after the fallback window: ${(error as Error)?.message}`,
  });
}

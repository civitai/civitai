import { randomBytes } from 'crypto';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

/**
 * The day's salt for signed-out viewer keys in `appBlockEvents`.
 *
 * 🔴 THE CONTRACT (the migration header states it; "the raw IP is not stored" holds only under it):
 *   - ONE random value per UTC day, shared by every process that writes the table. The shared
 *     store is the only source: a value generated here is only ever a set-if-absent candidate,
 *     and what is used is what the store returns. The copy held here is a cache of that for the
 *     day, re-read every `REVALIDATE_MS` so a process cannot keep a salt the store has lost. A
 *     per-process salt would give one viewer a different key on every process and restart.
 *   - Lifetime: the store's key expires `BLOCK_EVENT_SALT_EXPIRY_MARGIN_SECONDS` after its UTC
 *     day; a process drops its cached copy on its first call of the next day.
 *   - Never derived from a secret, a date or anything else that outlives the day. IPv4 is only
 *     2^32 addresses, so whoever can recompute a salt can reverse every signed-out row.
 *   - If the store cannot answer, there is NO fallback: the caller drops signed-out rows.
 *
 * 🔴 WHAT THIS REQUIRES OF THE STORE, which no code here can check: once the key expires the
 * value must be gone. A store that keeps expired values in a snapshot, an append-only log or a
 * backup for longer than the day turns "not stored" into "recoverable by whoever holds that
 * copy". Whoever operates the store owns that property.
 */

/**
 * How long past its UTC day a salt stays readable. Processes disagree about the time by seconds,
 * so one that still believes it is yesterday just after midnight must find yesterday's salt
 * rather than a gap. A process further behind than this is expected to get no salt, because its
 * set-if-absent carries an expiry already in the past. That is the store's behaviour, modelled by
 * the test's fake and not proven against a real store.
 */
export const BLOCK_EVENT_SALT_EXPIRY_MARGIN_SECONDS = 600;

/** After a failed read, how long to answer "unavailable" without asking the store again. */
const UNAVAILABLE_RETRY_MS = 5_000;

/** How long a cached salt is used before it is checked against the store again. */
const REVALIDATE_MS = 60_000;

const DAY_SECONDS = 86_400;

let cached: { day: string; salt: string; checkedAtMs: number } | null = null;
let inflight: { day: string; promise: Promise<string | null> } | null = null;
let unavailableUntilMs = 0;

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

async function readSharedSalt(day: string): Promise<string | null> {
  try {
    const key = `${REDIS_SYS_KEYS.BLOCKS.EVENT_DAY_SALT}:${day}` as const;
    const expiresAt =
      Date.parse(`${day}T00:00:00.000Z`) / 1000 +
      DAY_SECONDS +
      BLOCK_EVENT_SALT_EXPIRY_MARGIN_SECONDS;
    // Set-if-absent, then read back. Winner and loser both use what the store holds, so two
    // processes racing on the first event of a day end up with the same salt.
    await withSysReadDeadline(
      sysRedis.set(key, randomBytes(32).toString('base64url'), { NX: true, EXAT: expiresAt })
    );
    const stored = await withSysReadDeadline(sysRedis.get(key));
    return typeof stored === 'string' && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** The salt for the UTC day containing `nowMs`, or `null` when the shared store cannot supply it. */
export async function getBlockEventDaySalt(nowMs: number = Date.now()): Promise<string | null> {
  const day = utcDay(nowMs);
  if (cached && cached.day !== day) cached = null;
  if (cached && nowMs - cached.checkedAtMs < REVALIDATE_MS) return cached.salt;
  // The cached value was the store's a minute ago; if the store cannot be asked now, it is still
  // the best statement of the shared value, so keep it rather than drop a day's signed-out rows.
  const lastKnown = cached?.salt ?? null;
  if (nowMs < unavailableUntilMs) return lastKnown;
  if (inflight?.day === day) return inflight.promise;

  const promise = readSharedSalt(day)
    .then((salt) => {
      if (salt) {
        cached = { day, salt, checkedAtMs: nowMs };
        return salt;
      }
      unavailableUntilMs = nowMs + UNAVAILABLE_RETRY_MS;
      return lastKnown;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { day, promise };
  return promise;
}

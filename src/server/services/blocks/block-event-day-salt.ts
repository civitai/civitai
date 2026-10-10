import { randomBytes } from 'crypto';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

/**
 * The day's salt for signed-out viewer keys in `appBlockEvents`.
 *
 * 🔴 THE CONTRACT (the migration header states it; "the raw IP is not stored" holds only under it):
 *   - ONE random value per UTC day, shared by every process that writes the table. The shared
 *     store is the only source. The copy held here is a cache of that value for that day and is
 *     never generated locally: a per-process salt would give one viewer a different key on every
 *     process and after every restart.
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
 * rather than a gap. A process further behind than this gets no salt: its set-if-absent carries
 * an expiry already in the past, so the store discards it and the read comes back empty.
 */
export const BLOCK_EVENT_SALT_EXPIRY_MARGIN_SECONDS = 600;

/** After a failed read, how long to answer "unavailable" without asking the store again. */
const UNAVAILABLE_RETRY_MS = 5_000;

const DAY_SECONDS = 86_400;

let cached: { day: string; salt: string } | null = null;
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
  if (cached?.day === day) return cached.salt;
  cached = null;
  if (nowMs < unavailableUntilMs) return null;
  if (inflight?.day === day) return inflight.promise;

  const promise = readSharedSalt(day)
    .then((salt) => {
      if (salt) cached = { day, salt };
      else unavailableUntilMs = nowMs + UNAVAILABLE_RETRY_MS;
      return salt;
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { day, promise };
  return promise;
}

export const _internalsForTests = {
  reset(): void {
    cached = null;
    inflight = null;
    unavailableUntilMs = 0;
  },
};

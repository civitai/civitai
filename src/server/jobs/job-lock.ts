import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

const LOCK_REFRESH_INTERVAL = 8; // Every 8 seconds
const LOCK_BUFFER = 2; // 2 second buffer on redis expiry

// Release only if we still hold the token. The old blind DEL let a fast run
// free a concurrent slow run's lock.
const LOCK_RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
// Extend the TTL only if we still hold the token (don't clobber a lock that
// expired and was re-acquired by another run).
const LOCK_REFRESH_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2])
  else
    return 0
  end
`;

// A held job lock. `release()` is idempotent and closes over THIS run's token +
// interval only — it can never free or clear a different (newer) run's lock,
// which is why token/interval must be per-invocation, not keyed by job name.
export type JobLock = { release: () => Promise<void> };

export const NOOP_LOCK: JobLock = { release: async () => undefined };

export const jobLockKey = (name: string) => `${REDIS_SYS_KEYS.JOB}:${name}` as const;

export type JobLockRedis = Pick<NonNullable<typeof sysRedis>, 'set' | 'eval'>;

// Not `withDistributedLock` (utils/distributed-lock.ts): this one must be the run-jobs route's own
// key, never waits, and caps the hold at the job's lockExpiration.
// Atomically acquire the job lock. Returns null if another run already holds it.
// Uses SET NX (atomic check-and-set) instead of the old GET-then-SET, which let
// two concurrent triggers both pass the check and run the same job in parallel
// (e.g. the duplicate ingest-images cron triggers).
// `failOpen: false` reads an unreachable Redis as held, for a caller that can skip a run.
export async function acquireJobLock(
  name: string,
  lockExpiration: number,
  redis: JobLockRedis | undefined = sysRedis,
  { failOpen = true }: { failOpen?: boolean } = {}
): Promise<JobLock | null> {
  // Redis unavailable — fail open (run without a lock), matching prior behavior.
  if (!redis) return failOpen ? NOOP_LOCK : null;
  const key = jobLockKey(name);

  const token = `${env.PODNAME ?? 'unknown'}:${Date.now()}-${Math.random()}`;
  let acquired: string | null;
  try {
    acquired = await redis.set(key, token, {
      NX: true,
      EX: LOCK_REFRESH_INTERVAL + LOCK_BUFFER,
    });
  } catch (e) {
    // Redis errored on acquire — fail open (run unlocked) rather than skip.
    logToAxiom(
      { type: 'job-lock', message: 'acquire-error', job: name, error: (e as Error)?.message },
      'webhooks'
    ).catch();
    return failOpen ? NOOP_LOCK : null;
  }
  if (acquired !== 'OK') return null;

  logToAxiom({ type: 'job-lock', message: 'lock', job: name }, 'webhooks').catch();

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(interval);
    logToAxiom({ type: 'job-lock', message: 'unlock', job: name }, 'webhooks').catch();
    await redis
      .eval(LOCK_RELEASE_SCRIPT, { keys: [key], arguments: [token] })
      .catch(() => undefined);
  };

  // Refresh while we still own the lock so long jobs keep it and dead pods
  // release it (the short TTL lapses). Hard-cap total hold at lockExpiration.
  let ttl = lockExpiration;
  const interval = setInterval(async () => {
    ttl -= LOCK_REFRESH_INTERVAL;
    if (ttl <= 0) {
      release().catch(() => undefined);
      return;
    }
    await redis
      .eval(LOCK_REFRESH_SCRIPT, {
        keys: [key],
        arguments: [token, String(LOCK_REFRESH_INTERVAL + LOCK_BUFFER)],
      })
      .catch(() => undefined);
  }, LOCK_REFRESH_INTERVAL * 1000);

  return { release };
}

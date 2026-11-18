import { randomUUID } from 'node:crypto';
import { REDIS_SYS_KEYS, type RedisKeyTemplateSys, type RedisSysClient } from '@civitai/redis';

/**
 * One batch's run lock, shared by its send and its export so the two never overlap. The value is the
 * holder's token: only the holder renews or releases it, so a lock that expired and was taken by
 * someone else is never extended or deleted from under them.
 */
export const RUN_LOCK_TTL_SECONDS = 15 * 60;

const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) end return 0`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

type LockRedis = Pick<RedisSysClient, 'set' | 'get' | 'eval'>;

export const runLockKey = (batchId: string) =>
  `${REDIS_SYS_KEYS.APP.CASES_SEND_RUNNING}:${batchId}` as RedisKeyTemplateSys;

/** The token if the lock was free, else null. */
export async function acquireRunLock(
  redis: LockRedis,
  batchId: string,
  ttl = RUN_LOCK_TTL_SECONDS
) {
  const token = randomUUID();
  const got = await redis.set(runLockKey(batchId), token, { NX: true, EX: ttl });
  return got ? token : null;
}

/** Extends the lock while it is still this token's; false once it expired or someone else holds it. */
export async function renewRunLock(
  redis: LockRedis,
  batchId: string,
  token: string,
  ttl = RUN_LOCK_TTL_SECONDS
) {
  const r = await redis.eval(RENEW, {
    keys: [runLockKey(batchId)],
    arguments: [token, String(ttl)],
  });
  return Number(r) === 1;
}

export async function releaseRunLock(redis: LockRedis, batchId: string, token: string) {
  await redis.eval(RELEASE, { keys: [runLockKey(batchId)], arguments: [token] });
}

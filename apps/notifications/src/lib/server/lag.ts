// Replication-lag routing for the notif pools, on @civitai/db's `createLagTracker`. `getRedis` is handed
// in as a lazy store (resolved once on first use — so importing this never connects, and a null redis
// degrades to replica reads). A write flags the user's key; a read within REPLICATION_LAG_DELAY routes
// to the primary. The monolith's Flipt global kill-switch is intentionally dropped here.

import { createLagTracker, type AugmentedPool } from '@civitai/db';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '@civitai/redis';
import { getRedis } from './clients/redis';
import { notifDbRead, notifDbWrite } from './clients/db';

const tracker = createLagTracker<RedisKeyTemplateCache>({
  store: getRedis,
  delaySeconds: Number(process.env.REPLICATION_LAG_DELAY ?? 0),
});

const lagKey = (userId: number) =>
  `${REDIS_KEYS.LAG_HELPER}:notification:${userId}` as RedisKeyTemplateCache;

/** The write pool when this user has a fresh write flagged (else the replica). */
export async function getNotifDbWithoutLag(userId: number): Promise<AugmentedPool> {
  return (await tracker.isStale(lagKey(userId))) ? notifDbWrite() : notifDbRead();
}

/** Flag a fresh write for this user so reads within the lag window route to the primary. */
export const preventReplicationLag = (userId: number) => tracker.markFresh(lagKey(userId));

/** True when the pool is the write pool — callers bust the cache before a lagged read. */
export const isWritePool = (pool: AugmentedPool) => pool === notifDbWrite();

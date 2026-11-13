import { isNonProductionDatabase } from '~/env/database-target';
import { setIngestionGaugeSharedStore, type IngestionGaugeSharedStore } from '~/server/prom/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

// One snapshot (and lock) per version, so releases whose queries differ never share one.
const snapshotKey = (version: string) =>
  `${REDIS_SYS_KEYS.SYSTEM.IMAGE_INGESTION_GAUGES}:${version}` as const;
const lockKey = (version: string) => `${snapshotKey(version)}:lock` as const;

type StoreRedis = Pick<NonNullable<typeof sysRedis>, 'get' | 'set'>;

// sysRedis, not the cache client: the election lock must not be evictable. Every call is raced
// against the sys read deadline because the refresh awaits it, and a half-open connection would
// otherwise park it for minutes and stop this process refreshing at all.
export function createIngestionGaugeStore(redis: StoreRedis): IngestionGaugeSharedStore {
  return {
    read: (version) => withSysReadDeadline(redis.get(snapshotKey(version))),
    tryLock: async (version, ttlMs) =>
      (await withSysReadDeadline(
        redis.set<string>(lockKey(version), '1', { NX: true, PX: ttlMs })
      )) === 'OK',
    write: async (version, value, ttlMs) => {
      await withSysReadDeadline(redis.set(snapshotKey(version), value, { PX: ttlMs }));
    },
  };
}

// sys keys carry no environment segment and several deployments share one sysRedis, so only
// deployments on the production database may share the production snapshot. The rest keep
// computing their own.
export function installIngestionGaugeStore(env: NodeJS.ProcessEnv = process.env) {
  if (!sysRedis || isNonProductionDatabase(env)) return false;
  setIngestionGaugeSharedStore(createIngestionGaugeStore(sysRedis));
  return true;
}

installIngestionGaugeStore();

import { createKvSnapshotStore, loadFliptTuning } from '@civitai/flipt';
import { env } from '~/env/server';
import { setFliptSnapshotStore } from '~/server/flipt/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';

type SnapshotKey = `${typeof REDIS_SYS_KEYS.FLIPT.SNAPSHOT}:${string}`;

/**
 * The last-known Flipt flag state, kept in sysRedis, so a pod that starts while Flipt is
 * unreachable evaluates the state its siblings are serving instead of `false` for every flag
 * (which turns the default-on flags OFF on that pod alone).
 *
 * DARK by default: with FLIPT_SNAPSHOT_MAX_AGE_MS unset or `0` no store is registered, so nothing
 * is read or written. When set (e.g. 86400000 for 24h) it is read ONLY when this pod's own Flipt
 * init fails, and only if the stored copy is at most that old.
 * Pods with live state keep it current; createKvSnapshotStore documents the write rate.
 *
 * Its own module, registered from instrumentation.node.ts, because ~/server/flipt/client is in
 * the _app client graph and must not reach sysRedis.
 */
export function registerFliptSnapshotStore(): void {
  const tuning = loadFliptTuning();
  if (env.IS_BUILD || tuning.snapshotMaxAgeMs <= 0) return;
  setFliptSnapshotStore(
    createKvSnapshotStore({
      kv: {
        get: (key) => withSysReadDeadline(sysRedis.get(key as SnapshotKey)),
        set: (key, value, ttlMs) => sysRedis.set(key as SnapshotKey, value, { PX: ttlMs }),
      },
      key: `${REDIS_SYS_KEYS.FLIPT.SNAPSHOT}:${tuning.environment}`,
      maxAgeMs: tuning.snapshotMaxAgeMs,
      refreshIntervalMs: tuning.snapshotSaveIntervalMs,
    })
  );
}

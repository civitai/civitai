import { prefixCacheKey, type RedisKeyTemplateCache } from '@civitai/redis';
import type { Snapshot } from '$lib/tickets/snapshot';
import type { BuildFailure, SnapshotStore } from './snapshot-service';

/** Outlives the full-rebuild interval, so a snapshot only expires once every server has stopped refreshing it. */
export const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
/** Long enough to outlive the retry interval, short enough that a fixed outage is not remembered. */
export const BUILD_FAILURE_TTL_SECONDS = 15 * 60;
/**
 * Longer than a full rebuild can take in the worst case: its 80-call budget at the 8s Freshdesk
 * timeout is 640s, so a live refresh never loses its lock. A crashed holder blocks refreshes for at most this long.
 */
export const LOCK_TTL_SECONDS = 660;

const SNAPSHOT_KEY = prefixCacheKey('mod:tickets:snapshot:v2') as RedisKeyTemplateCache;
const FAILURE_KEY = prefixCacheKey(
  'mod:tickets:snapshot:build-failure:v1'
) as RedisKeyTemplateCache;
const LOCK_KEY = prefixCacheKey('mod:tickets:snapshot:lock:v1') as RedisKeyTemplateCache;

type Client = {
  get(key: RedisKeyTemplateCache): Promise<string | null>;
  set(
    key: RedisKeyTemplateCache,
    value: string,
    options?: { EX?: number; NX?: boolean }
  ): Promise<unknown>;
  del(key: RedisKeyTemplateCache): Promise<unknown>;
};

const isFailure = (v: unknown): v is BuildFailure =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as BuildFailure).at === 'number' &&
  typeof (v as BuildFailure).reason === 'string';

const isSnapshot = (v: unknown): v is Snapshot =>
  typeof v === 'object' &&
  v !== null &&
  Array.isArray((v as Snapshot).tickets) &&
  typeof (v as Snapshot).syncedAt === 'number' &&
  typeof (v as Snapshot).attemptedAt === 'number' &&
  typeof (v as Snapshot).fullAt === 'number';

/** The snapshot as one JSON value under one key, and its refresh lock. */
export function createRedisSnapshotStore(client: () => Client): SnapshotStore {
  return {
    async read() {
      const raw = await client().get(SNAPSHOT_KEY);
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isSnapshot(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async write(snapshot) {
      await client().set(SNAPSHOT_KEY, JSON.stringify(snapshot), { EX: SNAPSHOT_TTL_SECONDS });
    },

    async readBuildFailure() {
      const raw = await client().get(FAILURE_KEY);
      if (!raw) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isFailure(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async writeBuildFailure(failure) {
      await client().set(FAILURE_KEY, JSON.stringify(failure), { EX: BUILD_FAILURE_TTL_SECONDS });
    },

    async lock(token) {
      const reply = await client().set(LOCK_KEY, token, { EX: LOCK_TTL_SECONDS, NX: true });
      return reply !== null;
    },

    // Not atomic: if the lock expired and another process took it between these two calls, this releases
    // theirs. The window is two round trips against the lock's TTL; the cost is one extra concurrent refresh.
    async unlock(token) {
      if ((await client().get(LOCK_KEY)) === token) await client().del(LOCK_KEY);
    },
  };
}

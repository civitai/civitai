import { prefixCacheKey, type RedisKeyTemplateCache } from '@civitai/redis';
import type { Snapshot } from '$lib/tickets/snapshot';
import type { SnapshotStore } from './snapshot-service';

/** Outlives the full-rebuild interval, so a snapshot only expires once every server has stopped refreshing it. */
export const SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;
/** Longer than a full rebuild takes (about 12s, bounded by its call budget), so a live refresh never loses its lock. */
export const LOCK_TTL_SECONDS = 90;

const SNAPSHOT_KEY = prefixCacheKey('mod:tickets:snapshot:v1') as RedisKeyTemplateCache;
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

    async lock(token) {
      const reply = await client().set(LOCK_KEY, token, { EX: LOCK_TTL_SECONDS, NX: true });
      return reply !== null;
    },

    // Not atomic: if the lock expired and another process took it between these two calls, this releases
    // theirs. The window is two round trips against a 90s lock; the cost is one extra concurrent refresh.
    async unlock(token) {
      if ((await client().get(LOCK_KEY)) === token) await client().del(LOCK_KEY);
    },
  };
}

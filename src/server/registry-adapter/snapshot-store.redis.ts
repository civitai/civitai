import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import { STATES_KEPT_PER_STREAM } from '~/server/registry-adapter/cursor';
import { sha256Hex } from '~/server/registry-adapter/release';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { boundedClusterCall } from '~/server/utils/cluster-window-count';

/** How long a cursor stays resumable after it was last issued or resumed from. */
export const SNAPSHOT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The cache-client surface this store uses, so a test can hand in a fake. */
export type SnapshotRedis = Pick<typeof redis, 'get' | 'del' | 'multi'>;

export const snapshotKey = (digest: string) =>
  `${REDIS_KEYS.REGISTRY_ADAPTER.SNAPSHOT}:${digest}` as const;
export const streamStatesKey = (stream: string) =>
  `${REDIS_KEYS.REGISTRY_ADAPTER.STREAM_STATES}:${sha256Hex(stream).slice(0, 32)}` as const;

/**
 * Snapshots on the cache cluster, at most {@link STATES_KEPT_PER_STREAM} per stream, newest first.
 *
 * A cursor names only a digest, so a snapshot's key cannot carry its stream's hash tag, and the
 * snapshot and its stream's list are in different slots. They are written apart: the snapshot
 * first, then one MULTI on the list alone moves its digest to the head, reads what falls past the
 * bound and trims it, and refreshes the list's TTL, so concurrent writers of one stream never lose
 * each other's digests. The digests that fell off are deleted after it.
 *
 * Losing any of this costs a re-snapshot and nothing else: a snapshot whose write lands but whose
 * list update fails is only bounded by its TTL; a digest pushed again after it fell off expires
 * its cursor early; a key the cluster evicts expires that cursor (`cursor_expired`).
 */
export function createRedisSnapshotStore(
  client: SnapshotRedis = redis,
  keep: number = STATES_KEPT_PER_STREAM,
  /** How long a state is kept after it was last written or touched; a private stream's is shorter. */
  retentionSeconds: number = SNAPSHOT_RETENTION_SECONDS
): SnapshotStore {
  const call = <T>(fn: string, op: () => Promise<T>) =>
    boundedClusterCall(`registrySnapshot.${fn}`, op);

  /** With `value` null, only refreshes the snapshot's TTL (a resume). */
  async function retain(digest: string, stream: string, value: string | null): Promise<void> {
    const states = streamStatesKey(stream);
    const snapshot = snapshotKey(digest);
    await call('retain.snapshot', () =>
      value === null
        ? client.multi().expire(snapshot, retentionSeconds).exec()
        : client.multi().set(snapshot, value, { EX: retentionSeconds }).exec()
    );
    const results = await call('retain.states', () =>
      client
        .multi()
        .lRem(states, 0, digest)
        .lPush(states, digest)
        .lRange(states, keep, -1)
        .lTrim(states, 0, keep - 1)
        .expire(states, retentionSeconds)
        .exec()
    );
    const evicted = Array.isArray(results?.[2]) ? (results[2] as unknown[]) : [];
    for (const old of evicted) {
      const d = String(decodeRedisString(old as string));
      if (d !== digest) await call('retain.drop', () => client.del(snapshotKey(d)));
    }
  }

  return {
    async get(digest) {
      return decodeRedisString(await call('get', () => client.get(snapshotKey(digest)))) ?? null;
    },
    put: (digest, value, stream) => retain(digest, stream, value),
    touch: (digest, stream) => retain(digest, stream, null),
  };
}

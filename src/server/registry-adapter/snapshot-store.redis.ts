import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import { STATES_KEPT_PER_STREAM } from '~/server/registry-adapter/cursor';
import { sha256Hex } from '~/server/registry-adapter/release';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import {
  REDIS_SYS_KEYS,
  sysRedis,
  withSysDeadline,
  withSysReadDeadline,
} from '~/server/redis/client';

/** How long a cursor stays resumable after it was last issued or resumed from. */
export const SNAPSHOT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The sys-client surface this store uses, so a test can hand in a fake. */
export type SnapshotRedis = Pick<typeof sysRedis, 'get' | 'del' | 'multi'>;

export const snapshotKey = (digest: string) =>
  `${REDIS_SYS_KEYS.REGISTRY_ADAPTER.SNAPSHOT}:${digest}` as const;
export const streamStatesKey = (stream: string) =>
  `${REDIS_SYS_KEYS.REGISTRY_ADAPTER.STREAM_STATES}:${sha256Hex(stream).slice(0, 32)}` as const;

/**
 * Snapshots in system Redis, at most {@link STATES_KEPT_PER_STREAM} per stream, newest first.
 *
 * One MULTI writes the snapshot and moves its digest to the head of the stream's list, reads
 * what falls past the bound and trims it, and refreshes the list's TTL, so concurrent writers of
 * one stream never lose each other's digests (a multi-key MULTI on the system client, as
 * `download-repeats.ts` and `rate-limiting.ts` use). The digests that fell off are deleted after
 * the MULTI.
 * If one of them is pushed again meanwhile, its cursor expires early, which costs a
 * re-snapshot and nothing else.
 */
export function createRedisSnapshotStore(
  client: SnapshotRedis = sysRedis,
  keep: number = STATES_KEPT_PER_STREAM
): SnapshotStore {
  /** With `value` null, only refreshes the snapshot's TTL (a resume). */
  async function retain(digest: string, stream: string, value: string | null): Promise<void> {
    const states = streamStatesKey(stream);
    const tx = client.multi();
    if (value === null) tx.expire(snapshotKey(digest), SNAPSHOT_RETENTION_SECONDS);
    else tx.set(snapshotKey(digest), value, { EX: SNAPSHOT_RETENTION_SECONDS });
    tx.lRem(states, 0, digest);
    tx.lPush(states, digest);
    tx.lRange(states, keep, -1);
    tx.lTrim(states, 0, keep - 1);
    tx.expire(states, SNAPSHOT_RETENTION_SECONDS);
    const results = await withSysDeadline(tx.exec());
    const evicted = Array.isArray(results?.[3]) ? (results[3] as unknown[]) : [];
    for (const old of evicted) {
      const d = String(decodeRedisString(old as string));
      if (d !== digest) await client.del(snapshotKey(d));
    }
  }

  return {
    async get(digest) {
      return decodeRedisString(await withSysReadDeadline(client.get(snapshotKey(digest)))) ?? null;
    },
    put: (digest, value, stream) => retain(digest, stream, value),
    touch: (digest, stream) => retain(digest, stream, null),
  };
}

import { describe, expect, it } from 'vitest';
import type { SnapshotRedis } from '~/server/registry-adapter/snapshot-store.redis';
import {
  SNAPSHOT_RETENTION_SECONDS,
  createRedisSnapshotStore,
  snapshotKey,
  streamStatesKey,
} from '~/server/registry-adapter/snapshot-store.redis';

/**
 * An in-memory Redis with the semantics the store relies on: strings with a TTL, lists with
 * LREM / LPUSH / LRANGE (negative stop) / LTRIM, EXPIRE, and MULTI whose queued commands run
 * together at EXEC. List commands outside a MULTI are counted, so a write that is not atomic
 * shows up.
 */
function fakeRedis() {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const ttl = new Map<string, number>();
  const counts = { exec: 0, listOpsOutsideMulti: 0, sets: 0 };
  const range = (l: string[], start: number, stop: number) =>
    l.slice(start, stop < 0 ? l.length + stop + 1 : stop + 1);
  const ops = {
    set: (k: string, v: string, o?: { EX?: number }) => {
      counts.sets++;
      strings.set(k, v);
      if (o?.EX) ttl.set(k, o.EX);
      return 'OK';
    },
    lRem: (k: string, _n: number, v: string) => {
      const l = lists.get(k) ?? [];
      lists.set(
        k,
        l.filter((x) => x !== v)
      );
      return l.length - (lists.get(k)?.length ?? 0);
    },
    lPush: (k: string, v: string) => {
      const l = [v, ...(lists.get(k) ?? [])];
      lists.set(k, l);
      return l.length;
    },
    lRange: (k: string, start: number, stop: number) => range(lists.get(k) ?? [], start, stop),
    lTrim: (k: string, start: number, stop: number) => {
      lists.set(k, range(lists.get(k) ?? [], start, stop));
      return 'OK';
    },
    expire: (k: string, s: number) => {
      ttl.set(k, s);
      return true;
    },
  };
  const outside =
    <A extends unknown[], R>(f: (...a: A) => R) =>
    async (...a: A) => {
      counts.listOpsOutsideMulti++;
      return f(...a);
    };
  const client = {
    get: async (k: string) => strings.get(k) ?? null,
    del: async (k: string) => Number(strings.delete(k)),
    lRange: outside(ops.lRange),
    lPush: outside(ops.lPush),
    multi() {
      const queued: Array<() => unknown> = [];
      const tx: Record<string, unknown> = {
        exec: async () => {
          counts.exec++;
          return queued.map((q) => q());
        },
      };
      for (const [name, f] of Object.entries(ops)) {
        tx[name] = (...a: unknown[]) => {
          queued.push(() => (f as (...x: unknown[]) => unknown)(...a));
          return tx;
        };
      }
      return tx;
    },
  };
  return { client: client as unknown as SnapshotRedis, strings, lists, ttl, counts };
}

const S1 = 'urn:schema:apps.civitai.com:orbit-notes/notes@v1';
const S2 = 'urn:schema:apps.civitai.com:orbit-notes/notes@v2';

describe('createRedisSnapshotStore', () => {
  it('a snapshot written is read back', async () => {
    const r = fakeRedis();
    const store = createRedisSnapshotStore(r.client, 2);
    await store.put('d1', '{"schema":"s"}', S1);
    expect(await store.get('d1')).toBe('{"schema":"s"}');
    expect(await store.get('d-missing')).toBeNull();
  });

  it('🔴 keeps the newest states of a stream and deletes what falls past the bound', async () => {
    const r = fakeRedis();
    const store = createRedisSnapshotStore(r.client, 2);
    for (const d of ['d1', 'd2', 'd3']) await store.put(d, `state-${d}`, S1);
    expect([await store.get('d1'), await store.get('d2'), await store.get('d3')]).toEqual([
      null,
      'state-d2',
      'state-d3',
    ]);
    expect(r.lists.get(streamStatesKey(S1))).toEqual(['d3', 'd2']);
  });

  it('a resumed state moves to the head, evicts nothing, and refreshes the TTLs', async () => {
    const r = fakeRedis();
    const store = createRedisSnapshotStore(r.client, 2);
    await store.put('d1', 'state-d1', S1);
    await store.put('d2', 'state-d2', S1);
    r.ttl.clear();
    await store.put('d1', 'state-d1', S1);
    expect(r.lists.get(streamStatesKey(S1))).toEqual(['d1', 'd2']);
    expect(await store.get('d2')).toBe('state-d2');
    expect([r.ttl.get(streamStatesKey(S1)), r.ttl.get(snapshotKey('d1'))]).toEqual([
      SNAPSHOT_RETENTION_SECONDS,
      SNAPSHOT_RETENTION_SECONDS,
    ]);
  });

  it('🔴 the TTL of a stream list is refreshed even when its digest is already the newest', async () => {
    const r = fakeRedis();
    const store = createRedisSnapshotStore(r.client, 2);
    await store.put('d1', 'state-d1', S1);
    r.ttl.clear();
    await store.put('d1', 'state-d1', S1);
    expect(r.ttl.get(streamStatesKey(S1))).toBe(SNAPSHOT_RETENTION_SECONDS);
  });

  it('🔴 every list change of a put is one MULTI', async () => {
    const r = fakeRedis();
    const store = createRedisSnapshotStore(r.client, 2);
    for (const d of ['d1', 'd2', 'd3', 'd2']) {
      const execs = r.counts.exec;
      await store.put(d, `state-${d}`, S1);
      // The fake applies queued commands only at EXEC: the list moved, and an EXEC ran.
      expect(r.lists.get(streamStatesKey(S1))?.[0]).toBe(d);
      expect(r.counts.exec).toBeGreaterThan(execs);
    }
    expect(r.counts.listOpsOutsideMulti).toBe(0);
  });

  it('🔴 touch refreshes a held state without rewriting it, in one MULTI', async () => {
    const r = fakeRedis();
    const store = createRedisSnapshotStore(r.client, 2);
    await store.put('d1', 'state-d1', S1);
    await store.put('d2', 'state-d2', S1);
    r.ttl.clear();
    const before = { ...r.counts };
    await store.touch('d1', S1);
    expect(r.counts).toEqual({ ...before, exec: before.exec + 1 });
    expect(await store.get('d1')).toBe('state-d1');
    expect(r.lists.get(streamStatesKey(S1))).toEqual(['d1', 'd2']);
    expect([r.ttl.get(snapshotKey('d1')), r.ttl.get(streamStatesKey(S1))]).toEqual([
      SNAPSHOT_RETENTION_SECONDS,
      SNAPSHOT_RETENTION_SECONDS,
    ]);
  });

  it("one stream's bound never evicts another stream's states", async () => {
    const r = fakeRedis();
    const store = createRedisSnapshotStore(r.client, 2);
    await store.put('a1', 'state-a1', S1);
    for (const d of ['b1', 'b2', 'b3']) await store.put(d, `state-${d}`, S2);
    expect(await store.get('a1')).toBe('state-a1');
    expect(r.lists.get(streamStatesKey(S2))).toEqual(['b3', 'b2']);
  });
});

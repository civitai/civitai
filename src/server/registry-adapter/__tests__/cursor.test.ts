import { describe, expect, it } from 'vitest';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import { createPollingAdapter, retainLatest, sharedRead } from '~/server/registry-adapter/cursor';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';
import type { Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';

const APPS = 'urn:schema:apps.civitai.com:app@v1';
const RELEASES = 'urn:schema:apps.civitai.com:app-release@v1';

const e = (slug: string, rev: string): Entity => ({
  urn: `urn:apps.civitai.com:app/${slug}`,
  schemas: [APPS],
  rev,
  body: { slug, rev },
});

/**
 * An adapter over a scripted catalog. `states` is read in order, one per poll, the last one
 * repeating. Its sleep stops the subscription after `maxPolls` polls, so `changes` always ends.
 */
function harness(store: SnapshotStore, states: Entity[][], maxPolls = 3) {
  let reads = 0;
  let polls = 0;
  const abort = new AbortController();
  const adapter = createPollingAdapter({
    namespace: 'apps.civitai.com',
    serves: [APPS, RELEASES],
    read: async () => {
      const state = states[Math.min(reads++, states.length - 1)];
      return new Map([
        [APPS, state],
        [RELEASES, []],
      ]);
    },
    store,
    pollMs: 1,
    sleep: async () => {
      if (++polls >= maxPolls) abort.abort();
    },
  });
  const drain = async (schema: string, cursor: string) => {
    const out: Edit[] = [];
    for await (const c of await adapter.changes(schema, cursor, { signal: abort.signal })) {
      // Its served set is the whole schema's, so its cursor moves only with a change.
      if ('progress' in c) throw new Error('the catalog adapter yielded progress');
      out.push(c);
    }
    return out;
  };
  return { adapter, drain, signal: abort.signal, polls: () => polls };
}

type Edit = Exclude<Change, { progress: string }>;

const shape = (c: Edit) =>
  'upsert' in c ? ['upsert', c.upsert.urn, c.upsert.rev] : ['delete', c.delete];

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof ProtocolError ? err.code : `other: ${String(err)}`;
  }
}

describe('polling adapter — snapshot, then changes from a durable cursor', () => {
  const V1 = [e('alpha-app', 'r-a1'), e('beta-app', 'r-b1'), e('gamma-app', 'r-g1')];
  const V2 = [e('alpha-app', 'r-a2'), e('gamma-app', 'r-g1'), e('delta-app', 'r-d1')];

  it('🔴 a cursor survives a restart: a new process resumes it with deletes, adds and updates', async () => {
    const store = createMemorySnapshotStore();
    const first = harness(store, [V1]);
    const snap = await first.adapter.snapshot(APPS, { signal: first.signal });
    expect(snap.cursor).toMatch(/^c1\.[0-9a-f]{32}$/);
    expect((snap.entities as Entity[]).map((x) => x.urn)).toEqual([
      'urn:apps.civitai.com:app/alpha-app',
      'urn:apps.civitai.com:app/beta-app',
      'urn:apps.civitai.com:app/gamma-app',
    ]);

    // The first process is gone; only the store remains.
    const second = harness(store, [V2]);
    const changes = await second.drain(APPS, snap.cursor);
    expect(changes.map(shape)).toEqual([
      ['delete', 'urn:apps.civitai.com:app/beta-app'],
      ['upsert', 'urn:apps.civitai.com:app/alpha-app', 'r-a2'],
      ['upsert', 'urn:apps.civitai.com:app/delta-app', 'r-d1'],
    ]);
    expect(second.polls()).toBe(3);
  });

  it('only the last change of a batch moves the cursor, and resuming mid-batch loses nothing', async () => {
    const store = createMemorySnapshotStore();
    const a = harness(store, [V1]);
    const { cursor } = await a.adapter.snapshot(APPS, { signal: a.signal });
    const changes = await harness(store, [V2]).drain(APPS, cursor);
    expect(changes.map((c) => c.cursor === cursor)).toEqual([true, true, false]);

    // Resume from the cursor of the FIRST change: everything after it still arrives.
    const again = await harness(store, [V2]).drain(APPS, changes[0].cursor);
    expect(again.map(shape)).toEqual(changes.map(shape));
    // Resume from the last: nothing is left.
    expect(await harness(store, [V2]).drain(APPS, changes[2].cursor)).toEqual([]);
  });

  it('🔴 an app that leaves the catalog with no trace arrives as a delete', async () => {
    const store = createMemorySnapshotStore();
    const a = harness(store, [V1]);
    const { cursor } = await a.adapter.snapshot(APPS, { signal: a.signal });
    const changes = await harness(store, [[]]).drain(APPS, cursor);
    expect(changes.map(shape)).toEqual([
      ['delete', 'urn:apps.civitai.com:app/alpha-app'],
      ['delete', 'urn:apps.civitai.com:app/beta-app'],
      ['delete', 'urn:apps.civitai.com:app/gamma-app'],
    ]);
  });

  it('a change made while subscribed arrives on a later poll', async () => {
    const store = createMemorySnapshotStore();
    const h = harness(store, [V1, V1, V2], 4);
    const { cursor } = await h.adapter.snapshot(APPS, { signal: h.signal });
    const changes = await h.drain(APPS, cursor);
    expect(changes.map(shape)).toEqual([
      ['delete', 'urn:apps.civitai.com:app/beta-app'],
      ['upsert', 'urn:apps.civitai.com:app/alpha-app', 'r-a2'],
      ['upsert', 'urn:apps.civitai.com:app/delta-app', 'r-d1'],
    ]);
  });

  it('nothing changed: no events', async () => {
    const store = createMemorySnapshotStore();
    const h = harness(store, [V1]);
    const { cursor } = await h.adapter.snapshot(APPS, { signal: h.signal });
    expect(await harness(store, [V1]).drain(APPS, cursor)).toEqual([]);
  });

  it('🔴 cursor_expired for a cursor whose snapshot is no longer held', async () => {
    const store = createMemorySnapshotStore();
    const h = harness(store, [V1]);
    const { cursor } = await h.adapter.snapshot(APPS, { signal: h.signal });
    store.clear();
    expect(await codeOf(harness(store, [V1]).drain(APPS, cursor))).toBe('cursor_expired');
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['the wrong format version', `c0.${'a'.repeat(32)}`],
    ['an unknown digest', `c1.${'b'.repeat(32)}`],
  ])('cursor_expired for %s', async (_name, cursor) => {
    expect(await codeOf(harness(createMemorySnapshotStore(), [V1]).drain(APPS, cursor))).toBe(
      'cursor_expired'
    );
  });

  it('cursor_expired for a cursor of another schema', async () => {
    const store = createMemorySnapshotStore();
    const h = harness(store, [V1]);
    const { cursor } = await h.adapter.snapshot(RELEASES, { signal: h.signal });
    expect(await codeOf(harness(store, [V1]).drain(APPS, cursor))).toBe('cursor_expired');
  });

  it('a failed catalog read is `unavailable` and names nothing', async () => {
    const adapter = createPollingAdapter({
      namespace: 'apps.civitai.com',
      serves: [APPS],
      read: async () => {
        throw new Error('connect ECONNREFUSED db-host-canary-58:5432');
      },
      store: createMemorySnapshotStore(),
      pollMs: 1,
      sleep: async () => undefined,
    });
    const err = await adapter
      .snapshot(APPS, { signal: new AbortController().signal })
      .catch((x) => x);
    expect(err).toBeInstanceOf(ProtocolError);
    expect([err.code, err.message]).toEqual(['unavailable', 'the catalog could not be read']);
  });

  it('a duplicate URN is served once, first wins', async () => {
    const h = harness(createMemorySnapshotStore(), [
      [e('alpha-app', 'r-first'), e('alpha-app', 'r-second')],
    ]);
    const snap = await h.adapter.snapshot(APPS, { signal: h.signal });
    expect((snap.entities as Entity[]).map((x) => x.rev)).toEqual(['r-first']);
  });

  it('the same served set always names the same cursor', async () => {
    const store = createMemorySnapshotStore();
    const a = await harness(store, [V1]).adapter.snapshot(APPS, {
      signal: new AbortController().signal,
    });
    const b = await harness(store, [[...V1].reverse()]).adapter.snapshot(APPS, {
      signal: new AbortController().signal,
    });
    expect(a.cursor).toBe(b.cursor);
    expect(store.size()).toBe(1);
  });
});

describe('states kept per stream', () => {
  it('the newest digest goes first, and what falls past the bound is evicted', () => {
    expect(retainLatest(['d2', 'd1'], 'd3', 2)).toEqual({ list: ['d3', 'd2'], evicted: ['d1'] });
    expect(retainLatest(['d2', 'd1'], 'd1', 2)).toEqual({ list: ['d1', 'd2'], evicted: [] });
    expect(retainLatest([], 'd1', 2)).toEqual({ list: ['d1'], evicted: [] });
  });

  it('🔴 a cursor older than the bound answers cursor_expired; the newest still resumes', async () => {
    const store = createMemorySnapshotStore(2);
    const s1 = [e('alpha-app', 'r-1')];
    const s2 = [e('alpha-app', 'r-2')];
    const s3 = [e('alpha-app', 'r-3')];
    const h = harness(store, [s1, s2, s3]);
    const { cursor: first } = await h.adapter.snapshot(APPS, { signal: h.signal });
    const changes = await h.drain(APPS, first);
    expect(changes.map(shape)).toEqual([
      ['upsert', 'urn:apps.civitai.com:app/alpha-app', 'r-2'],
      ['upsert', 'urn:apps.civitai.com:app/alpha-app', 'r-3'],
    ]);
    expect(await codeOf(harness(store, [s3]).drain(APPS, first))).toBe('cursor_expired');
    expect(await harness(store, [s3]).drain(APPS, changes[1].cursor)).toEqual([]);
  });
});

describe('sharedRead', () => {
  it('shares one read within the window, reads again after it, and forgets a failure', async () => {
    let t = 1000;
    let calls = 0;
    let fail = false;
    const read = sharedRead(
      async () => {
        calls++;
        if (fail) throw new Error('read failed');
        return calls;
      },
      50,
      () => t
    );
    expect([await read(), await read()]).toEqual([1, 1]);
    t += 60;
    expect(await read()).toBe(2);
    t += 60;
    fail = true;
    await expect(read()).rejects.toThrow('read failed');
    fail = false;
    expect(await read()).toBe(4);
  });
});

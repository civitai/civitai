import { describe, expect, it } from 'vitest';
import type { SnapshotStore } from '~/server/registry-adapter/cursor';
import { createPollingAdapter, sharedRead } from '~/server/registry-adapter/cursor';
import type { Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';

const APPS = 'urn:schema:civitai-schemas:app@v1';
const RELEASES = 'urn:schema:civitai-schemas:app-release@v1';

const e = (slug: string, rev: string): Entity => ({
  urn: `urn:civitai-apps:app/${slug}`,
  schemas: [APPS],
  rev,
  body: { slug, rev },
});

function memoryStore(): SnapshotStore & { size: () => number; clear: () => void } {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    size: () => m.size,
    clear: () => m.clear(),
  };
}

/**
 * An adapter over a scripted catalog. `states` is read in order, one per poll, the last one
 * repeating. Its sleep stops the subscription after `maxPolls` polls, so `changes` always ends.
 */
function harness(store: SnapshotStore, states: Entity[][], maxPolls = 3) {
  let reads = 0;
  let polls = 0;
  const abort = new AbortController();
  const adapter = createPollingAdapter({
    namespace: 'civitai-apps',
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
    const out: Change[] = [];
    for await (const c of adapter.changes(schema, cursor, { signal: abort.signal })) out.push(c);
    return out;
  };
  return { adapter, drain, signal: abort.signal, polls: () => polls };
}

const shape = (c: Change) =>
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
    const store = memoryStore();
    const first = harness(store, [V1]);
    const snap = await first.adapter.snapshot(APPS, { signal: first.signal });
    expect(snap.cursor).toMatch(/^c1\.[0-9a-f]{32}$/);
    expect((snap.entities as Entity[]).map((x) => x.urn)).toEqual([
      'urn:civitai-apps:app/alpha-app',
      'urn:civitai-apps:app/beta-app',
      'urn:civitai-apps:app/gamma-app',
    ]);

    // The first process is gone; only the store remains.
    const second = harness(store, [V2]);
    const changes = await second.drain(APPS, snap.cursor);
    expect(changes.map(shape)).toEqual([
      ['delete', 'urn:civitai-apps:app/beta-app'],
      ['upsert', 'urn:civitai-apps:app/alpha-app', 'r-a2'],
      ['upsert', 'urn:civitai-apps:app/delta-app', 'r-d1'],
    ]);
    expect(second.polls()).toBe(3);
  });

  it('only the last change of a batch moves the cursor, and resuming mid-batch loses nothing', async () => {
    const store = memoryStore();
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
    const store = memoryStore();
    const a = harness(store, [V1]);
    const { cursor } = await a.adapter.snapshot(APPS, { signal: a.signal });
    const changes = await harness(store, [[]]).drain(APPS, cursor);
    expect(changes.map(shape)).toEqual([
      ['delete', 'urn:civitai-apps:app/alpha-app'],
      ['delete', 'urn:civitai-apps:app/beta-app'],
      ['delete', 'urn:civitai-apps:app/gamma-app'],
    ]);
  });

  it('a change made while subscribed arrives on a later poll', async () => {
    const store = memoryStore();
    const h = harness(store, [V1, V1, V2], 4);
    const { cursor } = await h.adapter.snapshot(APPS, { signal: h.signal });
    const changes = await h.drain(APPS, cursor);
    expect(changes.map(shape)).toEqual([
      ['delete', 'urn:civitai-apps:app/beta-app'],
      ['upsert', 'urn:civitai-apps:app/alpha-app', 'r-a2'],
      ['upsert', 'urn:civitai-apps:app/delta-app', 'r-d1'],
    ]);
  });

  it('nothing changed: no events', async () => {
    const store = memoryStore();
    const h = harness(store, [V1]);
    const { cursor } = await h.adapter.snapshot(APPS, { signal: h.signal });
    expect(await harness(store, [V1]).drain(APPS, cursor)).toEqual([]);
  });

  it('🔴 cursor_expired for a cursor whose snapshot is no longer held', async () => {
    const store = memoryStore();
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
    expect(await codeOf(harness(memoryStore(), [V1]).drain(APPS, cursor))).toBe('cursor_expired');
  });

  it('cursor_expired for a cursor of another schema', async () => {
    const store = memoryStore();
    const h = harness(store, [V1]);
    const { cursor } = await h.adapter.snapshot(RELEASES, { signal: h.signal });
    expect(await codeOf(harness(store, [V1]).drain(APPS, cursor))).toBe('cursor_expired');
  });

  it('a failed catalog read is `unavailable` and names nothing', async () => {
    const adapter = createPollingAdapter({
      namespace: 'civitai-apps',
      serves: [APPS],
      read: async () => {
        throw new Error('connect ECONNREFUSED db-host-canary-58:5432');
      },
      store: memoryStore(),
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
    const h = harness(memoryStore(), [[e('alpha-app', 'r-first'), e('alpha-app', 'r-second')]]);
    const snap = await h.adapter.snapshot(APPS, { signal: h.signal });
    expect((snap.entities as Entity[]).map((x) => x.rev)).toEqual(['r-first']);
  });

  it('the same served set always names the same cursor', async () => {
    const store = memoryStore();
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

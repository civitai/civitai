import { describe, expect, it } from 'vitest';
import type { CollectionStream } from '~/server/registry-adapter/doc-feed';
import type { DocFeedOptions } from '~/server/registry-adapter/doc-feed';
import { EMPTY_CURSOR, PROGRESS_EVERY_MS, createDocFeed } from '~/server/registry-adapter/doc-feed';
import type { FixtureCatalog } from '../../../../scripts/registry-adapter-fixture/fixture-source';
import {
  createMemorySnapshotStore,
  fixtureDocSource,
} from '../../../../scripts/registry-adapter-fixture/fixture-source';
import type { Change, Entity } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';

const V1 = 'urn:schema:apps.civitai.com:orbit-notes/notes@v1';
const V2 = 'urn:schema:apps.civitai.com:orbit-notes/notes@v2';
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
const title = (maxLength: number) => ({
  type: 'object',
  properties: { title: { type: 'string', maxLength } },
});
const ONE_MAJOR: CollectionStream['family'] = [
  { urn: V1, body: { ...title(10), $schema: DIALECT, $id: V1 } },
];
const TWO_MAJORS: CollectionStream['family'] = [
  { urn: V1, body: { ...title(10), $schema: DIALECT, $id: V1 } },
  {
    urn: V2,
    body: { ...title(100), $schema: DIALECT, $id: V2, 'x-migrateFrom': { schema: V1, steps: [] } },
  },
];

const urn = (key: string) => `urn:apps.civitai.com:orbit-notes/notes/${key}`;
const doc = (key: string, t: string, seq: number, extra: Record<string, unknown> = {}) => ({
  appId: 'ab_orbit_7',
  ns: 'prod',
  coll: 'notes',
  scopeUid: 0,
  key,
  data: { title: t },
  version: 1,
  seq,
  ...extra,
});

/**
 * A feed over a catalog the test edits between polls. `world.stream` is what the resolver
 * answers (null: not published); `edits[i]` runs before poll i+1 of `changes`. The sleep stops
 * the subscription after `edits.length + 1` polls, so every drain ends on its own.
 */
function setup(store = createMemorySnapshotStore()) {
  const world: { cat: FixtureCatalog; stream: CollectionStream | null } = {
    cat: {
      listings: [],
      documents: [doc('n1', 'short', 3), doc('n2', 'a much longer title', 5)],
      tombstones: [],
      lastSeq: { ab_orbit_7: 5 },
    },
    stream: {
      appId: 'ab_orbit_7',
      slug: 'orbit-notes',
      collection: 'notes',
      contentRating: 'pg',
      family: TWO_MAJORS,
    },
  };
  const make = (edits: Array<() => void> = [], over: Partial<DocFeedOptions> = {}) => {
    let polls = 0;
    const abort = new AbortController();
    const feed = createDocFeed({
      source: fixtureDocSource(() => world.cat),
      resolve: async () => world.stream,
      store,
      pollMs: 1,
      sleep: async () => {
        if (polls >= edits.length) abort.abort();
        else edits[polls]();
        polls++;
      },
      ...over,
    });
    const drain = async (schema: string, cursor: string) => {
      const out: Change[] = [];
      for await (const c of await feed.changes(schema, cursor, { signal: abort.signal }))
        out.push(c);
      return out;
    };
    return { feed, drain, signal: abort.signal };
  };
  return { world, store, make };
}

const shape = (c: Change) =>
  'upsert' in c ? ['upsert', c.upsert.urn] : 'delete' in c ? ['delete', c.delete] : ['progress'];
async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof ProtocolError ? `${err.code}: ${err.message}` : `other: ${String(err)}`;
  }
}

describe('multi-major claims', () => {
  it('🔴 a document claims every major it satisfies, and a major streams only those', async () => {
    const { make } = setup();
    const v1 = await make().feed.snapshot(V1);
    const v2 = await make().feed.snapshot(V2);
    expect(v1.entities.map((e) => [e.urn, e.schemas])).toEqual([[urn('n1'), [V1, V2]]]);
    expect(v2.entities.map((e) => [e.urn, e.schemas])).toEqual([
      [urn('n1'), [V1, V2]],
      [urn('n2'), [V2]],
    ]);
    expect((v2.entities as Entity[])[1].body).toEqual({ title: 'a much longer title' });
  });

  it('🔴 a mint brings unchanged documents into the new major, with no write', async () => {
    const { world, make } = setup();
    world.stream!.family = ONE_MAJOR;
    const h = make([() => (world.stream!.family = TWO_MAJORS)]);
    const before = await h.feed.snapshot(V2);
    expect(before.entities).toEqual([]);
    expect((await h.drain(V2, before.cursor)).map(shape)).toEqual([
      ['upsert', urn('n1')],
      ['upsert', urn('n2')],
    ]);
  });
});

describe('the cursor', () => {
  it('🔴 is opaque: a fixed-size digest whatever it names, never the seq', async () => {
    // A seq long enough that neither its decimal nor its hex form turns up in a 32-hex digest
    // by chance.
    const SEQ = 987_654_321;
    const { world, make } = setup();
    const small = await make().feed.snapshot(V2);
    world.cat.documents!.push(doc('n3', 'third', SEQ));
    world.cat.lastSeq = { ab_orbit_7: SEQ };
    const large = await make().feed.snapshot(V2);
    // The same seq, different content: a different cursor, so the cursor is not the seq.
    world.cat.documents![2] = doc('n3', 'third, edited', SEQ, { version: 2 });
    const edited = await make().feed.snapshot(V2);
    for (const c of [small.cursor, large.cursor, edited.cursor]) {
      expect(c).toMatch(/^f1\.[0-9a-f]{32}$/);
      expect(c).not.toContain(String(SEQ));
      expect(c).not.toContain(SEQ.toString(16));
    }
    expect(new Set([small.cursor, large.cursor, edited.cursor]).size).toBe(3);
  });

  it('round trip: a new process resumes it, and only what changed since arrives', async () => {
    const { world, store, make } = setup();
    const { cursor } = await make().feed.snapshot(V2);
    expect(await setup(store).make().drain(V2, cursor)).toEqual([]);
    world.cat.documents![0] = doc('n1', 'short, edited', 6, { version: 2 });
    world.cat.lastSeq = { ab_orbit_7: 6 };
    const resumed = setup(store);
    resumed.world.cat = world.cat;
    expect((await resumed.make().drain(V2, cursor)).map(shape)).toEqual([['upsert', urn('n1')]]);
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['an entity cursor', `c1.${'a'.repeat(32)}`],
    ['an unknown digest', `f1.${'b'.repeat(32)}`],
  ])('cursor_expired for %s', async (_name, cursor) => {
    expect(await codeOf(setup().make().drain(V2, cursor))).toMatch(/^cursor_expired/);
  });

  it('cursor_expired for a cursor of another stream', async () => {
    const { make } = setup();
    const { cursor } = await make().feed.snapshot(V1);
    expect(await codeOf(make().drain(V2, cursor))).toMatch(
      /^cursor_expired: the cursor belongs to another stream/
    );
  });
});

describe('cursor_expired on a history it cannot trust', () => {
  it('🔴 the namespace seq went back (reset)', async () => {
    const { world, make } = setup();
    const { cursor } = await make().feed.snapshot(V2);
    world.cat.lastSeq = { ab_orbit_7: 2 };
    expect(await codeOf(make().drain(V2, cursor))).toBe(
      'cursor_expired: the namespace seq went back'
    );
  });

  it('🔴 a purge written over past the old seq: the witness is gone without a tombstone', async () => {
    const { world, make } = setup();
    const { cursor } = await make().feed.snapshot(V2);
    world.cat.documents = [doc('z9', 'after the purge', 40)];
    world.cat.lastSeq = { ab_orbit_7: 40 };
    expect(await codeOf(make().drain(V2, cursor))).toBe(
      'cursor_expired: a document this cursor served is gone without a trace'
    );
  });

  it('positive control: the same document deleted WITH a tombstone is an ordinary delete', async () => {
    const { world, make } = setup();
    const { cursor } = await make().feed.snapshot(V2);
    world.cat.documents = [doc('n1', 'short', 3)];
    world.cat.tombstones = [
      { appId: 'ab_orbit_7', ns: 'prod', coll: 'notes', scopeUid: 0, key: 'n2', seq: 9 },
    ];
    world.cat.lastSeq = { ab_orbit_7: 9 };
    expect((await make().drain(V2, cursor)).map(shape)).toEqual([['delete', urn('n2')]]);
  });

  it('🔴 the slug now names a different app (re-created)', async () => {
    const { world, make } = setup();
    const { cursor } = await make().feed.snapshot(V2);
    world.stream = { ...world.stream!, appId: 'ab_orbit_8' };
    expect(await codeOf(make().drain(V2, cursor))).toBe(
      'cursor_expired: the collection now belongs to a different app'
    );
  });
});

describe('deletes', () => {
  it('🔴 a hidden document arrives as a delete', async () => {
    const { world, make } = setup();
    const h = make([
      () => {
        world.cat.documents![0] = doc('n1', 'short', 3, { hidden: true });
        world.cat.tombstones = [
          { appId: 'ab_orbit_7', ns: 'prod', coll: 'notes', scopeUid: 0, key: 'n1', seq: 6 },
        ];
        world.cat.lastSeq = { ab_orbit_7: 6 };
      },
    ]);
    const { cursor } = await h.feed.snapshot(V2);
    expect((await h.drain(V2, cursor)).map(shape)).toEqual([['delete', urn('n1')]]);
  });

  it('🔴 an app that leaves the published set: a delete for everything served, no tombstone needed', async () => {
    const { world, make } = setup();
    const h = make([
      () => {
        world.stream = null;
        world.cat.documents = [];
      },
    ]);
    const { cursor } = await h.feed.snapshot(V2);
    expect((await h.drain(V2, cursor)).map(shape)).toEqual([
      ['delete', urn('n1')],
      ['delete', urn('n2')],
    ]);
  });

  it('a collection that is not published streams nothing', async () => {
    const { world, make } = setup();
    world.stream = null;
    expect((await make().feed.snapshot(V2)).entities).toEqual([]);
  });
});

describe('🔴 an unpublished stream writes nothing to the store', () => {
  it('a snapshot of a collection URN that resolves to nothing gets a constant cursor and no write', async () => {
    const { world, store, make } = setup();
    world.stream = null;
    const snap = await make().feed.snapshot('urn:schema:apps.civitai.com:no-such-app/invented@v1');
    expect([snap.cursor, store.puts()]).toEqual([EMPTY_CURSOR, 0]);
  });

  it('positive control: a published stream does write its state', async () => {
    const { store, make } = setup();
    await make().feed.snapshot(V2);
    expect(store.puts()).toBe(1);
  });

  it('the deletes of an app that leaves end on the constant cursor, with no state written for them', async () => {
    const { world, store, make } = setup();
    const h = make([() => (world.stream = null)]);
    const { cursor } = await h.feed.snapshot(V2);
    const before = store.puts();
    const changes = await h.drain(V2, cursor);
    expect(changes.map(shape)).toEqual([
      ['delete', urn('n1')],
      ['delete', urn('n2')],
    ]);
    expect((changes[1] as { cursor: string }).cursor).toBe(EMPTY_CURSOR);
    // The resume only refreshes the state it read (a touch); nothing is written.
    expect([store.puts() - before, store.touches()]).toEqual([0, 1]);
  });

  it('a stream resumed from the constant cursor picks up a collection published since', async () => {
    const { world, make } = setup();
    const published = world.stream;
    world.stream = null;
    const h = make([() => (world.stream = published)]);
    expect((await h.drain(V2, EMPTY_CURSOR)).map(shape)).toEqual([
      ['upsert', urn('n1')],
      ['upsert', urn('n2')],
    ]);
  });
});

describe('🔴 an empty published stream reads incrementally', () => {
  it('reads the whole collection once, then only what changed — and still sees a new document', async () => {
    const cat: FixtureCatalog = {
      listings: [],
      documents: [doc('n2', 'a much longer title', 5)],
      lastSeq: { ab_orbit_7: 5 },
    };
    const base = fixtureDocSource(() => cat);
    let fullReads = 0;
    let polls = 0;
    const abort = new AbortController();
    const edits = [
      () => undefined,
      () => {
        cat.documents!.push(doc('n7', 'short', 6));
        cat.lastSeq = { ab_orbit_7: 6 };
      },
    ];
    const feed = createDocFeed({
      source: {
        ...base,
        documents: (...args) => {
          fullReads++;
          return base.documents(...args);
        },
      },
      resolve: async () => ({
        appId: 'ab_orbit_7',
        slug: 'orbit-notes',
        collection: 'notes',
        contentRating: 'pg',
        family: TWO_MAJORS,
      }),
      store: createMemorySnapshotStore(),
      pollMs: 1,
      sleep: async () => {
        if (polls >= edits.length) abort.abort();
        else edits[polls]();
        polls++;
      },
    });
    // `n2` does not fit @v1, so the @v1 stream serves nothing.
    const snap = await feed.snapshot(V1);
    expect([snap.entities, fullReads]).toEqual([[], 1]);
    const out: Change[] = [];
    for await (const c of await feed.changes(V1, snap.cursor, { signal: abort.signal }))
      out.push(c);
    expect(out.map(shape)).toEqual([['upsert', urn('n7')]]);
    expect(fullReads).toBe(1);
  });
});

describe('a poll with nothing new', () => {
  // Invariant guard: true before the unchanged-state shortcut too; it pins that the shortcut
  // keeps it so.
  it('writes no state, and reads no documents or changes', async () => {
    const cat: FixtureCatalog = {
      listings: [],
      documents: [doc('n1', 'short', 3), doc('n2', 'a much longer title', 5)],
      lastSeq: { ab_orbit_7: 5 },
    };
    const base = fixtureDocSource(() => cat);
    const reads = { documents: 0, changes: 0 };
    let polls = 0;
    const abort = new AbortController();
    const store = createMemorySnapshotStore();
    const feed = createDocFeed({
      source: {
        ...base,
        documents: (...args) => {
          reads.documents++;
          return base.documents(...args);
        },
        changes: (...args) => {
          reads.changes++;
          return base.changes(...args);
        },
      },
      resolve: async () => ({
        appId: 'ab_orbit_7',
        slug: 'orbit-notes',
        collection: 'notes',
        contentRating: 'pg',
        family: TWO_MAJORS,
      }),
      store,
      pollMs: 1,
      sleep: async () => {
        if (++polls >= 4) abort.abort();
      },
    });
    const { cursor } = await feed.snapshot(V2);
    const after = { puts: store.puts(), reads: { ...reads } };
    const out: Change[] = [];
    for await (const c of await feed.changes(V2, cursor, { signal: abort.signal })) out.push(c);
    expect(out).toEqual([]);
    expect(polls).toBe(4);
    expect([store.puts() - after.puts, reads]).toEqual([0, after.reads]);
  });
});

describe('🔴 a mint re-sends documents whose claims grew, on the old major too', () => {
  it('the @v1 stream re-sends a document that now also claims @v2, with the same rev @v2 shows', async () => {
    const { world, make } = setup();
    world.stream!.family = ONE_MAJOR;
    const h = make([() => (world.stream!.family = TWO_MAJORS)]);
    const before = await h.feed.snapshot(V1);
    expect(before.entities.map((e) => [e.urn, e.schemas])).toEqual([[urn('n1'), [V1]]]);
    const changes = await h.drain(V1, before.cursor);
    expect(changes.map(shape)).toEqual([['upsert', urn('n1')]]);
    const resent = (changes[0] as { upsert: Entity }).upsert;
    expect(resent.schemas).toEqual([V1, V2]);
    const onV2 = (await make().feed.snapshot(V2)).entities.find((e) => e.urn === urn('n1'))!;
    expect([onV2.rev, onV2.schemas]).toEqual([resent.rev, resent.schemas]);
  });
});

describe('🔴 progress: the namespace seq moves with no change for this stream', () => {
  // A write this stream does not carry: a private document (another key space) bumps the
  // namespace's seq, and the shared feed sees nothing of it but the head.
  const privateWrite = (world: { cat: FixtureCatalog }, seq: number) => {
    world.cat.documents!.push(doc(`p${seq}`, 'private', seq, { scopeUid: 42 }));
    world.cat.lastSeq = { ab_orbit_7: seq };
  };
  /** `n` private writes one second apart, then one more a whole interval later. */
  const burst = (world: { cat: FixtureCatalog }, clock: { t: number }, n: number) => [
    ...Array.from({ length: n }, (_, i) => () => {
      clock.t += 1000;
      privateWrite(world, 6 + i);
    }),
    () => {
      clock.t += PROGRESS_EVERY_MS;
      privateWrite(world, 6 + n);
    },
  ];

  it('a burst of private writes saves one state per interval, and progress only for it', async () => {
    const { world, store, make } = setup();
    const clock = { t: 0 };
    const h = make(burst(world, clock, 20), { now: () => clock.t });
    const { cursor } = await h.feed.snapshot(V2);
    const before = store.puts();
    const changes = await h.drain(V2, cursor);
    expect(changes.map(shape)).toEqual([['progress']]);
    expect([store.puts() - before, store.size()]).toEqual([1, 2]);
  });

  it('within the interval a disconnected consumer keeps its cursor, however many moves', async () => {
    // Two states kept per stream: saving each move would evict the snapshot's at the second.
    const store = createMemorySnapshotStore(2);
    const { world, make } = setup(store);
    const clock = { t: 0 };
    const h = make(burst(world, clock, 10).slice(0, 10), { now: () => clock.t });
    const { cursor } = await h.feed.snapshot(V2);
    expect(await h.drain(V2, cursor)).toEqual([]);
    world.cat.documents![0] = doc('n1', 'short, edited', 30, { version: 2 });
    world.cat.lastSeq = { ab_orbit_7: 30 };
    const resumed = setup(store);
    resumed.world.cat = world.cat;
    expect((await resumed.make().drain(V2, cursor)).map(shape)).toEqual([['upsert', urn('n1')]]);
  });

  it('a progress cursor is a saved state: it resumes with only what changed after it', async () => {
    const { world, store, make } = setup();
    const clock = { t: 0 };
    const h = make(burst(world, clock, 0), { now: () => clock.t });
    const { cursor } = await h.feed.snapshot(V2);
    const [moved] = (await h.drain(V2, cursor)) as Array<{ progress: string }>;
    expect(moved.progress).not.toBe(cursor);
    world.cat.documents![0] = doc('n1', 'short, edited', 8, { version: 2 });
    world.cat.lastSeq = { ab_orbit_7: 8 };
    const resumed = setup(store);
    resumed.world.cat = world.cat;
    expect((await resumed.make().drain(V2, moved.progress)).map(shape)).toEqual([
      ['upsert', urn('n1')],
    ]);
  });
});

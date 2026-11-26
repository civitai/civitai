import { describe, expect, it } from 'vitest';
import type { Audience } from '~/server/registry-adapter/audience';
import type { CollectionStream, SharedDocSource } from '~/server/registry-adapter/doc-feed';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import type { Change } from '~/server/registry-adapter/protocol';
import {
  createMemorySnapshotStore,
  fixtureDocSource,
} from '../../../../scripts/registry-adapter-fixture/fixture-source';
import type { FixtureCatalog } from '../../../../scripts/registry-adapter-fixture/fixture-source';

/**
 * Content levels in the registry document feed (`doc-feed.ts`, `doc-levels.ts`): with
 * `docLevels` on the stream, the feed asks its source for each read at the subscription
 * audience's level, and a flip of the setting is read in full so what was sent is corrected.
 * The source here is the fixture source with the store's gate applied on top: a document whose
 * level bit is not in the level asked for is hidden. Literal levels: PG 1, PG-13 2, R 4, X 8.
 */

const V1 = 'urn:schema:apps.civitai.com:orbit-notes/notes@v1';
const urn = (key: string) => `urn:apps.civitai.com:orbit-notes/notes/${key}`;
const doc = (key: string, seq: number) => ({
  appId: 'ab_orbit_9',
  ns: 'prod',
  coll: 'notes',
  scopeUid: 0,
  key,
  data: { title: key },
  version: 1,
  seq,
});
/** Each document's level, as the store would hold it once rated. */
const LEVEL: Record<string, number> = { pg13: 2, x: 8 };

const SFW: Audience = { key: 'm', allowed: { r: false, x: false, xxx: false } };
const MATURE: Audience = { key: 'mrx', allowed: { r: true, x: true, xxx: false } };

function setup() {
  const cat: FixtureCatalog = {
    listings: [],
    documents: [doc('pg13', 3), doc('x', 5)],
    tombstones: [],
    lastSeq: { ab_orbit_9: 5 },
  };
  const calls: Array<{ read: string; level: number | undefined; args: number }> = [];
  const base = fixtureDocSource(() => cat);
  const admits = (key: string, level: number | undefined) =>
    level === undefined || (LEVEL[key] & level) !== 0;
  const source: SharedDocSource = {
    head: base.head,
    witness: base.witness,
    changes: async (...args: Parameters<SharedDocSource['changes']>) => {
      const level = args[5];
      calls.push({ read: 'changes', level, args: args.length });
      const page = await base.changes(args[0], args[1], args[2], args[3], args[4]);
      return {
        ...page,
        docs: page.docs.map((d) => ({ ...d, hidden: d.hidden || !admits(d.key, level) })),
      };
    },
    documents: async (...args: Parameters<SharedDocSource['documents']>) => {
      const level = args[5];
      calls.push({ read: 'documents', level, args: args.length });
      const page = await base.documents(args[0], args[1], args[2], args[3], args[4]);
      return page.filter((d) => admits(d.key, level));
    },
  };
  const world: { stream: CollectionStream } = {
    stream: {
      appId: 'ab_orbit_9',
      slug: 'orbit-notes',
      collection: 'notes',
      contentRating: 'pg',
      family: [{ urn: V1, body: { type: 'object' } }],
    },
  };
  const store = createMemorySnapshotStore();
  const make = (edits: Array<() => void> = []) => {
    let polls = 0;
    const abort = new AbortController();
    const feed = createDocFeed({
      source,
      resolve: async () => world.stream,
      store,
      pollMs: 1,
      sleep: async () => {
        if (polls >= edits.length) abort.abort();
        else edits[polls]();
        polls++;
      },
    });
    const drain = async (cursor: string, audience: Audience) => {
      const out: Change[] = [];
      for await (const c of await feed.changes(V1, cursor, { signal: abort.signal, audience }))
        out.push(c);
      return out;
    };
    return { feed, drain };
  };
  return { world, calls, make };
}

const keysOf = (entities: Array<{ urn: string }>) => entities.map((e) => e.urn).sort();

describe('registry feed: content levels', () => {
  it('🔴 on: the source is read at the audience’s level, so a document above it is not sent', async () => {
    const { world, calls, make } = setup();
    world.stream.docLevels = true;
    const sfw = await make().feed.snapshot(V1, { audience: SFW });
    expect(keysOf(sfw.entities)).toEqual([urn('pg13')]);
    const mature = await make().feed.snapshot(V1, { audience: MATURE });
    expect(keysOf(mature.entities)).toEqual([urn('pg13'), urn('x')]);
    expect(calls.map((c) => c.level)).toEqual([3, 15]);
  });

  it('INVARIANT GUARD: off, the source is read exactly as before (no level argument) and everything is sent', async () => {
    const { calls, make } = setup();
    const snap = await make().feed.snapshot(V1, { audience: SFW });
    expect(keysOf(snap.entities)).toEqual([urn('pg13'), urn('x')]);
    expect(calls).toEqual([{ read: 'documents', level: undefined, args: 5 }]);
  });

  it('🔴 a flip to on, with nothing written since, is read in full: what is now above the level is deleted', async () => {
    const { world, make } = setup();
    const first = await make().feed.snapshot(V1, { audience: SFW });
    const changes = await make([() => (world.stream.docLevels = true)]).drain(first.cursor, SFW);
    expect(
      changes.filter((c) => 'delete' in c).map((c) => ('delete' in c ? c.delete : ''))
    ).toEqual([urn('x')]);
  });
});

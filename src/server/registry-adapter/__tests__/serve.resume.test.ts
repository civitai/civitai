import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPollingAdapter } from '~/server/registry-adapter/cursor';
import { abortableSleep } from '~/utils/errorHandling';
import type { CollectionStream } from '~/server/registry-adapter/doc-feed';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { composeAdapter } from '~/server/registry-adapter/doc-streams';
import type { Adapter, Entity } from '~/server/registry-adapter/protocol';
import { createRegistryServer } from '~/server/registry-adapter/serve';
import { bindCursor, requestBinding } from '~/server/registry-adapter/subscription';
import type { FixtureCatalog } from '../../../../scripts/registry-adapter-fixture/fixture-source';
import {
  createMemorySnapshotStore,
  fixtureDocSource,
} from '../../../../scripts/registry-adapter-fixture/fixture-source';

/**
 * A resume (`cursor=` set) over the real cursor stores: the cursor is checked before `live`, so a
 * cursor the source cannot resume from is answered `cursor_expired` and never preceded by `live`,
 * which tells a consumer it is complete.
 */

const APPS = 'urn:schema:apps.civitai.com:app@v1';
const NOTES = 'urn:schema:apps.civitai.com:orbit-notes/notes@v1';
const LIVE = 'event: live';

const app = (slug: string, rev: string): Entity => ({
  urn: `urn:apps.civitai.com:app/${slug}`,
  schemas: [APPS],
  rev,
  // A known rating, so anonymous is sent it (`audience.ts`).
  body: { slug, contentRating: 'g' },
});

let server: Server | undefined;
afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.closeAllConnections();
      server.close(() => resolve());
      server = undefined;
    })
);

/**
 * The response to `query`, read until `done(text)` holds, the response ends, or 5s pass. A live
 * stream never ends on its own, so the read stops at what the test is waiting for.
 */
async function subscribe(a: Adapter, query: string, done: (text: string) => boolean = () => false) {
  server = createRegistryServer(a);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5_000);
  let text = '';
  let status = 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${query}`, { signal: abort.signal });
    status = res.status;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (!done(text)) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return { status, text };
}

/**
 * A resume of `schema` from an ADAPTER's cursor, bound to the request as this source binds every
 * cursor it hands out, so the adapter's own check is what each case reaches.
 */
const issued = (schema: string, cursor: string) =>
  bindCursor(cursor, requestBinding({ schema, urns: [] }));
const sub = (schema: string, cursor: string) =>
  `/subscribe?schema=${encodeURIComponent(schema)}&cursor=${encodeURIComponent(
    issued(schema, cursor)
  )}`;

/** The catalog adapter over `states`, read in turn, the last one repeating. */
function catalog(store: ReturnType<typeof createMemorySnapshotStore>, states: Entity[][]) {
  let reads = 0;
  return createPollingAdapter({
    namespace: 'apps.civitai.com',
    serves: [APPS],
    read: async () => new Map([[APPS, states[Math.min(reads++, states.length - 1)]]]),
    store,
    pollMs: 5,
    sleep: abortableSleep,
  });
}

const expired = (res: { status: number; text: string }) => ({
  status: res.status,
  error: res.status === 410 ? (JSON.parse(res.text) as { error: string }).error : res.text,
  sawLive: res.text.includes(LIVE),
});

describe('🔴 a resume checks the cursor before live: the catalog streams', () => {
  it('a malformed cursor is cursor_expired, with no live before it', async () => {
    const res = await subscribe(
      catalog(createMemorySnapshotStore(), [[]]),
      `/subscribe?schema=${encodeURIComponent(APPS)}&cursor=nope`
    );
    expect(expired(res)).toEqual({ status: 410, error: 'cursor_expired', sawLive: false });
  });

  it('a cursor this source never issued is cursor_expired, with no live before it', async () => {
    const res = await subscribe(
      catalog(createMemorySnapshotStore(), [[]]),
      sub(APPS, `c1.${'0'.repeat(32)}`)
    );
    expect(expired(res)).toEqual({ status: 410, error: 'cursor_expired', sawLive: false });
  });

  it('an expired cursor (its state evicted) is cursor_expired, with no live before it', async () => {
    // One state kept per stream: the second snapshot evicts the first one's.
    const store = createMemorySnapshotStore(1);
    const signal = new AbortController().signal;
    const a = catalog(store, [[app('alpha', 'r1')], [app('alpha', 'r2')]]);
    const first = await a.snapshot(APPS, { signal });
    const second = await a.snapshot(APPS, { signal });
    expect(first.cursor).not.toBe(second.cursor);
    const res = await subscribe(a, sub(APPS, first.cursor));
    expect(expired(res)).toEqual({ status: 410, error: 'cursor_expired', sawLive: false });
  });

  // Invariant guard (true before the change too): a valid cursor still gets live, then changes.
  it('a valid cursor gets live with that cursor, then the changes since it', async () => {
    const store = createMemorySnapshotStore();
    const a = catalog(store, [[app('alpha', 'r1')], [app('beta', 'r1')]]);
    const { cursor } = await a.snapshot(APPS, { signal: new AbortController().signal });
    const res = await subscribe(a, sub(APPS, cursor), (t) => t.includes('event: upsert'));
    expect(res.status).toBe(200);
    const live = issued(APPS, cursor);
    expect(
      res.text.startsWith(`${LIVE}\nid: ${live}\ndata: ${JSON.stringify({ cursor: live })}\n\n`)
    ).toBe(true);
    const events = [...res.text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(events).toEqual(['live', 'delete', 'upsert']);
  });
});

describe('🔴 a resume checks the cursor before live: the document streams', () => {
  const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
  const family: CollectionStream['family'] = [
    { urn: NOTES, body: { $schema: DIALECT, $id: NOTES, type: 'object' } },
  ];
  const doc = (appId: string, key: string, seq: number) => ({
    appId,
    ns: 'prod',
    coll: 'notes',
    scopeUid: 0,
    key,
    data: { title: key },
    version: 1,
    seq,
  });

  function docs(
    world: { cat: FixtureCatalog; appId: string },
    store = createMemorySnapshotStore()
  ) {
    const feed = createDocFeed({
      source: fixtureDocSource(() => world.cat),
      resolve: async (schema) =>
        schema === NOTES
          ? {
              appId: world.appId,
              slug: 'orbit-notes',
              collection: 'notes',
              contentRating: 'pg',
              family,
            }
          : null,
      store,
      pollMs: 5,
      sleep: abortableSleep,
    });
    return composeAdapter(catalog(store, [[]]), feed);
  }

  const world = () => ({
    appId: 'ab_orbit_1',
    cat: {
      listings: [],
      documents: [doc('ab_orbit_1', 'n1', 3)],
      lastSeq: { ab_orbit_1: 3 },
    } as FixtureCatalog,
  });

  it('a cursor this source never issued is cursor_expired, with no live before it', async () => {
    const res = await subscribe(docs(world()), sub(NOTES, `f1.${'0'.repeat(32)}`));
    expect(expired(res)).toEqual({ status: 410, error: 'cursor_expired', sawLive: false });
  });

  it('a cursor whose collection now belongs to a re-created app is cursor_expired, with no live before it', async () => {
    const w = world();
    const store = createMemorySnapshotStore();
    const { cursor } = await docs(w, store).snapshot(NOTES, {
      signal: new AbortController().signal,
    });
    // The slug now names a different app: the history the cursor names cannot be trusted.
    w.appId = 'ab_orbit_2';
    w.cat = { listings: [], documents: [doc('ab_orbit_2', 'n1', 1)], lastSeq: { ab_orbit_2: 1 } };
    const res = await subscribe(docs(w, store), sub(NOTES, cursor));
    expect(expired(res)).toEqual({ status: 410, error: 'cursor_expired', sawLive: false });
  });

  // Invariant guard (true before the change too).
  it('a valid cursor gets live with that cursor, then the changes since it', async () => {
    const w = world();
    const store = createMemorySnapshotStore();
    const { cursor } = await docs(w, store).snapshot(NOTES, {
      signal: new AbortController().signal,
    });
    w.cat.documents!.push(doc('ab_orbit_1', 'n2', 4));
    w.cat.lastSeq = { ab_orbit_1: 4 };
    const res = await subscribe(docs(w, store), sub(NOTES, cursor), (t) =>
      t.includes('event: upsert')
    );
    expect(res.status).toBe(200);
    const live = issued(NOTES, cursor);
    expect(
      res.text.startsWith(`${LIVE}\nid: ${live}\ndata: ${JSON.stringify({ cursor: live })}\n\n`)
    ).toBe(true);
    expect(res.text).toContain('urn:apps.civitai.com:orbit-notes/notes/n2');
  });
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { abortableSleep, createPollingAdapter } from '~/server/registry-adapter/cursor';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { composeAdapter, resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { SERVED_SCHEMAS, buildEntities } from '~/server/registry-adapter/entities';
import type { Adapter, Entity } from '~/server/registry-adapter/protocol';
import { createRegistryServer } from '~/server/registry-adapter/serve';
import { REGISTRY_SCHEMA_SCHEMA, parseCollectionSchemaUrn } from '~/server/registry-adapter/urn';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';
import type { FixtureCatalog } from '../../../../scripts/registry-adapter-fixture/fixture-source';
import {
  createMemorySnapshotStore,
  fixtureDocSource,
} from '../../../../scripts/registry-adapter-fixture/fixture-source';

/**
 * The shared core of both bindings, driven through HTTP: `end` first for a schema not served,
 * the cursor tied to the request, and `progress`.
 */

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

/** The response, read until `done(text)` holds, the response ends, or 5s pass. */
async function subscribe(a: Adapter, query: string, done: (text: string) => boolean = () => false) {
  server?.closeAllConnections();
  server?.close();
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

const q = (schema: string, extra = '') => `/subscribe?schema=${encodeURIComponent(schema)}${extra}`;
const urnParam = (...urns: string[]) => urns.map((u) => `&urn=${encodeURIComponent(u)}`).join('');
const filterParam = (text: string) => `&filter=${encodeURIComponent(text)}`;
const cursorParam = (c: string) => `&cursor=${encodeURIComponent(c)}`;
/** The cursor an event of `type` carries; the SSE `id` line is the HTTP binding's, checked in `serve.test.ts`. */
const cursorOf = (text: string, type: string) =>
  (
    JSON.parse(new RegExp(`^event: ${type}\\n(?:id: .*\\n)?data: (.*)$`, 'm').exec(text)![1]) as {
      cursor: string;
    }
  ).cursor;
const liveCursor = (text: string) => cursorOf(text, 'live');
const events = (text: string) => [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
const END_ONLY = 'event: end\ndata: {}\n\n';

const notes = (maxLength: number, extra: Record<string, unknown> = {}) => ({
  visibility: 'shared',
  write: 'own',
  schema: { type: 'object', properties: { title: { type: 'string', maxLength } } },
  ...extra,
});
const manifest = (collections: Record<string, unknown>) => ({
  blockId: 'orbit-notes',
  storage: { collections },
});
const approved = (id: string, version: string, collections: Record<string, unknown>) => ({
  id,
  version,
  manifest: manifest(collections),
  bundleSha256: null,
  commitSha: null,
  sourceCommit: null,
  reviewedAt: null,
});

/** One listed, approved app whose `notes` is opted in. `head` is the enforced manifest's storage. */
function app(history: CatalogApp['approved'], head: Record<string, unknown>): CatalogApp {
  return {
    listing: {
      slug: 'orbit-notes',
      kind: 'onsite',
      name: 'Orbit Notes',
      tagline: null,
      category: null,
      contentRating: 'pg',
      iconUrl: null,
      creatorUsername: null,
      externalUrl: null,
      sourceRepoUrl: null,
      forkOf: null,
    },
    block: {
      id: 'ab_orbit_31',
      blockId: 'orbit-notes',
      version: history[history.length - 1].version,
      status: 'approved',
      contentRating: 'pg',
      manifest: manifest(head),
    },
    approved: history,
  };
}

// @v1 at 1.0.0; 1.1.0 widens `notes` (maxLength 100 → 200), which mints @v2.
const V1_ONLY = [approved('pubreq_1', '1.0.0', { notes: notes(100, { registry: 'public' }) })];
const MINTED = [
  ...V1_ONLY,
  approved('pubreq_2', '1.1.0', {
    notes: notes(200, { registry: 'public' }),
    drafts: notes(50),
  }),
];
const HEAD_V1 = { notes: notes(100, { registry: 'public' }) };
const HEAD_MINTED = { notes: notes(200, { registry: 'public' }), drafts: notes(50) };

const V = (slug: string, coll: string, n: number) => `urn:schema:app-blocks:${slug}/${coll}@v${n}`;
const SWITCH_ON = { ...APP_STORAGE_ENABLED_FEATURES, registryExport: true };

/** The adapter as `main.ts` composes it, over a catalog and document set the test edits. */
function source(world: { apps: CatalogApp[] }, features = SWITCH_ON) {
  const store = createMemorySnapshotStore();
  const cat: FixtureCatalog = {
    listings: [],
    documents: [
      {
        appId: 'ab_orbit_31',
        ns: 'prod',
        coll: 'notes',
        scopeUid: 0,
        key: 'n1',
        data: { title: 'first' },
        version: 1,
        seq: 2,
      },
    ],
    lastSeq: { ab_orbit_31: 2 },
  };
  const readApps = async () => world.apps;
  const entities = createPollingAdapter({
    namespace: 'app-blocks',
    serves: SERVED_SCHEMAS,
    read: async () =>
      buildEntities(await readApps(), { baseUrl: 'https://civitai.example', features }),
    store,
    pollMs: 5,
    sleep: abortableSleep,
  });
  const docs = createDocFeed({
    source: fixtureDocSource(() => cat),
    resolve: resolveFromCatalog(readApps, features),
    store,
    pollMs: 5,
    sleep: abortableSleep,
  });
  return { adapter: composeAdapter(entities, docs), store };
}

describe('🔴 end first for a schema this source does not serve (rule 4)', () => {
  it.each([
    ['an unknown app', V('no-such-app', 'notes', 1), SWITCH_ON],
    ['an unknown collection', V('orbit-notes', 'ghost', 1), SWITCH_ON],
    ['a collection that is not exported', V('orbit-notes', 'drafts', 1), SWITCH_ON],
    ['a major that has not minted', V('orbit-notes', 'notes', 3), SWITCH_ON],
    [
      'any collection with the switch off',
      V('orbit-notes', 'notes', 1),
      APP_STORAGE_ENABLED_FEATURES,
    ],
  ])('%s: end, and no cursor state read or written', async (_name, schema, features) => {
    const { adapter, store } = source({ apps: [app(MINTED, HEAD_MINTED)] }, features);
    const res = await subscribe(adapter, q(schema));
    expect([res.status, res.text, store.puts(), store.touches()]).toEqual([200, END_ONLY, 0, 0]);
  });

  it('a resume of one is end too, before its cursor is looked at', async () => {
    const { adapter, store } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, q(V('orbit-notes', 'notes', 3), cursorParam('nope')));
    expect([res.status, res.text, store.touches()]).toEqual([200, END_ONLY, 0]);
  });

  it('positive control: a published major is a snapshot, then live, and saves its state', async () => {
    const { adapter, store } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, q(V('orbit-notes', 'notes', 2)), (t) =>
      t.includes('event: live')
    );
    expect(events(res.text)).toEqual(['upsert', 'live']);
    expect(store.puts()).toBe(1);
  });
});

describe('🔴 a major that mints later', () => {
  /** The collection-schema URNs on this source's schema stream, from its snapshot. */
  async function onSchemaStream(a: Adapter) {
    const { entities } = await a.snapshot(REGISTRY_SCHEMA_SCHEMA, {
      signal: new AbortController().signal,
    });
    const urns: string[] = [];
    for await (const e of entities as AsyncIterable<Entity> | Iterable<Entity>) urns.push(e.urn);
    return urns.filter((u) => parseCollectionSchemaUrn(u) !== null).sort();
  }
  const CANDIDATES = [
    V('orbit-notes', 'notes', 1),
    V('orbit-notes', 'notes', 2),
    V('orbit-notes', 'notes', 3),
    V('orbit-notes', 'drafts', 1),
    V('orbit-notes', 'ghost', 1),
  ];
  async function served(a: Adapter) {
    const ctx = { signal: new AbortController().signal };
    const yes = await Promise.all(CANDIDATES.map((s) => a.serves(s, ctx)));
    return CANDIDATES.filter((_, i) => yes[i]).sort();
  }

  // The seam a registry relies on: it subscribes to a collection major once the schema stream
  // defines it (registry rule 1), so a source must serve exactly the majors it defines there.
  it.each([
    ['before the mint', [app(V1_ONLY, HEAD_V1)], SWITCH_ON, [V('orbit-notes', 'notes', 1)]],
    [
      'after the mint',
      [app(MINTED, HEAD_MINTED)],
      SWITCH_ON,
      [V('orbit-notes', 'notes', 1), V('orbit-notes', 'notes', 2)],
    ],
    ['with the switch off', [app(MINTED, HEAD_MINTED)], APP_STORAGE_ENABLED_FEATURES, []],
  ])(
    '%s: it serves exactly the majors its schema stream defines',
    async (_n, apps, features, expected) => {
      const { adapter } = source({ apps }, features);
      expect(await onSchemaStream(adapter)).toEqual(expected);
      expect(await served(adapter)).toEqual(expected);
    }
  );

  it('a subscription that got end before the mint is answered with a stream after it', async () => {
    const world = { apps: [app(V1_ONLY, HEAD_V1)] };
    const { adapter } = source(world);
    expect((await subscribe(adapter, q(V('orbit-notes', 'notes', 2)))).text).toBe(END_ONLY);
    world.apps = [app(MINTED, HEAD_MINTED)];
    const after = await subscribe(adapter, q(V('orbit-notes', 'notes', 2)), (t) =>
      t.includes('event: live')
    );
    expect(events(after.text)).toEqual(['upsert', 'live']);
  });
});

describe('🔴 a cursor is tied to the request that issued it: schema, urns and filter (rule 2)', () => {
  const ALPHA = 'urn:app-blocks:app/alpha';
  const BETA = 'urn:app-blocks:app/beta';
  const APPS = 'urn:schema:app-blocks:app@v1';
  const RELEASES = 'urn:schema:app-blocks:app-release@v1';
  const ent = (slug: string, rev: string): Entity => ({
    urn: `urn:app-blocks:app/${slug}`,
    schemas: [APPS],
    rev,
    body: { slug, kind: 'onsite' },
  });
  const catalog = () =>
    createPollingAdapter({
      namespace: 'app-blocks',
      serves: [APPS, RELEASES],
      read: async () =>
        new Map([
          [APPS, [ent('alpha', 'r1'), ent('beta', 'r1')]],
          [RELEASES, []],
        ]),
      store: createMemorySnapshotStore(),
      pollMs: 5,
      sleep: abortableSleep,
    });
  const FILTER = '{"type":"object","properties":{"kind":{"const":"onsite"}}}';
  const FILTER_REORDERED = '{"properties":{"kind":{"const":"onsite"}},"type":"object"}';
  const FILTER_OTHER = '{"type":"object","properties":{"kind":{"const":"offsite"}}}';

  async function issuedFor(a: Adapter, extra: string) {
    const res = await subscribe(a, q(APPS, extra), (t) => t.includes('event: live'));
    return liveCursor(res.text);
  }
  const resume = (a: Adapter, extra: string, cursor: string) =>
    subscribe(a, q(APPS, extra + cursorParam(cursor)), (t) => t.includes('event: live'));
  const outcome = (res: { status: number; text: string }) =>
    res.status === 200 ? events(res.text)[0] : (JSON.parse(res.text) as { error: string }).error;

  // Issued for urns [alpha, beta] and FILTER. The first three are invariant guards (a resume of
  // the same request was accepted before the change too); the last four are the change.
  it.each([
    ['the same request', 'live', urnParam(ALPHA, BETA) + filterParam(FILTER)],
    ['the same urns in another order', 'live', urnParam(BETA, ALPHA) + filterParam(FILTER)],
    [
      'the same filter with its keys in another order',
      'live',
      urnParam(ALPHA, BETA) + filterParam(FILTER_REORDERED),
    ],
    ['other urns', 'cursor_expired', urnParam(ALPHA) + filterParam(FILTER)],
    ['no urns', 'cursor_expired', filterParam(FILTER)],
    ['another filter', 'cursor_expired', urnParam(ALPHA, BETA) + filterParam(FILTER_OTHER)],
    ['no filter', 'cursor_expired', urnParam(ALPHA, BETA)],
  ])('resumed with %s: %s', async (_n, expected, extra) => {
    const a = catalog();
    const cursor = await issuedFor(a, urnParam(ALPHA, BETA) + filterParam(FILTER));
    const res = await resume(a, extra, cursor);
    expect(outcome(res)).toBe(expected);
    if (expected === 'cursor_expired')
      expect([res.status, res.text.includes('event: live')]).toEqual([410, false]);
  });

  // Invariant guard: the adapter's stored set names its schema, so this held before the change.
  it('a cursor of another schema this source serves is cursor_expired', async () => {
    const a = catalog();
    const cursor = await issuedFor(a, '');
    const res = await subscribe(a, q(RELEASES, cursorParam(cursor)));
    expect([res.status, (JSON.parse(res.text) as { error: string }).error]).toEqual([
      410,
      'cursor_expired',
    ]);
  });
});

describe('🔴 progress (rule 9)', () => {
  const APPS = 'urn:schema:app-blocks:app@v1';
  const ent = (slug: string, rev: string): Entity => ({
    urn: `urn:app-blocks:app/${slug}`,
    schemas: [APPS],
    rev,
    body: { slug },
  });

  it('a stream narrowed by urns gets progress when another entity moves the cursor, and it resumes', async () => {
    const store = createMemorySnapshotStore();
    let reads = 0;
    const states = [
      [ent('alpha', 'r1'), ent('beta', 'r1')],
      [ent('alpha', 'r1'), ent('beta', 'r2')],
    ];
    const a = createPollingAdapter({
      namespace: 'app-blocks',
      serves: [APPS],
      read: async () => new Map([[APPS, states[Math.min(reads++, states.length - 1)]]]),
      store,
      pollMs: 5,
      sleep: abortableSleep,
    });
    const only = urnParam('urn:app-blocks:app/alpha');
    const res = await subscribe(a, q(APPS, only), (t) => t.includes('event: progress'));
    expect(events(res.text)).toEqual(['upsert', 'live', 'progress']);
    const progress = cursorOf(res.text, 'progress');
    expect(progress).not.toBe(liveCursor(res.text));
    // `beta` never reached this stream, and the cursor still names a saved state.
    expect(res.text).not.toContain('urn:app-blocks:app/beta');
    const resumed = await subscribe(a, q(APPS, only + cursorParam(progress)), (t) =>
      t.includes('event: live')
    );
    expect(liveCursor(resumed.text)).toBe(progress);
  });
});

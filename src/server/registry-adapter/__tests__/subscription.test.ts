import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createPollingAdapter } from '~/server/registry-adapter/cursor';
import { abortableSleep } from '~/utils/errorHandling';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import { composeAdapter, resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { SERVED_SCHEMAS, buildEntities } from '~/server/registry-adapter/entities';
import type { Adapter, Entity } from '~/server/registry-adapter/protocol';
import { createRegistryServer } from '~/server/registry-adapter/serve';
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
const ROOT = 'https://json-schema.org/draft/2020-12/schema';
const LEGACY = 'urn:schema:registry:schema@v1';

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

const V = (slug: string, coll: string, n: number) =>
  `urn:schema:apps.civitai.com:${slug}/${coll}@v${n}`;
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
    namespace: 'apps.civitai.com',
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

describe('end first only for a schema this source can never serve (rule 4: end means never)', () => {
  it.each([
    ['another namespace', 'urn:schema:elsewhere.example:model@v1'],
    [
      'a collection URN this namespace never issues',
      'urn:schema:apps.civitai.com:Orbit Notes/notes@v1',
    ],
    ['a collection URN without a major', 'urn:schema:apps.civitai.com:orbit-notes/notes'],
    // The earlier spec's schema-stream URN: no longer served, so an unknown schema like any other.
    ['the earlier spec’s schema-stream URN', LEGACY],
  ])('%s: end, and no cursor state read or written', async (_name, schema) => {
    const { adapter, store } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, q(schema));
    expect([res.status, res.text, store.gets(), store.puts(), store.touches()]).toEqual([
      200,
      END_ONLY,
      0,
      0,
      0,
    ]);
  });
});

describe('🔴 end comes before a filter refusal: a request never served is end whatever its filter', () => {
  const APPS = 'urn:schema:apps.civitai.com:app@v1';
  const REFUSED = filterParam('{"properties":{"slug":{"pattern":"^zzz"}}}');

  // Before, the filter was compiled first, so each of these was 400 bad_request.
  it.each([
    ['a schema this source does not serve', q('urn:schema:elsewhere.example:model@v1', REFUSED)],
    [
      'urns all of another namespace',
      q(APPS, urnParam('urn:huggingface:black-forest-labs/FLUX.3-dev@a1b2c3d') + REFUSED),
    ],
  ])('%s, with a refused filter: end, not bad_request', async (_name, query) => {
    const { adapter, store } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, query);
    expect([res.status, res.text, store.gets(), store.puts(), store.touches()]).toEqual([
      200,
      END_ONLY,
      0,
      0,
      0,
    ]);
  });

  it('positive control: the same filter on a served request is bad_request', async () => {
    const { adapter } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, q(APPS, REFUSED));
    expect([res.status, (JSON.parse(res.text) as { error: string }).error]).toEqual([
      400,
      'bad_request',
    ]);
  });
});

/** The entities a response's upserts carry, in order. */
const upserts = (text: string) =>
  [...text.matchAll(/^event: upsert\n(?:id:.*\n)?data: (.*)$/gm)].map(
    (m) => (JSON.parse(m[1]) as { entity: Entity }).entity
  );

describe('🔴 end first for urns outside this namespace (rule 4)', () => {
  const APPS = 'urn:schema:apps.civitai.com:app@v1';
  const ORBIT = 'urn:apps.civitai.com:app/orbit-notes';
  const FOREIGN = 'urn:huggingface:black-forest-labs/FLUX.3-dev@a1b2c3d';

  // Before, each of these was an empty snapshot and `live`, with the stream left open.
  it.each([
    ['one urn of another namespace', APPS, [FOREIGN]],
    ['several, none of this namespace', APPS, [FOREIGN, 'urn:github:civitai/civitai']],
    [
      'a schema urn of another namespace, on the schema stream',
      ROOT,
      ['urn:schema:elsewhere.example:model@v1'],
    ],
    ['a string that is not a urn', APPS, ['orbit-notes']],
  ])('%s: end, and no cursor state read or written', async (_name, schema, urns) => {
    const { adapter, store } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, q(schema, urnParam(...urns)));
    expect([res.status, res.text, store.gets(), store.puts(), store.touches()]).toEqual([
      200,
      END_ONLY,
      0,
      0,
      0,
    ]);
  });

  it('a mix: the urns of this namespace are served, the foreign ones never appear, and no end', async () => {
    const { adapter } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, q(APPS, urnParam(FOREIGN, ORBIT)), (t) =>
      t.includes('event: live')
    );
    expect(events(res.text)).toEqual(['upsert', 'live']);
    expect(upserts(res.text).map((e) => e.urn)).toEqual([ORBIT]);
  });

  it('positive control: a urn of this namespace that does not exist is live, never end', async () => {
    const { adapter } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(
      adapter,
      q(APPS, urnParam('urn:apps.civitai.com:app/no-such-app')),
      (t) => t.includes('event: live')
    );
    expect(events(res.text)).toEqual(['live']);
  });
});

describe('🔴 the schema stream is the root', () => {
  // Before, the root was not served (end first); the earlier URN, now end, was the stream.
  it.each([[ROOT]])('%s: every schema, each claiming the root', async (stream) => {
    const { adapter } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, q(stream), (t) => t.includes('event: live'));
    const got = upserts(res.text);
    expect(got.map((e) => e.urn).sort()).toEqual([
      'urn:schema:apps.civitai.com:app-release@v1',
      'urn:schema:apps.civitai.com:app@v1',
      'urn:schema:apps.civitai.com:orbit-notes/notes@v1',
      'urn:schema:apps.civitai.com:orbit-notes/notes@v2',
      'urn:schema:apps.civitai.com:service@v1',
    ]);
    expect(new Set(got.map((e) => JSON.stringify(e.schemas)))).toEqual(
      new Set([JSON.stringify([stream])])
    );
    // A schema's body declares the root as its `$schema` too.
    expect(new Set(got.map((e) => (e.body as { $schema?: unknown }).$schema))).toEqual(
      new Set([ROOT])
    );
  });
});

describe('🔴 a collection major it may publish later streams empty and writes nothing', () => {
  it.each([
    ['an app that does not exist yet', V('no-such-app', 'notes', 1), SWITCH_ON],
    ['a collection not declared yet', V('orbit-notes', 'ghost', 1), SWITCH_ON],
    ['a collection that is not exported', V('orbit-notes', 'drafts', 1), SWITCH_ON],
    ['a major that has not minted', V('orbit-notes', 'notes', 3), SWITCH_ON],
    [
      'any collection with the switch off',
      V('orbit-notes', 'notes', 1),
      APP_STORAGE_ENABLED_FEATURES,
    ],
  ])('%s: live with no snapshot, never end, and no state written', async (_n, schema, features) => {
    const { adapter, store } = source({ apps: [app(MINTED, HEAD_MINTED)] }, features);
    const res = await subscribe(adapter, q(schema), (t) => t.includes('event: live'));
    expect(events(res.text)).toEqual(['live']);
    // A resume from that cursor is live again, and still writes nothing.
    const resumed = await subscribe(adapter, q(schema, cursorParam(liveCursor(res.text))), (t) =>
      t.includes('event: live')
    );
    expect(events(resumed.text)).toEqual(['live']);
    expect([store.puts(), store.touches()]).toEqual([0, 0]);
  });

  it('positive control: a published major is a snapshot, then live, and saves its state', async () => {
    const { adapter, store } = source({ apps: [app(MINTED, HEAD_MINTED)] });
    const res = await subscribe(adapter, q(V('orbit-notes', 'notes', 2)), (t) =>
      t.includes('event: live')
    );
    expect(events(res.text)).toEqual(['upsert', 'live']);
    expect(store.puts()).toBe(1);
  });

  it('a stream opened before its major mints receives the documents once it does', async () => {
    const world = { apps: [app(V1_ONLY, HEAD_V1)] };
    const { adapter } = source(world);
    const mint = setTimeout(() => (world.apps = [app(MINTED, HEAD_MINTED)]), 50);
    try {
      const res = await subscribe(adapter, q(V('orbit-notes', 'notes', 2)), (t) =>
        t.includes('event: upsert')
      );
      expect(events(res.text)).toEqual(['live', 'upsert']);
      expect(res.text).toContain('urn:apps.civitai.com:orbit-notes/notes/n1');
    } finally {
      clearTimeout(mint);
    }
  });
});

describe('🔴 a cursor is tied to the request that issued it: schema, urns and filter (rule 2)', () => {
  const ALPHA = 'urn:apps.civitai.com:app/alpha';
  const BETA = 'urn:apps.civitai.com:app/beta';
  const APPS = 'urn:schema:apps.civitai.com:app@v1';
  const RELEASES = 'urn:schema:apps.civitai.com:app-release@v1';
  const ent = (slug: string, rev: string): Entity => ({
    urn: `urn:apps.civitai.com:app/${slug}`,
    schemas: [APPS],
    rev,
    body: { slug, kind: 'onsite', contentRating: 'g' },
  });
  const catalog = () =>
    createPollingAdapter({
      namespace: 'apps.civitai.com',
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

describe('🔴 progress after changes the filter excluded (rule 9)', () => {
  const APPS = 'urn:schema:apps.civitai.com:app@v1';
  const ent = (slug: string, rev: string, kind: string): Entity => ({
    urn: `urn:apps.civitai.com:app/${slug}`,
    schemas: [APPS],
    rev,
    body: { slug, kind, contentRating: 'g' },
  });
  const ONSITE = filterParam('{"properties":{"kind":{"const":"onsite"}}}');
  const catalog = (states: Entity[][], store = createMemorySnapshotStore()) => {
    let reads = 0;
    return createPollingAdapter({
      namespace: 'apps.civitai.com',
      serves: [APPS],
      read: async () => new Map([[APPS, states[Math.min(reads++, states.length - 1)]]]),
      store,
      pollMs: 5,
      sleep: abortableSleep,
    });
  };
  const after = (n: number) => (t: string) => events(t).length >= n;

  it('a change to an entity the consumer never received, still not matching: progress, not a delete', async () => {
    const a = catalog([
      [ent('alpha', 'r1', 'onsite'), ent('beta', 'r1', 'offsite')],
      [ent('alpha', 'r1', 'onsite'), ent('beta', 'r2', 'offsite')],
    ]);
    const res = await subscribe(a, q(APPS, ONSITE), after(3));
    expect(events(res.text)).toEqual(['upsert', 'live', 'progress']);
    expect(cursorOf(res.text, 'progress')).not.toBe(liveCursor(res.text));
    expect(res.text).not.toContain('urn:apps.civitai.com:app/beta');
  });

  it('positive control: one the consumer holds that stops matching is a delete (rule 6)', async () => {
    const a = catalog([[ent('alpha', 'r1', 'onsite')], [ent('alpha', 'r2', 'offsite')]]);
    const res = await subscribe(a, q(APPS, ONSITE), after(3));
    expect(events(res.text)).toEqual(['upsert', 'live', 'delete']);
  });

  it('on a resume, where what the consumer holds is unknown, a non-matching change is a delete', async () => {
    const store = createMemorySnapshotStore();
    const first = catalog([[ent('alpha', 'r1', 'onsite'), ent('beta', 'r1', 'offsite')]], store);
    const live = liveCursor((await subscribe(first, q(APPS, ONSITE), after(2))).text);
    const next = catalog([[ent('alpha', 'r1', 'onsite'), ent('beta', 'r2', 'offsite')]], store);
    const res = await subscribe(next, q(APPS, ONSITE + cursorParam(live)), after(2));
    expect(events(res.text)).toEqual(['live', 'delete']);
  });
});

describe('🔴 progress (rule 9)', () => {
  const APPS = 'urn:schema:apps.civitai.com:app@v1';
  const ent = (slug: string, rev: string): Entity => ({
    urn: `urn:apps.civitai.com:app/${slug}`,
    schemas: [APPS],
    rev,
    body: { slug, contentRating: 'g' },
  });

  it('a stream narrowed by urns gets progress when another entity moves the cursor, and it resumes', async () => {
    const store = createMemorySnapshotStore();
    let reads = 0;
    const states = [
      [ent('alpha', 'r1'), ent('beta', 'r1')],
      [ent('alpha', 'r1'), ent('beta', 'r2')],
    ];
    const a = createPollingAdapter({
      namespace: 'apps.civitai.com',
      serves: [APPS],
      read: async () => new Map([[APPS, states[Math.min(reads++, states.length - 1)]]]),
      store,
      pollMs: 5,
      sleep: abortableSleep,
    });
    const only = urnParam('urn:apps.civitai.com:app/alpha');
    const res = await subscribe(a, q(APPS, only), (t) => t.includes('event: progress'));
    expect(events(res.text)).toEqual(['upsert', 'live', 'progress']);
    const progress = cursorOf(res.text, 'progress');
    expect(progress).not.toBe(liveCursor(res.text));
    // `beta` never reached this stream, and the cursor still names a saved state.
    expect(res.text).not.toContain('urn:apps.civitai.com:app/beta');
    const resumed = await subscribe(a, q(APPS, only + cursorParam(progress)), (t) =>
      t.includes('event: live')
    );
    expect(liveCursor(resumed.text)).toBe(progress);
  });
});

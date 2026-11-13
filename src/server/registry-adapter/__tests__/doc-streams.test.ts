import { describe, expect, it } from 'vitest';
import { composeAdapter, resolveFromCatalog } from '~/server/registry-adapter/doc-streams';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { createDocFeed } from '~/server/registry-adapter/doc-feed';
import type { Adapter } from '~/server/registry-adapter/protocol';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';
import { createMemorySnapshotStore } from '../../../../scripts/registry-adapter-fixture/fixture-source';

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

function app(
  head: Record<string, unknown>,
  over: Partial<NonNullable<CatalogApp['block']>> = {}
): CatalogApp {
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
      version: '1.1.0',
      status: 'approved',
      contentRating: 'pg',
      manifest: manifest(head),
      ...over,
    },
    approved: [
      {
        id: 'pubreq_orbit_1',
        version: '1.0.0',
        manifest: manifest({ notes: notes(100, { registry: 'public' }), drafts: notes(50) }),
        bundleSha256: null,
        commitSha: null,
        sourceCommit: null,
        reviewedAt: null,
      },
    ],
  };
}

const V = (coll: string, n: number) => `urn:schema:apps.civitai.com:orbit-notes/${coll}@v${n}`;
const OPTED_IN = { notes: notes(200, { registry: 'public' }), drafts: notes(50) };

describe('resolveFromCatalog', () => {
  // The live switch ships off; these cases turn it on, and the cases below keep it off.
  const SWITCH_ON = { ...APP_STORAGE_ENABLED_FEATURES, registryExport: true };
  const resolve = (apps: CatalogApp[]) => resolveFromCatalog(async () => apps, SWITCH_ON);

  it('🔴 with the live switch off, an approved manifest that declares registry:"public" publishes nothing', async () => {
    expect(await resolveFromCatalog(async () => [app(OPTED_IN)])(V('notes', 1))).toBeNull();
  });

  it('🔴 and its stream serves nothing and writes no state', async () => {
    const store = createMemorySnapshotStore();
    const feed = createDocFeed({
      source: {
        head: async () => 9,
        changes: async () => ({ docs: [], tombs: [] }),
        documents: async () => [{ key: 'k1', data: { title: 'x' }, version: 1, seq: 9 }],
        witness: async () => ({ docSeq: null, tombSeq: null }),
      },
      resolve: resolveFromCatalog(async () => [app(OPTED_IN)]),
      store,
      pollMs: 1,
      sleep: async () => undefined,
    });
    const snap = await feed.snapshot(V('notes', 1));
    expect([snap.entities, store.puts()]).toEqual([[], 0]);
  });

  it('positive control: the same manifest with the switch on is published', async () => {
    expect((await resolve([app(OPTED_IN)])(V('notes', 1)))?.appId).toBe('ab_orbit_31');
  });

  it('an opted-in collection of a listed, approved app: its app and every major', async () => {
    const stream = await resolve([app(OPTED_IN)])(V('notes', 1));
    expect(stream && { ...stream, family: stream.family.map((f) => f.urn) }).toEqual({
      appId: 'ab_orbit_31',
      slug: 'orbit-notes',
      collection: 'notes',
      contentRating: 'pg',
      family: [V('notes', 1), V('notes', 2)],
    });
  });

  it('the stream carries its app’s rating: the listing’s, else its block’s', async () => {
    const listed = app(OPTED_IN, { contentRating: 'pg13' });
    listed.listing.contentRating = 'x';
    expect((await resolve([listed])(V('notes', 1)))?.contentRating).toBe('x');
    listed.listing.contentRating = null;
    expect((await resolve([listed])(V('notes', 1)))?.contentRating).toBe('pg13');
  });

  it('a major past the newest is not published', async () => {
    expect(await resolve([app(OPTED_IN)])(V('notes', 3))).toBeNull();
  });

  it('🔴 a collection that is not opted in is never published', async () => {
    expect(await resolve([app(OPTED_IN)])(V('drafts', 1))).toBeNull();
  });

  it('🔴 the opt-in is read from the enforced manifest: dropping it there unpublishes', async () => {
    expect(
      await resolve([app({ notes: notes(200), drafts: notes(50) })])(V('notes', 1))
    ).toBeNull();
  });

  it('🔴 a private collection is never published, whatever it declares', async () => {
    const priv = { notes: { visibility: 'private', registry: 'public' } };
    expect(await resolve([app(priv)])(V('notes', 1))).toBeNull();
  });

  it('a block that is not approved, or an app not in the catalog, is not published', async () => {
    expect(await resolve([app(OPTED_IN, { status: 'suspended' })])(V('notes', 1))).toBeNull();
    expect(await resolve([])(V('notes', 1))).toBeNull();
  });

  it('a URN that is not a collection schema of this namespace resolves to nothing', async () => {
    const r = resolve([app(OPTED_IN)]);
    expect(await r('urn:schema:apps.civitai.com:app@v1')).toBeNull();
    expect(await r('urn:schema:other-ns:orbit-notes/notes@v1')).toBeNull();
  });
});

describe('composeAdapter', () => {
  const APPS = 'urn:schema:apps.civitai.com:app@v1';
  const entities: Adapter = {
    namespace: 'apps.civitai.com',
    serves: (s) => s === APPS,
    // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
    snapshot: async () => ({ cursor: 'entity-cursor', entities: [] }),
    // eslint-disable-next-line require-yield
    changes: async () =>
      (async function* () {
        // no changes
      })(),
  };
  const docs = {
    // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
    snapshot: async () => ({ cursor: 'doc-cursor', entities: [] }),
    // eslint-disable-next-line require-yield
    changes: async () =>
      (async function* () {
        // no changes
      })(),
  };
  const adapter = composeAdapter(entities, docs as never);
  const ctx = { signal: new AbortController().signal };

  it('🔴 serves the entity schemas and every collection-schema URN it may publish, nothing else', () => {
    const schemas = [
      APPS,
      V('notes', 1),
      V('notes', 2),
      'urn:schema:civitai-schemas:model@v1',
      'urn:schema:x:y@v1',
    ];
    expect(schemas.map((s) => adapter.serves(s))).toEqual([true, true, true, false, false]);
  });

  it('routes each stream to its own source', async () => {
    expect((await adapter.snapshot(APPS, ctx)).cursor).toBe('entity-cursor');
    expect((await adapter.snapshot(V('notes', 2), ctx)).cursor).toBe('doc-cursor');
  });
});

import { describe, expect, it } from 'vitest';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { buildEntities } from '~/server/registry-adapter/entities';
import { APP_STORAGE_ENABLED_FEATURES } from '~/shared/constants/block-storage.constants';

// The schema stream: the root, JSON Schema 2020-12's own meta-schema.
const SCHEMA = 'https://json-schema.org/draft/2020-12/schema';
const APP = 'urn:schema:apps.civitai.com:app@v1';
const RELEASE = 'urn:schema:apps.civitai.com:app-release@v1';
const SERVICE = 'urn:schema:apps.civitai.com:service@v1';
/** The schema entities this source publishes for its own entities, whatever the catalog holds. */
const OWN_SCHEMAS = [APP, RELEASE, SERVICE];

// `cards` is exported (shared, `registry: "public"`); `drafts` never is (private, no opt-in).
const cards = (maximum: number) => ({
  storage: {
    collections: {
      cards: {
        visibility: 'shared',
        write: 'own',
        registry: 'public',
        schema: { type: 'object', properties: { stars: { type: 'integer', maximum } } },
      },
      drafts: {
        visibility: 'private',
        schema: { type: 'object', properties: { body: { type: 'string' } } },
      },
    },
  },
});

const SWITCH_ON = { ...APP_STORAGE_ENABLED_FEATURES, registryExport: true };
const ON = { baseUrl: 'https://site.example', features: SWITCH_ON };

const listing = (over: Partial<CatalogApp['listing']>): CatalogApp['listing'] => ({
  slug: 'orbit-notes',
  kind: 'onsite',
  name: 'Orbit Notes',
  tagline: 'Notes in orbit',
  category: 'productivity-q',
  contentRating: 'x',
  iconUrl: 'https://img.example/orbit.png',
  creatorUsername: 'maker-k',
  externalUrl: null,
  sourceRepoUrl: null,
  forkOf: null,
  ...over,
});

const release = (id: string, version: string, maximum: number) => ({
  id,
  version,
  manifest: { blockId: 'orbit-notes', version, ...cards(maximum) },
  bundleSha256: null,
  commitSha: null,
  sourceCommit: null,
  reviewedAt: null,
});

const ORBIT: CatalogApp = {
  listing: listing({}),
  block: {
    id: 'ab_orbit',
    blockId: 'orbit-notes',
    version: '1.1.0',
    status: 'approved',
    contentRating: 'r',
    manifest: { blockId: 'orbit-notes', version: '1.1.0', ...cards(20) },
  },
  approved: [release('pubreq_1', '1.0.0', 10), release('pubreq_2', '1.1.0', 20)],
};

const TIDE: CatalogApp = {
  listing: listing({
    slug: 'tide-log',
    kind: 'offsite',
    name: 'Tide Log',
    contentRating: null,
    externalUrl: 'https://tide.example',
  }),
  block: null,
  approved: [],
};

const SUSPENDED: CatalogApp = {
  ...ORBIT,
  listing: listing({ slug: 'hush-board', name: 'Hush Board', contentRating: null }),
  block: { ...ORBIT.block!, id: 'ab_hush', blockId: 'hush-board', status: 'suspended' },
};

const urns = (sets: ReturnType<typeof buildEntities>, schema: string) =>
  (sets.get(schema) ?? []).map((e) => e.urn);

describe('buildEntities', () => {
  const sets = buildEntities([ORBIT, TIDE, SUSPENDED], ON);

  it('one app entity per listed app, whatever its rating', () => {
    expect(urns(sets, APP)).toEqual([
      'urn:apps.civitai.com:app/orbit-notes',
      'urn:apps.civitai.com:app/tide-log',
      'urn:apps.civitai.com:app/hush-board',
    ]);
  });

  it('releases and schemas only for an approved block', () => {
    expect(urns(sets, RELEASE)).toEqual([
      'urn:apps.civitai.com:app/orbit-notes@1.0.0',
      'urn:apps.civitai.com:app/orbit-notes@1.1.0',
    ]);
    expect(urns(sets, SCHEMA)).toEqual([
      ...OWN_SCHEMAS,
      'urn:schema:apps.civitai.com:orbit-notes/cards@v1',
      'urn:schema:apps.civitai.com:orbit-notes/cards@v2',
    ]);
  });

  it('🔴 a collection that is not exported publishes no schema and is in no release', () => {
    // `drafts` is declared by every manifest but never opted in: before, its schema (field names
    // and constraints) was published and every release listed it.
    expect(urns(sets, SCHEMA).filter((u) => u.includes('/drafts@'))).toEqual([]);
    for (const e of sets.get(RELEASE) ?? []) {
      expect(Object.keys((e.body as { collections: object }).collections)).toEqual(['cards']);
    }
  });

  it('🔴 with the registryExport switch off (the default), no collection schema is published', () => {
    const off = buildEntities([ORBIT], { baseUrl: 'https://site.example' });
    expect(urns(off, SCHEMA)).toEqual(OWN_SCHEMAS);
    // A release with nothing exported carries no `collections` at all.
    expect(
      (off.get(RELEASE) ?? []).map((e) => Object.hasOwn(e.body as object, 'collections'))
    ).toEqual([false, false]);
    // The releases themselves are still published.
    expect(urns(off, RELEASE)).toEqual([
      'urn:apps.civitai.com:app/orbit-notes@1.0.0',
      'urn:apps.civitai.com:app/orbit-notes@1.1.0',
    ]);
  });

  it('each release names the major it declared each collection under', () => {
    expect(
      (sets.get(RELEASE) ?? []).map((e) => (e.body as { collections: unknown }).collections)
    ).toEqual([
      { cards: 'urn:schema:apps.civitai.com:orbit-notes/cards@v1' },
      { cards: 'urn:schema:apps.civitai.com:orbit-notes/cards@v2' },
    ]);
  });

  it('the app body', () => {
    const orbit = (sets.get(APP) ?? []).find(
      (e) => e.urn === 'urn:apps.civitai.com:app/orbit-notes'
    );
    expect(orbit?.body).toEqual({
      slug: 'orbit-notes',
      name: 'Orbit Notes',
      kind: 'onsite',
      contentRating: 'x',
      tagline: 'Notes in orbit',
      category: 'productivity-q',
      iconUrl: 'https://img.example/orbit.png',
      creator: 'maker-k',
      runtime: 'urn:apps.civitai.com:runtime/iframe@1',
      release: 'urn:apps.civitai.com:app/orbit-notes@1.1.0',
    });
  });

  it('contentRating falls back to the block, and is present (null) on an off-site app without one', () => {
    const body = (urn: string) =>
      (sets.get(APP) ?? []).find((e) => e.urn === urn)?.body as Record<string, unknown>;
    expect(body('urn:apps.civitai.com:app/hush-board').contentRating).toBe('r');
    expect(Object.hasOwn(body('urn:apps.civitai.com:app/tide-log'), 'contentRating')).toBe(true);
    expect(body('urn:apps.civitai.com:app/tide-log').contentRating).toBeNull();
    expect(body('urn:apps.civitai.com:app/tide-log').externalUrl).toBe('https://tide.example');
  });

  it('🔴 forkOf is the parent app URN when the catalog read named a parent, and absent otherwise', () => {
    const forked = buildEntities(
      [
        { ...TIDE, listing: listing({ ...TIDE.listing, slug: 'kelp-fork', forkOf: 'tide-log' }) },
        { ...TIDE, listing: listing({ ...TIDE.listing, slug: 'reef-fork', forkOf: null }) },
      ],
      { baseUrl: 'https://site.example' }
    );
    const body = (urn: string) =>
      (forked.get(APP) ?? []).find((e) => e.urn === urn)?.body as Record<string, unknown>;
    expect(body('urn:apps.civitai.com:app/kelp-fork').forkOf).toBe(
      'urn:apps.civitai.com:app/tide-log'
    );
    expect(Object.hasOwn(body('urn:apps.civitai.com:app/reef-fork'), 'forkOf')).toBe(false);
  });

  it('🔴 a URN segment out of bounds skips only its own entity, never the catalog', () => {
    // The store bounds none of these the way the URN grammar does: before, the first one threw
    // out of buildEntities and every app and release in the catalog went unserved.
    const LONG_VERSION = `1.2.0-${'a'.repeat(70)}`;
    const LONG_SLUG = 'a'.repeat(70);
    const skipped: string[] = [];
    const out = buildEntities(
      [
        {
          ...ORBIT,
          block: { ...ORBIT.block!, version: LONG_VERSION },
          approved: [...ORBIT.approved, release('pubreq_3', LONG_VERSION, 20)],
        },
        { ...TIDE, listing: listing({ ...TIDE.listing, slug: LONG_SLUG }) },
        { ...TIDE, listing: listing({ ...TIDE.listing, slug: 'kelp-fork', forkOf: LONG_SLUG }) },
        TIDE,
      ],
      { baseUrl: 'https://site.example', onSkip: (reason) => skipped.push(reason) }
    );
    expect(urns(out, APP)).toEqual([
      'urn:apps.civitai.com:app/orbit-notes',
      'urn:apps.civitai.com:app/kelp-fork',
      'urn:apps.civitai.com:app/tide-log',
    ]);
    expect(urns(out, RELEASE)).toEqual([
      'urn:apps.civitai.com:app/orbit-notes@1.0.0',
      'urn:apps.civitai.com:app/orbit-notes@1.1.0',
    ]);
    const body = (urn: string) =>
      (out.get(APP) ?? []).find((e) => e.urn === urn)?.body as Record<string, unknown>;
    // The head version was the skipped release, so the app names no current release.
    expect(Object.hasOwn(body('urn:apps.civitai.com:app/orbit-notes'), 'release')).toBe(false);
    expect(Object.hasOwn(body('urn:apps.civitai.com:app/kelp-fork'), 'forkOf')).toBe(false);
    expect(skipped).toHaveLength(3);
    expect(skipped[0]).toMatch(/^release pubreq_3 of orbit-notes skipped: .*invalid version/);
    expect(skipped[1]).toMatch(/^app skipped: .*invalid slug/);
    expect(skipped[2]).toMatch(/^forkOf of kelp-fork dropped: .*invalid slug/);
  });

  it('one static runtime record', () => {
    expect(sets.get(SERVICE)).toEqual([
      expect.objectContaining({
        urn: 'urn:apps.civitai.com:runtime/iframe@1',
        schemas: [SERVICE],
        body: expect.objectContaining({
          kind: 'app-runtime',
          reads: RELEASE,
          endpoint: 'https://site.example/apps',
          parameters: {
            namespace: 'apps.civitai.com',
            launch: 'https://site.example/apps/run/{slug}',
            submit: 'https://site.example/apps/submit',
          },
        }),
      }),
    ]);
  });

  it('rev changes with the body and only with it', () => {
    const again = buildEntities([ORBIT, TIDE, SUSPENDED], ON);
    const renamed = buildEntities([{ ...ORBIT, listing: listing({ name: 'Orbit Notes II' }) }], {
      baseUrl: 'https://site.example',
    });
    const rev = (s: ReturnType<typeof buildEntities>) => (s.get(APP) ?? [])[0].rev;
    expect(rev(again)).toBe(rev(sets));
    expect(rev(renamed)).not.toBe(rev(sets));
  });

  it('the enforced manifest is the newest step: a head wider than every approved request mints', () => {
    const diverged: CatalogApp = {
      ...ORBIT,
      approved: [release('pubreq_1', '1.0.0', 10)],
      block: {
        ...ORBIT.block!,
        version: '1.0.0',
        manifest: { blockId: 'orbit-notes', ...cards(30) },
      },
    };
    const out = buildEntities([diverged], ON);
    expect(urns(out, SCHEMA)).toEqual([
      ...OWN_SCHEMAS,
      'urn:schema:apps.civitai.com:orbit-notes/cards@v1',
      'urn:schema:apps.civitai.com:orbit-notes/cards@v2',
    ]);
    expect(urns(out, RELEASE)).toEqual(['urn:apps.civitai.com:app/orbit-notes@1.0.0']);
  });
});

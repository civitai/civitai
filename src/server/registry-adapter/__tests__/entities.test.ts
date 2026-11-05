import { describe, expect, it } from 'vitest';
import type { CatalogApp } from '~/server/registry-adapter/entities';
import { buildEntities } from '~/server/registry-adapter/entities';

const SCHEMA = 'urn:schema:registry:schema@v1';
const APP = 'urn:schema:civitai-schemas:app@v1';
const RELEASE = 'urn:schema:civitai-schemas:app-release@v1';
const SERVICE = 'urn:schema:civitai-schemas:service@v1';

const cards = (maximum: number) => ({
  storage: {
    collections: {
      cards: {
        visibility: 'private',
        schema: { type: 'object', properties: { stars: { type: 'integer', maximum } } },
      },
    },
  },
});

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
  const sets = buildEntities([ORBIT, TIDE, SUSPENDED], { baseUrl: 'https://site.example' });

  it('one app entity per listed app, whatever its rating', () => {
    expect(urns(sets, APP)).toEqual([
      'urn:civitai-apps:app/orbit-notes',
      'urn:civitai-apps:app/tide-log',
      'urn:civitai-apps:app/hush-board',
    ]);
  });

  it('releases and schemas only for an approved block', () => {
    expect(urns(sets, RELEASE)).toEqual([
      'urn:civitai-apps:app/orbit-notes@1.0.0',
      'urn:civitai-apps:app/orbit-notes@1.1.0',
    ]);
    expect(urns(sets, SCHEMA)).toEqual([
      'urn:schema:civitai-apps:orbit-notes/cards@v1',
      'urn:schema:civitai-apps:orbit-notes/cards@v2',
    ]);
  });

  it('each release names the major it declared each collection under', () => {
    expect(
      (sets.get(RELEASE) ?? []).map((e) => (e.body as { collections: unknown }).collections)
    ).toEqual([
      { cards: 'urn:schema:civitai-apps:orbit-notes/cards@v1' },
      { cards: 'urn:schema:civitai-apps:orbit-notes/cards@v2' },
    ]);
  });

  it('the app body', () => {
    const orbit = (sets.get(APP) ?? []).find((e) => e.urn === 'urn:civitai-apps:app/orbit-notes');
    expect(orbit?.body).toEqual({
      slug: 'orbit-notes',
      name: 'Orbit Notes',
      kind: 'onsite',
      contentRating: 'x',
      tagline: 'Notes in orbit',
      category: 'productivity-q',
      iconUrl: 'https://img.example/orbit.png',
      creator: 'maker-k',
      runtime: 'urn:civitai-apps:runtime/iframe@1',
      release: 'urn:civitai-apps:app/orbit-notes@1.1.0',
    });
  });

  it('contentRating falls back to the block, and is present (null) on an off-site app without one', () => {
    const body = (urn: string) =>
      (sets.get(APP) ?? []).find((e) => e.urn === urn)?.body as Record<string, unknown>;
    expect(body('urn:civitai-apps:app/hush-board').contentRating).toBe('r');
    expect(Object.hasOwn(body('urn:civitai-apps:app/tide-log'), 'contentRating')).toBe(true);
    expect(body('urn:civitai-apps:app/tide-log').contentRating).toBeNull();
    expect(body('urn:civitai-apps:app/tide-log').externalUrl).toBe('https://tide.example');
  });

  it('one static runtime record', () => {
    expect(sets.get(SERVICE)).toEqual([
      expect.objectContaining({
        urn: 'urn:civitai-apps:runtime/iframe@1',
        schemas: [SERVICE],
        body: expect.objectContaining({
          kind: 'app-runtime',
          reads: RELEASE,
          endpoint: 'https://site.example/apps',
          parameters: {
            namespace: 'civitai-apps',
            launch: 'https://site.example/apps/run/{slug}',
            submit: 'https://site.example/apps/submit',
          },
        }),
      }),
    ]);
  });

  it('rev changes with the body and only with it', () => {
    const again = buildEntities([ORBIT, TIDE, SUSPENDED], { baseUrl: 'https://site.example' });
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
    const out = buildEntities([diverged], { baseUrl: 'https://site.example' });
    expect(urns(out, SCHEMA)).toEqual([
      'urn:schema:civitai-apps:orbit-notes/cards@v1',
      'urn:schema:civitai-apps:orbit-notes/cards@v2',
    ]);
    expect(urns(out, RELEASE)).toEqual(['urn:civitai-apps:app/orbit-notes@1.0.0']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseCollectionSchemaUrn,
  parseViewerSchemaUrn,
  registryUrn,
  urnNamespace,
  viewerSchemaUrn,
} from '~/server/registry-adapter/urn';

describe('registryUrn', () => {
  it.each([
    [{ kind: 'app', slug: 'pixel-garden' }, 'urn:apps.civitai.com:app/pixel-garden'],
    [
      { kind: 'release', slug: 'pixel-garden', version: '2.10.3-beta.1' },
      'urn:apps.civitai.com:app/pixel-garden@2.10.3-beta.1',
    ],
    [
      { kind: 'collection-schema', slug: 'pixel-garden', collection: 'seed_packs', major: 3 },
      'urn:schema:apps.civitai.com:pixel-garden/seed_packs@v3',
    ],
    [{ kind: 'runtime', name: 'iframe', major: 1 }, 'urn:apps.civitai.com:runtime/iframe@1'],
    [
      { kind: 'service', name: 'app-search', major: 1 },
      'urn:apps.civitai.com:service/app-search@1',
    ],
    [
      { kind: 'service', name: 'app-search', major: 12 },
      'urn:apps.civitai.com:service/app-search@12',
    ],
    [
      { kind: 'document', slug: 'pixel-garden', collection: 'seed_packs', key: '01J:Ab.c-9' },
      'urn:apps.civitai.com:pixel-garden/seed_packs/01J:Ab.c-9',
    ],
  ] as const)('%o → %s', (ref, urn) => {
    expect(registryUrn(ref)).toBe(urn);
  });

  // A segment holding `:`, `/` or `@` would make two different refs spell one URN.
  it.each([
    { kind: 'app', slug: 'a/b' },
    { kind: 'app', slug: 'a:b' },
    { kind: 'app', slug: 'Pixel' },
    { kind: 'app', slug: '' },
    { kind: 'release', slug: 'pixel-garden', version: '1.0.0@2' },
    { kind: 'release', slug: 'pixel-garden', version: '1/0' },
    { kind: 'collection-schema', slug: 'pixel-garden', collection: 'a/b', major: 1 },
    { kind: 'collection-schema', slug: 'pixel-garden', collection: 'seed_packs', major: 0 },
    { kind: 'collection-schema', slug: 'pixel-garden', collection: 'seed_packs', major: 1.5 },
    { kind: 'document', slug: 'pixel-garden', collection: 'seed_packs', key: 'a/b' },
    { kind: 'document', slug: 'pixel-garden', collection: 'seed_packs', key: 'a@b' },
    // Bounded like the store's own names: 64 for a slug, 32 for a collection, 64 for a version.
    { kind: 'app', slug: 'a'.repeat(65) },
    { kind: 'collection-schema', slug: 'pixel-garden', collection: 'c'.repeat(33), major: 1 },
    { kind: 'release', slug: 'pixel-garden', version: '1'.repeat(65) },
    { kind: 'service', name: 'app/search', major: 1 },
    { kind: 'service', name: 'app@search', major: 1 },
    { kind: 'service', name: 'app:search', major: 1 },
    { kind: 'service', name: 'App-Search', major: 1 },
    { kind: 'service', name: '', major: 1 },
    { kind: 'service', name: 's'.repeat(65), major: 1 },
    { kind: 'service', name: 'app-search', major: 0 },
    { kind: 'service', name: 'app-search', major: 1.5 },
    { kind: 'service', name: 'app-search', major: -1 },
  ] as const)('refuses %o', (ref) => {
    expect(() => registryUrn(ref)).toThrow(/registry urn: invalid/);
  });
});

describe('service URNs', () => {
  // A document of an app slugged `service` is `service/{collection}/{key}`: three segments, where a
  // service URN has two, so neither can spell the other.
  const segments = (urn: string) => urn.slice('urn:apps.civitai.com:'.length).split('/');

  it('has two segments where a document has three', () => {
    const service = registryUrn({ kind: 'service', name: 'app-search', major: 1 });
    const doc = registryUrn({
      kind: 'document',
      slug: 'service',
      collection: 'app_search',
      key: '1',
    });
    expect(segments(service)).toEqual(['service', 'app-search@1']);
    expect(segments(doc)).toEqual(['service', 'app_search', '1']);
  });

  it('is not read as a collection schema, and is in the namespace', () => {
    const urn = registryUrn({ kind: 'service', name: 'app-search', major: 1 });
    expect(parseCollectionSchemaUrn(urn)).toBeNull();
    expect(urnNamespace(urn)).toBe('apps.civitai.com');
  });
});

describe('parseCollectionSchemaUrn', () => {
  it('reads back what the builder writes', () => {
    expect(
      parseCollectionSchemaUrn('urn:schema:apps.civitai.com:pixel-garden/seed_packs@v12')
    ).toEqual({
      slug: 'pixel-garden',
      collection: 'seed_packs',
      major: 12,
    });
  });

  it('the longest names the store allows still parse', () => {
    const slug = `a${'b'.repeat(62)}c`;
    const collection = `c${'d'.repeat(31)}`;
    expect(
      parseCollectionSchemaUrn(`urn:schema:apps.civitai.com:${slug}/${collection}@v1`)
    ).toEqual({
      slug,
      collection,
      major: 1,
    });
  });

  it.each([
    `urn:schema:apps.civitai.com:${'a'.repeat(65)}/notes@v1`,
    `urn:schema:apps.civitai.com:orbit-notes/${'c'.repeat(33)}@v1`,
    'urn:schema:apps.civitai.com:app@v1',
    'urn:schema:other-apps:pixel-garden/seed_packs@v1',
    'urn:schema:apps.civitai.com:pixel-garden/seed_packs@v0',
    'urn:schema:apps.civitai.com:pixel-garden@v1',
    'urn:schema:apps.civitai.com:Pixel/seed_packs@v1',
    'urn:apps.civitai.com:pixel-garden/seed_packs/k1',
  ])('null for %s', (urn) => {
    expect(parseCollectionSchemaUrn(urn)).toBeNull();
  });
});

describe('urnNamespace', () => {
  it.each([
    ['urn:apps.civitai.com:app/pixel-garden', 'apps.civitai.com'],
    ['urn:schema:apps.civitai.com:app@v1', 'apps.civitai.com'],
    ['urn:huggingface:black-forest-labs/FLUX.3-dev@a1b2c3d', 'huggingface'],
    ['urn:schema:elsewhere.example:model@v1', 'elsewhere.example'],
    // The reserved `schema` namespace names no origin, and neither does a URN with nothing after it.
    ['urn:schema:apps.civitai.com', null],
    ['urn:apps.civitai.com:', null],
    ['urn::app/x', null],
    ['https://json-schema.org/draft/2020-12/schema', null],
    ['pixel-garden', null],
  ])('%s → %s', (urn, ns) => {
    expect(urnNamespace(urn)).toBe(ns);
  });
});

describe('viewerSchemaUrn / parseViewerSchemaUrn (the per-viewer stream, viewer-feed.ts)', () => {
  it('round-trips, and is the literal shape app-data-go builds', () => {
    const urn = viewerSchemaUrn({ slug: 'bench-board-9', collection: 'votes_v2', major: 7 });
    expect(urn).toBe('urn:schema:apps.civitai.com:bench-board-9/votes_v2.viewer@v7');
    expect(parseViewerSchemaUrn(urn)).toEqual({
      slug: 'bench-board-9',
      collection: 'votes_v2',
      major: 7,
    });
  });

  it('🔴 a per-viewer URN is never a collection-schema URN, and no collection-schema URN is a per-viewer one', () => {
    const viewer = 'urn:schema:apps.civitai.com:bench-board-9/votes_v2.viewer@v7';
    const plain = 'urn:schema:apps.civitai.com:bench-board-9/votes_v2@v7';
    expect(parseCollectionSchemaUrn(viewer)).toBeNull();
    expect(parseViewerSchemaUrn(plain)).toBeNull();
    // Positive control: each parser reads its own shape.
    expect(parseCollectionSchemaUrn(plain)).not.toBeNull();
    expect(parseViewerSchemaUrn(viewer)).not.toBeNull();
  });

  it.each([
    'urn:schema:apps.civitai.com:bench-board-9/votes.viewer@v0',
    'urn:schema:apps.civitai.com:bench-board-9/votes.viewer',
    'urn:schema:apps.civitai.com:bench-board-9/votes.other@v1',
    'urn:schema:apps.civitai.com:bench-board-9/votes.viewer.viewer@v1',
    'urn:schema:apps.civitai.com:Bench/votes.viewer@v1',
    'urn:schema:other-apps:bench-board-9/votes.viewer@v1',
    `urn:schema:apps.civitai.com:bench-board-9/${'c'.repeat(33)}.viewer@v1`,
  ])('null for %s', (urn) => {
    expect(parseViewerSchemaUrn(urn)).toBeNull();
  });
});

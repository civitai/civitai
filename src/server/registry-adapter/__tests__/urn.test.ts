import { describe, expect, it } from 'vitest';
import { parseCollectionSchemaUrn, registryUrn, urnNamespace } from '~/server/registry-adapter/urn';

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
  ] as const)('refuses %o', (ref) => {
    expect(() => registryUrn(ref)).toThrow(/registry urn: invalid/);
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

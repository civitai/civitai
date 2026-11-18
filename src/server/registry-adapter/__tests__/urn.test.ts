import { describe, expect, it } from 'vitest';
import {
  parseCollectionSchemaUrn,
  parseOwnedDocumentUrn,
  registryUrn,
  urnNamespace,
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

// A handle as `ownerHandle` issues it: 22 base64url characters, the last one of `AQgw`.
const HANDLE = 'Zb-suruP-fFtbvjjunifdw';

describe('owned-document URNs', () => {
  it('builds the owner segment between the collection and the key', () => {
    expect(
      registryUrn({
        kind: 'owned-document',
        slug: 'pixel-garden',
        collection: 'seed_packs',
        handle: HANDLE,
        key: '01J:Ab.c-9',
      })
    ).toBe('urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/01J:Ab.c-9');
  });

  it('round-trips build → parse → build, at the longest names too', () => {
    const refs = [
      { slug: 'pixel-garden', collection: 'seed_packs', handle: HANDLE, key: '01J:Ab.c-9' },
      {
        slug: `a${'b'.repeat(62)}c`,
        collection: `c${'d'.repeat(31)}`,
        handle: '3Uipx1H4DxzUWDg9kOP_pA',
        key: 'k'.repeat(128),
      },
    ];
    for (const ref of refs) {
      const urn = registryUrn({ kind: 'owned-document', ...ref });
      const parsed = parseOwnedDocumentUrn(urn);
      expect(parsed).toEqual(ref);
      if (!parsed) throw new Error('unreachable: parsed is null');
      expect(registryUrn({ kind: 'owned-document', ...parsed })).toBe(urn);
    }
    expect(registryUrn({ kind: 'owned-document', ...refs[1] }).length).toBe(270);
  });

  it.each([
    { handle: 'Zb-suruP-fFtbvjjunifdB' }, // last character not canonical
    { handle: 'Zb-suruP-fFtbvjjunifw' }, // 21 characters
    { handle: 'Zb-suruP-fFtbvjjunifdww' }, // 23 characters
    { handle: 'Zb+suruP/fFtbvjjunifdw' }, // base64, not base64url
    { handle: '48213' }, // a user id is not a handle
    { key: 'a/b' },
    { collection: 'Seed' },
  ])('refuses %o', (over) => {
    expect(() =>
      registryUrn({
        kind: 'owned-document',
        slug: 'pixel-garden',
        collection: 'seed_packs',
        handle: HANDLE,
        key: 'pk-31',
        ...over,
      })
    ).toThrow(/registry urn: invalid/);
  });

  it.each([
    // A document URN with no owner segment.
    'urn:apps.civitai.com:pixel-garden/seed_packs/pk-31',
    // One segment too many, or empty ones.
    'urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/pk-31/x',
    'urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/',
    'urn:apps.civitai.com:pixel-garden//Zb-suruP-fFtbvjjunifdw/pk-31',
    // Another namespace, a schema URN, no `urn:`.
    'urn:other-apps:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/pk-31',
    'urn:schema:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/pk-31',
    'apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/pk-31',
    // A malformed handle: not canonical, short, long, base64, a user id.
    'urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdB/pk-31',
    'urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifw/pk-31',
    'urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdww/pk-31',
    'urn:apps.civitai.com:pixel-garden/seed_packs/Zb+suruP-fFtbvjjunifdw/pk-31',
    'urn:apps.civitai.com:pixel-garden/seed_packs/48213/pk-31',
    // A malformed slug, collection or key, and trailing whitespace.
    'urn:apps.civitai.com:Pixel/seed_packs/Zb-suruP-fFtbvjjunifdw/pk-31',
    'urn:apps.civitai.com:pixel-garden/9seed/Zb-suruP-fFtbvjjunifdw/pk-31',
    'urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/pk@31',
    `urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/${'k'.repeat(129)}`,
    'urn:apps.civitai.com:pixel-garden/seed_packs/Zb-suruP-fFtbvjjunifdw/pk-31\n',
    // The app and release URNs.
    'urn:apps.civitai.com:app/pixel-garden',
    'urn:apps.civitai.com:app/pixel-garden@1.0.0',
  ])('parse: null for %j', (urn) => {
    expect(parseOwnedDocumentUrn(urn)).toBeNull();
  });
});

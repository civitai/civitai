import { describe, expect, it } from 'vitest';
import { registryUrn } from '~/server/registry-adapter/urn';

describe('registryUrn', () => {
  it.each([
    [{ kind: 'app', slug: 'pixel-garden' }, 'urn:civitai-apps:app/pixel-garden'],
    [
      { kind: 'release', slug: 'pixel-garden', version: '2.10.3-beta.1' },
      'urn:civitai-apps:app/pixel-garden@2.10.3-beta.1',
    ],
    [
      { kind: 'collection-schema', slug: 'pixel-garden', collection: 'seed_packs', major: 3 },
      'urn:schema:civitai-apps:pixel-garden/seed_packs@v3',
    ],
    [{ kind: 'runtime', name: 'iframe', major: 1 }, 'urn:civitai-apps:runtime/iframe@1'],
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
  ] as const)('refuses %o', (ref) => {
    expect(() => registryUrn(ref)).toThrow(/registry urn: invalid/);
  });
});

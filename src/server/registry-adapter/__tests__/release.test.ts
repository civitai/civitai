import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovedRelease } from '~/server/registry-adapter/release';
import { publishedManifest, releaseBody } from '~/server/registry-adapter/release';

// Every value that must NOT leave carries a unique canary, so a leak anywhere in the body is
// found by searching the serialised body for it.
const FORBIDDEN_CANARIES = [
  'IFRAME-SRC-CANARY-81',
  'GOODS-CANARY-27',
  'BUILD-COMMAND-CANARY-44',
  'OUTPUT-DIR-CANARY-63',
  'JUSTIFICATION-CANARY-90',
  'SETTINGS-CANARY-12',
  'TRUST-CANARY-55',
  'PAGE-CANARY-38',
  'STORAGE-CANARY-19',
  'ANALYTICS-CANARY-46',
];

const MANIFEST = {
  blockId: 'lumen-forge',
  version: '3.4.1',
  name: 'Lumen Forge',
  tagline: 'Forge lumens nightly',
  repository: 'https://git.example/lumen-forge-src',
  contentRating: 'pg13',
  category: 'tools-cat-4',
  renderMode: 'iframe',
  minApiVersion: '1.7',
  scopes: ['apps:storage', 'ai:write:budgeted'],
  iframe: { src: 'https://bundles.example/IFRAME-SRC-CANARY-81', height: 640 },
  goods: [{ id: 'GOODS-CANARY-27', priceBuzz: 1300 }],
  buildCommand: 'BUILD-COMMAND-CANARY-44',
  outputDir: 'OUTPUT-DIR-CANARY-63',
  scopeJustifications: { 'apps:storage': 'JUSTIFICATION-CANARY-90' },
  publicSettingsKeys: ['SETTINGS-CANARY-12'],
  trustTier: 'TRUST-CANARY-55',
  page: { title: 'PAGE-CANARY-38' },
  storage: {
    collections: { cards: { visibility: 'private', schema: { title: 'STORAGE-CANARY-19' } } },
  },
  analytics: { events: { 'ANALYTICS-CANARY-46': {} } },
};

const PUBLISHED = {
  blockId: 'lumen-forge',
  version: '3.4.1',
  name: 'Lumen Forge',
  tagline: 'Forge lumens nightly',
  repository: 'https://git.example/lumen-forge-src',
  contentRating: 'pg13',
  category: 'tools-cat-4',
  renderMode: 'iframe',
  minApiVersion: '1.7',
  scopes: ['apps:storage', 'ai:write:budgeted'],
};

const RELEASE: ApprovedRelease = {
  slug: 'lumen-forge',
  version: '3.4.1',
  manifest: MANIFEST,
  bundleSha256: '5e1f0b7a9c3d2e4f6a8b0c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f',
  commitSha: '7c4a1e9b2d8f3a6c5e0b9d4f2a7c1e8b3d6f9a2c',
  sourceCommit: '0d3b8f1a6c9e2d5b7f4a1c8e3b6d9f2a5c7e1b4d',
  reviewedAt: new Date('2026-10-02T03:04:05.000Z'),
};

const body = () =>
  releaseBody({
    release: RELEASE,
    runtimeUrn: 'urn:apps.civitai.com:runtime/test-runtime@9',
    sourceRepoUrl: 'https://git.example/listing-repo-77',
    collections: { cards: 'urn:schema:apps.civitai.com:lumen-forge/cards@v2' },
  });

describe('release body — the manifest allowlist', () => {
  it('positive control: every canary is in the input, so the search below can find one', () => {
    const input = JSON.stringify(MANIFEST);
    for (const canary of FORBIDDEN_CANARIES) expect(input).toContain(canary);
  });

  it('🔴 no forbidden field reaches the body', () => {
    const out = JSON.stringify(body());
    expect(FORBIDDEN_CANARIES.filter((canary) => out.includes(canary))).toEqual([]);
  });

  it('publishes exactly the allowlisted fields', () => {
    expect(publishedManifest(MANIFEST)).toEqual(PUBLISHED);
  });

  it('an allowlisted field of the wrong shape is dropped, not copied', () => {
    expect(
      publishedManifest({
        name: { src: 'NESTED-CANARY-71' },
        scopes: ['apps:storage', { smuggled: 'NESTED-CANARY-72' }],
        version: 4,
      })
    ).toEqual({});
  });

  it('the whole body, with provenance', () => {
    expect(body()).toEqual({
      app: 'urn:apps.civitai.com:app/lumen-forge',
      version: '3.4.1',
      manifest: PUBLISHED,
      manifestHash: createHash('sha256')
        .update(
          '{"blockId":"lumen-forge","category":"tools-cat-4","contentRating":"pg13","minApiVersion":"1.7","name":"Lumen Forge","renderMode":"iframe","repository":"https://git.example/lumen-forge-src","scopes":["apps:storage","ai:write:budgeted"],"tagline":"Forge lumens nightly","version":"3.4.1"}'
        )
        .digest('hex'),
      runtime: 'urn:apps.civitai.com:runtime/test-runtime@9',
      contentRating: 'pg13',
      bundleSha256: '5e1f0b7a9c3d2e4f6a8b0c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f',
      source: {
        repo: 'https://git.example/listing-repo-77',
        commit: '7c4a1e9b2d8f3a6c5e0b9d4f2a7c1e8b3d6f9a2c',
        claimedCommit: '0d3b8f1a6c9e2d5b7f4a1c8e3b6d9f2a5c7e1b4d',
      },
      collections: { cards: 'urn:schema:apps.civitai.com:lumen-forge/cards@v2' },
      releasedAt: '2026-10-02T03:04:05.000Z',
    });
  });

  it('absent provenance is omitted rather than null', () => {
    const out = releaseBody({
      release: {
        ...RELEASE,
        bundleSha256: null,
        commitSha: null,
        sourceCommit: null,
        reviewedAt: null,
      },
      runtimeUrn: 'urn:apps.civitai.com:runtime/test-runtime@9',
      sourceRepoUrl: null,
      collections: {},
    });
    expect(Object.keys(out).sort()).toEqual([
      'app',
      'contentRating',
      'manifest',
      'manifestHash',
      'runtime',
      'version',
    ]);
  });
});

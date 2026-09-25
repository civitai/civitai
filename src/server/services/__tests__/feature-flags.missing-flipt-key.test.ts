import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import snapshot from './fixtures/flipt-store-scope.snapshot.json';
import { startFliptFixtureServer, type FliptFixtureServer } from './fixtures/flipt-fixture-server';

/**
 * The evaluator is the REAL `createFliptClient` + wasm engine against a fixture snapshot that
 * omits both keys, so "the key is missing" is produced by the engine, not asserted by a stub.
 * The same propositions are pinned against a stubbed `isFliptSync` in `user-hubs-flag-gate` and
 * `feed-tag-bar-flag-gate`, which sweep more principals but cannot witness the engine's `null`.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

let server: FliptFixtureServer;

vi.mock('~/server/flipt/client', async () => {
  const { buildRealFliptClientMock } = await import('./fixtures/flipt-fixture-server');
  return buildRealFliptClientMock('__TEST_FLIPT_URL');
});

beforeAll(async () => {
  server = await startFliptFixtureServer(snapshot);
  process.env.__TEST_FLIPT_URL = server.url;
});

afterAll(async () => {
  await server.close();
});

describe('a flag whose Flipt key does not exist falls back to static availability', () => {
  it('INSTRUMENT CONTROL: the engine is live and the two keys under test really are absent', async () => {
    const { ensureFliptInitialized, isFliptSync } = await import('~/server/flipt/client');
    const { buildFliptContext } = await import('~/server/services/feature-flags.service');
    await ensureFliptInitialized();
    const anon = buildFliptContext(undefined);

    expect(server.received.length).toBeGreaterThan(0);
    // `isEnabledSync` returns null for BOTH "flag not found" and "client not initialized", so a
    // present key answering with a boolean is what makes the two nulls below attributable.
    expect(isFliptSync('app-blocks-enabled', 'anonymous', anon)).toBe(false);
    expect(isFliptSync('image-search', 'anonymous', anon)).toBe(null);
    expect(isFliptSync('hi-dpi-previews', 'anonymous', anon)).toBe(null);
  });

  it('`availability: []` stays OFF on the server path', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    expect(features.imageSearch).toBeFalsy();
  });

  it('`availability: ["public"]` stays ON on the server path', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    expect(features.hiDpiPreviews).toBe(true);
  });
});

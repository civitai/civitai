import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import snapshot from './fixtures/flipt-store-scope.snapshot.json';
import { startFliptFixtureServer, type FliptFixtureServer } from './fixtures/flipt-fixture-server';

/**
 * A flag whose `fliptKey` does not exist in Flipt must be decided by the registry's static
 * `availability`, in both directions: `[]` stays off, `['public']` stays on. The evaluator is
 * the REAL `createFliptClient` + wasm engine against a fixture snapshot that omits both keys,
 * so "the key is missing" is produced by the engine rather than asserted by a stub.
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
    await ensureFliptInitialized();

    expect(server.received.length).toBeGreaterThan(0);
    // A key the fixture DOES carry answers with a boolean, so a `null` below is the engine
    // reporting "flag not found" and not an uninitialized client.
    expect(isFliptSync('app-blocks-enabled', 'anonymous', {})).toBe(false);
    expect(isFliptSync('image-search', 'anonymous', {})).toBe(null);
    expect(isFliptSync('hi-dpi-previews', 'anonymous', {})).toBe(null);
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

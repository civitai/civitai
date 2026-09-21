import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sourceSnapshot from './fixtures/flipt-store-scope.snapshot.json';
import {
  deriveSnapshotFromFlagShape,
  startFliptFixtureServer,
  type FliptFixtureServer,
} from './fixtures/flipt-fixture-server';

/**
 * Both flags are served with a base value opposite to what static evaluation would give, so each
 * `expect` can only pass if the Flipt answer won. `user-hubs-flag-gate` and `feed-tag-bar-flag-gate`
 * pin the same precedence against a stubbed `isFliptSync`; this runs it through the real engine.
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
  const snapshot = deriveSnapshotFromFlagShape(sourceSnapshot, 'app-blocks-enabled', [
    { key: 'image-search', enabled: true },
    { key: 'hi-dpi-previews', enabled: false },
  ]);
  server = await startFliptFixtureServer(snapshot);
  process.env.__TEST_FLIPT_URL = server.url;
});

afterAll(async () => {
  await server.close();
});

describe('a flag that exists in Flipt is authoritative over static availability', () => {
  it('INSTRUMENT CONTROL: the engine is live and both keys are present', async () => {
    const { ensureFliptInitialized, isFliptSync } = await import('~/server/flipt/client');
    const { buildFliptContext } = await import('~/server/services/feature-flags.service');
    await ensureFliptInitialized();
    // The context the service itself builds for an anonymous request — probing with a different
    // one would leave a future segment keyed on `isLoggedIn` invisible here.
    const anon = buildFliptContext(undefined);

    expect(server.received.length).toBeGreaterThan(0);
    expect(isFliptSync('image-search', 'anonymous', anon)).toBe(true);
    expect(isFliptSync('hi-dpi-previews', 'anonymous', anon)).toBe(false);
  });

  it('Flipt ON overrides a static-OFF registry entry', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    expect(features.imageSearch).toBe(true);
  });

  it('Flipt OFF overrides a static-ON registry entry', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    expect(features.hiDpiPreviews).toBeFalsy();
  });
});

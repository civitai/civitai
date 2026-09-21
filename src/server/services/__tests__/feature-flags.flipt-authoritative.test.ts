import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sourceSnapshot from './fixtures/flipt-store-scope.snapshot.json';
import {
  deriveSnapshotFromFlagShape,
  startFliptFixtureServer,
  type FliptFixtureServer,
} from './fixtures/flipt-fixture-server';

/**
 * The companion to `feature-flags.missing-flipt-key.test.ts`: once the key EXISTS, Flipt decides
 * and the static `availability` is not consulted — in both directions. Both flags are served
 * with a base value opposite to what static evaluation would give, so each `expect` can only
 * pass if the Flipt answer won.
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
  // `image-search` is `availability: []` (static OFF) and `hi-dpi-previews` is
  // `availability: ['public']` (static ON); the snapshot inverts both.
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
    await ensureFliptInitialized();

    expect(server.received.length).toBeGreaterThan(0);
    expect(isFliptSync('image-search', 'anonymous', {})).toBe(true);
    expect(isFliptSync('hi-dpi-previews', 'anonymous', {})).toBe(false);
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

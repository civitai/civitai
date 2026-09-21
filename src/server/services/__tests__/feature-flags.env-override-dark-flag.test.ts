import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import snapshot from './fixtures/flipt-store-scope.snapshot.json';
import { startFliptFixtureServer, type FliptFixtureServer } from './fixtures/flipt-fixture-server';

/**
 * A `FEATURE_FLAG_<KEY>` variable must not switch on a flag the registry declares dark
 * (`availability: []`). It used to, and it also removed the key from Flipt evaluation, so a
 * stale variable both shipped a feature the registry said was off and made the flag's own
 * `fliptKey` unable to turn it back off.
 *
 * `image-search` is the worked case: `availability: []`, no such flag in Flipt, and a
 * long-lived `FEATURE_FLAG_IMAGE_SEARCH` variable left over from before the Flipt migration.
 */

vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  // Read once, at module load, by `getEnvOverrides`.
  process.env.FEATURE_FLAG_IMAGE_SEARCH = 'public';
  process.env.FEATURE_FLAG_CIVITAI_LINK = 'public';
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

describe('an env override cannot lift a flag the registry declares dark', () => {
  it('INSTRUMENT CONTROL: the engine is live and `image-search` is absent from Flipt', async () => {
    const { ensureFliptInitialized, isFliptSync } = await import('~/server/flipt/client');
    await ensureFliptInitialized();

    expect(server.received.length).toBeGreaterThan(0);
    expect(isFliptSync('app-blocks-enabled', 'anonymous', {})).toBe(false);
    expect(isFliptSync('image-search', 'anonymous', {})).toBe(null);
  });

  it('`FEATURE_FLAG_IMAGE_SEARCH=public` does not turn on an `availability: []` flag', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    expect(features.imageSearch).toBeFalsy();
  });

  it('CONTROL: an env override still applies to a flag with static availability', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    // `civitaiLink` is declared `['mod', 'member']`, so an anonymous request resolves it false
    // without the override. Its `true` here is the override being honoured.
    expect(features.civitaiLink).toBe(true);
  });
});

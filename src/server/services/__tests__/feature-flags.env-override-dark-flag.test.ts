import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sourceSnapshot from './fixtures/flipt-store-scope.snapshot.json';
import {
  deriveSnapshotFromFlagShape,
  startFliptFixtureServer,
  type FliptFixtureServer,
} from './fixtures/flipt-fixture-server';

/**
 * The full matrix of what a `FEATURE_FLAG_<KEY>` variable may and may not do, one flag per case.
 * Two are changes — a dark flag with a `fliptKey` now ignores its override whether that override
 * grants access or nothing at all, so Flipt decides in both cases. The other three pin behaviour
 * that must NOT move, and each is chosen so that a plausible over-broad rewrite of the guard
 * turns exactly it red.
 */

// The warning under test is emitted at MODULE LOAD, so the spy has to be installed before the
// first `await import(...)` — `vi.hoisted` is the only hook that runs early enough.
const { warnings, realWarn } = vi.hoisted(() => {
  process.env.SERVER_DOMAIN_GREEN = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE = 'civitai.blue';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
  // All read once, at module load, by `getEnvOverrides`.
  process.env.FEATURE_FLAG_IMAGE_SEARCH = 'public';
  process.env.FEATURE_FLAG_CIVITAI_LINK = 'public';
  process.env.FEATURE_FLAG_API_KEY_BUZZ_LIMIT = 'public';
  process.env.FEATURE_FLAG_COINBASE_PAYMENTS = 'public';
  // Parses to an empty availability — `getEnvOverrides` keeps no unrecognised token.
  process.env.FEATURE_FLAG_USER_HUBS = 'nonsense';

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  return { warnings, realWarn };
});

let server: FliptFixtureServer;

vi.mock('~/server/flipt/client', async () => {
  const { buildRealFliptClientMock } = await import('./fixtures/flipt-fixture-server');
  return buildRealFliptClientMock('__TEST_FLIPT_URL');
});

beforeAll(async () => {
  // `user-hubs` is served ON so that "pinned out of Flipt" is observable: a flag that reached
  // Flipt would come back true, and every assertion below expects false.
  const snapshot = deriveSnapshotFromFlagShape(sourceSnapshot, 'app-blocks-enabled', [
    { key: 'app-blocks-enabled', enabled: false },
    { key: 'user-hubs', enabled: true },
  ]);
  server = await startFliptFixtureServer(snapshot);
  process.env.__TEST_FLIPT_URL = server.url;
});

afterAll(async () => {
  await server.close();
  console.warn = realWarn;
  // Inert under the `unit` project's per-file process isolation, but `getEnvOverrides` reads
  // `process.env` at module load: under a shared-worker pool these would silently re-scope every
  // later file's registry.
  for (const key of Object.keys(process.env).filter((k) => k.startsWith('FEATURE_FLAG_'))) {
    delete process.env[key];
  }
});

describe('what a FEATURE_FLAG_<KEY> override may and may not do', () => {
  it('INSTRUMENT CONTROL: the engine is live, and the keys under test are present or absent as intended', async () => {
    const { ensureFliptInitialized, isFliptSync } = await import('~/server/flipt/client');
    const { buildFliptContext } = await import('~/server/services/feature-flags.service');
    await ensureFliptInitialized();
    const anon = buildFliptContext(undefined);

    expect(server.received.length).toBeGreaterThan(0);
    // A present key answers with a boolean, so a `null` below is the engine reporting
    // "flag not found" and not an uninitialized client.
    expect(isFliptSync('app-blocks-enabled', 'anonymous', anon)).toBe(false);
    expect(isFliptSync('user-hubs', 'anonymous', anon)).toBe(true);
    expect(isFliptSync('image-search', 'anonymous', anon)).toBe(null);
    expect(isFliptSync('api-key-buzz-limit', 'anonymous', anon)).toBe(null);
  });

  it('does NOT switch on a dark flag that has a fliptKey', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    // `imageSearch` is `{ availability: [], fliptKey: 'image-search' }`.
    expect(features.imageSearch).toBeFalsy();
  });

  it('says so when it discards one, naming the flag and the way to change it', async () => {
    await import('~/server/services/feature-flags.service');

    const discarded = warnings.filter((w) => w.includes('[feature-flags]'));
    // Named, so an operator who set the variable can find out why nothing happened.
    expect(discarded.some((w) => w.includes('"imageSearch"'))).toBe(true);
    expect(discarded.some((w) => w.includes('FLIPT_LOCAL_OVERRIDES=image-search=on'))).toBe(true);
    // The other four overrides in this file were applied, so they must NOT be reported.
    for (const applied of ['civitaiLink', 'apiKeyBuzzLimit', 'coinbasePayments']) {
      expect(discarded.some((w) => w.includes(`"${applied}"`))).toBe(false);
    }
  });

  it('CONTROL: still applies to a flag with static availability and no fliptKey', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    // Chosen because it is role-gated, so an anonymous request resolves it false without the
    // override.
    expect(features.civitaiLink).toBe(true);
  });

  it('CONTROL: still applies to a flag with static availability that HAS a fliptKey', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    // Separates "declared dark" from "has a fliptKey" as the reason an override is skipped:
    // `apiKeyBuzzLimit` is `{ availability: ['mod'], fliptKey: 'api-key-buzz-limit' }`, so a guard
    // keyed on the fliptKey alone would leave an anonymous request without it.
    expect(features.apiKeyBuzzLimit).toBe(true);
  });

  it('CONTROL: still applies to a dark flag that has NO fliptKey — it has no other switch', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    // `coinbasePayments: []` in the legacy array form. Ignoring its override would make the flag
    // unconditionally false everywhere, with no runtime lever, on a payment path.
    expect(features.coinbasePayments).toBe(true);
  });

  it('is ignored even when it grants nothing, leaving Flipt to decide', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    // `getEnvOverrides` keeps no unrecognised token, so `FEATURE_FLAG_USER_HUBS=nonsense` yields
    // an empty availability. That used to be applied, which pinned the flag out of its Flipt
    // rollout — indistinguishable from a typo, and the same invisible-override class this guard
    // closes. Flipt serves `user-hubs` ON, so `true` here can only come from Flipt being consulted.
    expect(features.userHubs).toBe(true);
  });
});

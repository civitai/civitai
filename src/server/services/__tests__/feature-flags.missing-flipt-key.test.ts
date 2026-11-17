import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import snapshot from './fixtures/flipt-store-scope.snapshot.json';
import { startFliptFixtureServer, type FliptFixtureServer } from './fixtures/flipt-fixture-server';
import type { SessionUser } from '~/types/session';

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

describe('a flag whose Flipt key does not exist, and that does not require it, falls back to static availability', () => {
  it('INSTRUMENT CONTROL: the engine is live and the two keys under test really are absent', async () => {
    const { ensureFliptInitialized, isFliptSync } = await import('~/server/flipt/client');
    const { buildFliptContext } = await import('~/server/services/feature-flags.service');
    await ensureFliptInitialized();
    const anon = buildFliptContext(undefined);

    expect(server.received.length).toBeGreaterThan(0);
    // `isEnabledSync` returns null for BOTH "flag not found" and "client not initialized", so a
    // present key answering with a boolean is what makes the two nulls below attributable.
    expect(isFliptSync('app-blocks-enabled', 'anonymous', anon)).toBe(false);
    expect(isFliptSync('trpc-unified-batch-window', 'anonymous', anon)).toBe(null);
    expect(isFliptSync('hi-dpi-previews', 'anonymous', anon)).toBe(null);
  });

  it('`availability: []` stays OFF on the server path', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    expect(features.trpcUnifiedBatchWindow).toBeFalsy();
  });

  it('`availability: ["public"]` stays ON on the server path', async () => {
    const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');
    const features = await getFeatureFlagsAsync({});

    expect(features.hiDpiPreviews).toBe(true);
  });
});

describe('a flag that requires its Flipt key is off while the key is missing', () => {
  const moderator = { id: 101, isModerator: true, tier: 'free' } as SessionUser;

  it('INSTRUMENT CONTROL: the key is absent from a live engine', async () => {
    const { ensureFliptInitialized, getFliptClientSync, isFliptSync } = await import(
      '~/server/flipt/client'
    );
    await ensureFliptInitialized();
    expect(getFliptClientSync()).not.toBeNull();
    expect(isFliptSync('storyline-text', String(moderator.id), {})).toBe(null);
  });

  it('is off for a moderator its static availability would admit, and counts as decided', async () => {
    const { getFeatureFlagsAsync, isFliptDecisive } = await import(
      '~/server/services/feature-flags.service'
    );
    const features = await getFeatureFlagsAsync({ user: moderator });

    expect(features.storylineText).toBeFalsy();
    // Same principal, a flag without the marker: the static fallback still admits the moderator.
    expect(features.storylines).toBe(true);
    expect(await isFliptDecisive(['storylineText'], moderator)).toBe(true);
  });
});

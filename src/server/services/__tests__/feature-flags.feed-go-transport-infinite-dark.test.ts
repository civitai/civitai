import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => false),
  isFliptSync: vi.fn((_key?: string): boolean | null => null),
  getFliptClientSync: vi.fn((): unknown => null),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mocks.isFlipt,
  isFliptSync: mocks.isFliptSync,
  ensureFliptInitialized: mocks.ensureFliptInitialized,
  getFliptClientSync: mocks.getFliptClientSync,
}));

import type * as FliptClient from '~/server/flipt/client';
import type { SessionUser } from '~/types/session';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';

/**
 * `feedGoTransportInfinite` moves a signed-in browser's `image.getInfinite` to `/api/trpc-go`, so it
 * ships dark for everyone, moderators included, and only its own Flipt key turns it on: `['mod']`
 * would move every moderator the moment the code deploys, `['public']` everyone whenever Flipt is
 * unreachable. Its key is its own, so the gallery and model.getAll flags never turn it on.
 */
describe('feedGoTransportInfinite is dark until its own Flipt key turns it on', () => {
  const mod = { id: 9411, isModerator: true, tier: 'free' } as SessionUser;

  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for a moderator and for an anonymous visitor when Flipt has no answer', async () => {
    const modFlags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same moderator context does switch on a mod-available flag, so an absent flag
    // below is the declaration speaking, not a context that grants nothing.
    expect(modFlags.creatorShop).toBe(true);
    expect(modFlags.feedGoTransportInfinite).toBeUndefined();

    const anonFlags = await getFeatureFlagsAsync({ host: 'civitai.com' });
    // Control: a public flag is on for the same anonymous context.
    expect(anonFlags.canWrite).toBe(true);
    expect(anonFlags.feedGoTransportInfinite).toBeUndefined();
  });

  it('the gallery and model.getAll keys on do not turn it on', async () => {
    mocks.isFliptSync.mockImplementation(
      (key?: string) =>
        key === 'feed-go-transport' || key === 'feed-go-transport-model-getall' || null
    );
    // A different user: the registry caches per user.
    const tester = { id: 9412, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: tester });
    // Control: the other two transport flags did read their keys as on.
    expect(flags.feedGoTransport).toBe(true);
    expect(flags.feedGoTransportModelGetAll).toBe(true);
    expect(flags.feedGoTransportInfinite).toBeFalsy();
  });

  it('is on when its own Flipt key says so', async () => {
    // Key-aware, so a typo in `fliptKey` (the key the rollout is created under) turns this red.
    mocks.isFliptSync.mockImplementation(
      (key?: string) => key === 'feed-go-transport-infinite' || null
    );
    const tester = { id: 9413, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: tester });
    expect(flags.feedGoTransportInfinite).toBe(true);
    // The other transport flags stay off on the same answer.
    expect(flags.feedGoTransport).toBeFalsy();
    expect(flags.feedGoTransportModelGetAll).toBeFalsy();
  });
});

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
 * `createServerSideProps` reads `clientNavSkipsPrefetch` to decide whether a client navigation skips
 * the SSG prefetch. It ships dark, moderators included, so the deploy changes nothing and the
 * `client-nav-skips-prefetch` Flipt rollout is the only on-switch.
 */
describe('clientNavSkipsPrefetch is dark until Flipt turns it on', () => {
  const mod = { id: 9111, isModerator: true, tier: 'free' } as SessionUser;

  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for a moderator when Flipt has no answer', async () => {
    const flags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same context switches on a mod-available flag, so the absence below is the
    // declaration speaking.
    expect(flags.creatorShop).toBe(true);
    expect(flags.clientNavSkipsPrefetch).toBeUndefined();
  });

  it('is on when its own Flipt key says so', async () => {
    // Key-aware, so a typo in `fliptKey` leaves the flag off and turns this red.
    mocks.isFliptSync.mockImplementation(
      (key: string) => key === 'client-nav-skips-prefetch' || null
    );
    const tester = { id: 9313, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: tester });
    expect(flags.clientNavSkipsPrefetch).toBe(true);
  });
});

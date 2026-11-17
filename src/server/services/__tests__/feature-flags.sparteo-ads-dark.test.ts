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

describe('sparteoAds is dark until Flipt turns it on', () => {
  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for a moderator and for anonymous visitors when Flipt has no answer', async () => {
    const mod = { id: 9111, isModerator: true, tier: 'free' } as SessionUser;
    const modFlags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same context switches on a mod-available flag.
    expect(modFlags.creatorShop).toBe(true);
    expect(modFlags.sparteoAds).toBeFalsy();
    expect((await getFeatureFlagsAsync({})).sparteoAds).toBeFalsy();
  });

  it('is on when its own Flipt key says so', async () => {
    mocks.isFliptSync.mockImplementation((key?: string) => key === 'sparteo-ads' || null);
    const viewer = { id: 9313, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: viewer });
    expect(flags.sparteoAds).toBe(true);
    // A host the off case never used: the flag cache keys anonymous results by host.
    expect((await getFeatureFlagsAsync({ host: 'civitai.com' })).sparteoAds).toBe(true);
  });
});

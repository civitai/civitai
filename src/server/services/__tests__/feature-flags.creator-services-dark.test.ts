import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isFlipt: vi.fn(async () => false),
  isFliptSync: vi.fn((): boolean | null => null),
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
 * `creatorServices` moves real Buzz through escrow, so it ships dark for everyone, moderators
 * included, and only the `creator-services` Flipt flag turns it on. If you are about to change its
 * availability to `['mod']`: that would switch escrow on for every moderator the moment the code
 * deploys, before anyone decided to.
 */
describe('creatorServices is dark until Flipt turns it on', () => {
  const mod = { id: 9101, isModerator: true, tier: 'free' } as SessionUser;

  it('is off for a moderator when Flipt has no answer', async () => {
    const flags = await getFeatureFlagsAsync({ user: mod });
    // Control: the same moderator context does switch on a mod-available flag, so an absent flag below
    // is the declaration speaking, not a context that grants nothing.
    expect(flags.creatorShop).toBe(true);
    // The payload is sparse: an off flag is absent, not `false`.
    expect(flags.creatorServices).toBeUndefined();
  });

  it('is on when Flipt says so', async () => {
    mocks.isFliptSync.mockImplementation(() => true);
    // A different user: the registry caches per user.
    const tester = { id: 9303, isModerator: false, tier: 'free' } as SessionUser;
    const flags = await getFeatureFlagsAsync({ user: tester });
    expect(flags.creatorServices).toBe(true);
    mocks.isFliptSync.mockImplementation(() => null);
  });
});

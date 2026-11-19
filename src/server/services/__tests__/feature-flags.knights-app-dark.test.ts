import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

const mocks = vi.hoisted(() => ({
  isFliptSync: vi.fn((_key?: string): boolean | null => null),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(async () => false),
  isFliptSync: mocks.isFliptSync,
  ensureFliptInitialized: vi.fn(async () => undefined),
  getFliptClientSync: vi.fn(() => null),
}));

import type { SessionUser } from '~/types/session';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { getFeatureFliptKey, getFeatureFlagsAsync } from '~/server/services/feature-flags.service';

// `knightsApp` follows the Knights app's own access flag: dark for everyone, moderators included,
// until Flipt turns it on for that user.
describe('knightsApp is dark until its Flipt flag says so', () => {
  afterEach(() => {
    mocks.isFliptSync.mockReset();
    mocks.isFliptSync.mockImplementation(() => null);
  });

  it('is off for a moderator when Flipt has no answer', async () => {
    const mod = { id: 9201, isModerator: true, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user: mod })).knightsApp).toBeUndefined();
  });

  it('is on when knights-of-new-order-app says so', async () => {
    mocks.isFliptSync.mockImplementation(
      (key?: string) => key === 'knights-of-new-order-app' || null
    );
    const user = { id: 9202, isModerator: false, tier: 'free' } as SessionUser;
    expect((await getFeatureFlagsAsync({ user })).knightsApp).toBe(true);
  });

  it('is the same Flipt key the server-side cutover gate reads', () => {
    expect(getFeatureFliptKey('knightsApp')).toBe(FLIPT_FEATURE_FLAGS.KNIGHTS_APP);
  });
});

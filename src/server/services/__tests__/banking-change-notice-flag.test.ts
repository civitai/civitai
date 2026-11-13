import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockIsFliptSync } = vi.hoisted(() => ({ mockIsFliptSync: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: unknown[]) => mockIsFliptSync(...a),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import type { SessionUser } from '~/types/session';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';

// getFeatureFlags memoizes per context, so every case uses its own user id.
const user = (id: number, isModerator = false) =>
  ({ id, isModerator, tier: 'free' } as SessionUser);

beforeAll(async () => {
  mockIsFliptSync.mockReturnValue(null);
  await getFeatureFlagsAsync({ user: user(900, true) });
});

beforeEach(() => {
  mockIsFliptSync.mockReset();
});

describe('bankingChangeNotice flag', () => {
  it('is off for moderators and users alike while Flipt has no answer', async () => {
    mockIsFliptSync.mockReturnValue(null);

    expect((await getFeatureFlagsAsync({ user: user(901, true) })).bankingChangeNotice).toBeFalsy();
    expect((await getFeatureFlagsAsync({ user: user(902) })).bankingChangeNotice).toBeFalsy();
    expect(mockIsFliptSync).toHaveBeenCalledWith(
      'banking-change-notice',
      expect.anything(),
      expect.anything()
    );
  });

  it('turns on for a user when the banking-change-notice Flipt flag says so', async () => {
    mockIsFliptSync.mockImplementation((key: string) =>
      key === 'banking-change-notice' ? true : null
    );

    expect((await getFeatureFlagsAsync({ user: user(903) })).bankingChangeNotice).toBe(true);
  });
});

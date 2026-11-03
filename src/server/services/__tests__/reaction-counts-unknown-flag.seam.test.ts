import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The browser tests for the unknown-count badge mock `useFeatureFlags`, so they cannot
// see how the flag EVALUATES. That lives here: only the Flipt edge is stubbed, and the
// real registry + static fallback decide the answer.
//
// The flag has no Flipt key (the flag was never created), so its static `availability` is
// the whole answer. Any non-empty list there switches the badge on for some audience the
// moment it deploys. The same holds once a key is added back before the flag exists: the
// client's `isEnabledSync` returns null for an unknown key, which falls through to this list.

const { mockIsFliptSync } = vi.hoisted(() => ({ mockIsFliptSync: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: unknown[]) => mockIsFliptSync(...a),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import { getFeatureFlags, getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

// `getFeatureFlags` memoizes per user identity for 10s, so every case needs its own id or
// it reads the previous case's answer.
// Off is an ABSENT key, not `false` -- the registry only writes the keys that are on -- so
// the OFF cases assert "not true" rather than a representation.
let nextUserId = 5000;
const user = (over: Partial<{ isModerator: boolean; tier: string; permissions: string[] }> = {}) =>
  ({
    id: ++nextUserId,
    isModerator: false,
    tier: 'free',
    permissions: [],
    ...over,
  } as unknown as SessionUser);

const KEY = 'reaction-counts-unknown';
const FLAG = 'reactionCountsUnknown';

beforeAll(async () => {
  // The service imports its Flipt module lazily and skips the Flipt branch entirely until
  // it has loaded. Without this, "Flipt is not asked about this flag" would hold only
  // because Flipt was not loaded, not because the flag has no key.
  mockIsFliptSync.mockReturnValue(null);
  await getFeatureFlagsAsync({});
});

beforeEach(() => {
  mockIsFliptSync.mockReset();
});

describe('reactionCountsUnknown, which has no Flipt key', () => {
  it('stays OFF for a moderator', () => {
    mockIsFliptSync.mockReturnValue(null);

    expect(getFeatureFlags({ user: user({ isModerator: true }) })[FLAG]).not.toBe(true);
    // Pins the path: with no key, Flipt is not asked about this flag at all.
    expect(mockIsFliptSync.mock.calls.some(([flag]) => flag === KEY)).toBe(false);
    // ...while it was asked about others, so the stub is wired in.
    expect(mockIsFliptSync).toHaveBeenCalled();
  });

  it('stays OFF for an ordinary signed-in user', () => {
    mockIsFliptSync.mockReturnValue(null);

    expect(getFeatureFlags({ user: user() })[FLAG]).not.toBe(true);
  });

  it('stays OFF for an anonymous visitor', () => {
    mockIsFliptSync.mockReturnValue(null);

    expect(getFeatureFlags({})[FLAG]).not.toBe(true);
  });

  // The static fallback matches `user.tier` EXACTLY, so one paid tier does not stand in
  // for another: a gold user does not match a silver-only list. Each tier is its own case,
  // and each user is also a moderator holding an explicit grant, so any non-empty
  // availability -- a role, `member`, a tier, or `granted` -- turns at least one on.
  for (const tier of ['founder', 'bronze', 'silver', 'gold']) {
    it(`stays OFF for a ${tier} member who is also a moderator with an explicit grant`, () => {
      mockIsFliptSync.mockReturnValue(null);

      const privileged = user({ isModerator: true, tier, permissions: [FLAG] });
      expect(getFeatureFlags({ user: privileged })[FLAG]).not.toBe(true);
    });
  }
});

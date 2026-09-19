import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The browser tests for the unknown-count badge mock `useFeatureFlags`, so they cannot
// see how the flag EVALUATES. That lives here: only the Flipt edge is stubbed, and the
// real registry + static fallback decide the answer.
//
// The case that matters is a key Flipt has never heard of. The client's `isEnabledSync`
// swallows "flag not found" and returns null, which falls through to the flag's static
// `availability`. Any non-empty list there switches the badge on for some audience the
// moment it deploys, before anyone has created the flag.

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
  // it has loaded. Without this, the OFF cases would exercise "Flipt not loaded" rather
  // than "Flipt says the key does not exist" -- the same static fallback, but not the
  // scenario this file is about.
  mockIsFliptSync.mockReturnValue(null);
  await getFeatureFlagsAsync({});
});

beforeEach(() => {
  mockIsFliptSync.mockReset();
});

describe('reactionCountsUnknown while Flipt has never heard of the key', () => {
  it('stays OFF for a moderator', () => {
    mockIsFliptSync.mockReturnValue(null);

    expect(getFeatureFlags({ user: user({ isModerator: true }) })[FLAG]).not.toBe(true);
    // Pins the path: Flipt WAS asked for this key and answered not-found.
    expect(mockIsFliptSync.mock.calls.some(([flag]) => flag === KEY)).toBe(true);
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

describe('reactionCountsUnknown once Flipt knows the key', () => {
  it('CONTROL: Flipt IS consulted for this key, and its answer wins', () => {
    // Without this, the cases above would also pass if the stub were never reached -- a
    // fake that is not wired in answers "off" for every question.
    mockIsFliptSync.mockImplementation((flag: string) => (flag === KEY ? true : null));

    expect(getFeatureFlags({ user: user() })[FLAG]).toBe(true);
  });
});

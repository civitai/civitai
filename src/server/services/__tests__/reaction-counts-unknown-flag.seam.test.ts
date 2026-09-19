import { beforeEach, describe, expect, it, vi } from 'vitest';

// The browser tests for the unknown-count badge mock `useFeatureFlags`, so they cannot
// see how the flag EVALUATES. That lives here: only the Flipt edge is stubbed, and the
// real registry + static fallback decide the answer.
//
// The case that matters is a key Flipt has never heard of. The client's `isEnabledSync`
// swallows "flag not found" and returns null, which falls through to the flag's static
// `availability`. Declared `['mod']`, that would switch the badge on for every moderator
// the moment it deployed, before anyone created the flag.

const { mockIsFliptSync } = vi.hoisted(() => ({ mockIsFliptSync: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFliptSync: (...a: unknown[]) => mockIsFliptSync(...a),
  isFlipt: vi.fn(),
  getFliptVariant: vi.fn(),
  getFliptBoolean: vi.fn(),
  ensureFliptInitialized: vi.fn(async () => undefined),
  FLIPT_FEATURE_FLAGS: {},
}));

import { getFeatureFlags } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

// `getFeatureFlags` memoizes per user identity for 10s, so every case needs its own id or
// it reads the previous case's answer.
// Off is an ABSENT key, not `false` -- the registry only writes the keys that are on -- so
// the OFF cases assert "not true" rather than a representation.
let nextUserId = 5000;
const user = (isModerator: boolean) =>
  ({ id: ++nextUserId, isModerator, tier: 'free', permissions: [] } as unknown as SessionUser);

const KEY = 'reaction-counts-unknown';

beforeEach(() => {
  mockIsFliptSync.mockReset();
});

describe('reactionCountsUnknown', () => {
  it('stays OFF for a moderator while the key does not exist in Flipt', () => {
    mockIsFliptSync.mockReturnValue(null);

    expect(getFeatureFlags({ user: user(true) }).reactionCountsUnknown).not.toBe(true);
  });

  it('stays OFF for everyone else while the key does not exist in Flipt', () => {
    mockIsFliptSync.mockReturnValue(null);

    expect(getFeatureFlags({ user: user(false) }).reactionCountsUnknown).not.toBe(true);
  });

  it('CONTROL: Flipt IS consulted for this key, and its answer wins', () => {
    // Without this, the two cases above would also pass if the stub were never reached --
    // a fake that is not wired in answers "off" for every question.
    mockIsFliptSync.mockImplementation((flag: string) => (flag === KEY ? true : null));

    expect(getFeatureFlags({ user: user(false) }).reactionCountsUnknown).toBe(true);
    expect(mockIsFliptSync.mock.calls.some(([flag]) => flag === KEY)).toBe(true);
  });
});

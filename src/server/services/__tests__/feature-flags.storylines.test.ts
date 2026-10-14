import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Storylines ships dark: moderators and users granted the `storylines` permission only. Drives
 * the real registry and real `hasFeature`; only the Flipt edge is stubbed, and it answers `true`
 * for everything so a flag that wrongly consulted Flipt would open to every caller here.
 */

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

let nextId = 1;

const user = (over: Partial<SessionUser> = {}): SessionUser =>
  ({
    id: nextId++,
    showNsfw: false,
    blurNsfw: true,
    browsingLevel: 1,
    onboarding: 0,
    permissions: [],
    ...over,
  } as SessionUser);

// `getFeatureFlags` memoizes per identity and host for 10s, so every read gets a fresh host.
const storylinesFor = (who: SessionUser | undefined) =>
  !!getFeatureFlags({ user: who, host: `s${nextId++}.example` }).storylines;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFliptSync.mockReturnValue(true);
});

describe('storylines flag', () => {
  it('is on for moderators', () => {
    expect(storylinesFor(user({ isModerator: true }))).toBe(true);
  });

  it('is on for a user granted the storylines permission', () => {
    expect(storylinesFor(user({ permissions: ['storylines'] }))).toBe(true);
  });

  it('is off for a user granted some other permission', () => {
    expect(storylinesFor(user({ permissions: ['crucible'] }))).toBe(false);
  });

  it('is off for an ordinary signed-in user', () => {
    expect(storylinesFor(user())).toBe(false);
  });

  it('is off for an anonymous request', () => {
    expect(storylinesFor(undefined)).toBe(false);
  });
});

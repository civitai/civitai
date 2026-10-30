import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Storylines is Flipt-backed (key `storylines`) with `['mod', 'granted']` as the static fallback.
 * Drives the real registry and real `hasFeature`; only the Flipt edge is stubbed. `null` is what
 * `isFliptSync` answers when Flipt is down or the key is missing (pinned against the real engine
 * in feature-flags.missing-flipt-key.test.ts); a boolean is Flipt answering.
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

// `getFeatureFlags` memoizes per identity and host, so every read gets a fresh host.
const storylinesFor = (who: SessionUser | undefined) =>
  !!getFeatureFlags({ user: who, host: `s${nextId++}.example` }).storylines;

beforeEach(() => {
  vi.clearAllMocks();
});

const mod = () => user({ isModerator: true });

describe('storylines flag: Flipt down or the key missing', () => {
  beforeEach(() => mockIsFliptSync.mockReturnValue(null));

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

describe('storylines flag: Flipt answering', () => {
  it('is evaluated against the storylines key', () => {
    mockIsFliptSync.mockReturnValue(true);
    storylinesFor(user());
    expect(mockIsFliptSync).toHaveBeenCalledWith(
      'storylines',
      expect.anything(),
      expect.anything()
    );
  });

  it('a disabled key turns it off even for a moderator', () => {
    mockIsFliptSync.mockReturnValue(false);
    expect(storylinesFor(mod())).toBe(false);
    expect(storylinesFor(user({ permissions: ['storylines'] }))).toBe(false);
  });

  it('an enabled key turns it on for a moderator', () => {
    mockIsFliptSync.mockReturnValue(true);
    expect(storylinesFor(mod())).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';

/**
 * SEAM test for #4298 — "changing the avatar leaves the session serving the old (now deleted) url".
 *
 * The relationship under test spans two applications and therefore no single-surface test can see it:
 *
 *   main app                                        auth hub
 *   ────────                                        ────────
 *   updateUserHandler (avatar write)
 *     └─ refreshSession
 *          └─ clearSessionCache
 *               └─ sessionClient.invalidate(userId) ──▶ invalidateSessionUser
 *                                                        └─ del `session:data2:{userId}`
 *                                                             ▲
 *                          produceSessionUser writes ─────────┘  (4h TTL)
 *
 * Every OTHER suite in this repo is structurally blind to it, because `src/__tests__/setup.ts`
 * globally mocks `~/server/auth/session-invalidation` down to a no-op `refreshSession`. A test
 * written against that stub can only assert that the CALL happens — it cannot distinguish a call
 * that busts the right key from one that busts nothing, or the wrong key. That is exactly the
 * failure mode #4298 describes, so this file unmocks it and asserts the EFFECT instead.
 *
 * What is deliberately real here: the whole main-app chain (`refreshSession` → `updateSessionState`
 * → `clearSessionCache`), and the KEY both sides address, derived on each side from the single
 * shared `REDIS_KEYS.USER.SESSION` namespace in `@civitai/redis`. The hub's HTTP hop is stood in
 * for by `hubInvalidate`, which deletes from the same fake keyspace using the hub's own key
 * derivation — so a namespace drift between the two apps fails this test rather than shipping.
 */

// Defeat the global stub from `src/__tests__/setup.ts`. Without this line the entire chain below is
// replaced by `vi.fn()` and every assertion here passes vacuously.
vi.unmock('~/server/auth/session-invalidation');

const {
  sharedCache,
  hubInvalidate,
  mockUpdateUserById,
  mockGetUserById,
  mockIngestImage,
  mockDeleteImageById,
  mockGetUserSettings,
  mockPatchUserSettings,
} = vi.hoisted(() => ({
  sharedCache: new Map<string, unknown>(),
  hubInvalidate: vi.fn(),
  mockUpdateUserById: vi.fn(),
  mockGetUserById: vi.fn(),
  mockIngestImage: vi.fn(),
  mockDeleteImageById: vi.fn(),
  mockGetUserSettings: vi.fn(),
  mockPatchUserSettings: vi.fn(),
}));

// The hub hop. `clearSessionCache` calls this first and only falls back to a direct `redis.del` when
// it rejects — both arms are exercised below.
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { invalidate: hubInvalidate },
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserById: mockGetUserById,
  updateUserById: mockUpdateUserById,
  updateLeaderboardRankForUsers: vi.fn(),
  equipCosmetic: vi.fn(),
  unequipCosmeticByType: vi.fn(),
  createUserReferral: vi.fn(),
  isUsernamePermitted: vi.fn(async () => true),
  getUserSettings: mockGetUserSettings,
  patchUserSettings: mockPatchUserSettings,
  queueModelMetricPrivacyReindex: vi.fn(),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ingestImage: mockIngestImage,
  deleteImageById: mockDeleteImageById,
}));
vi.mock('~/server/search-index', () => ({ usersSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(() => ({ catch: vi.fn() })) }));

import { REDIS_KEYS } from '@civitai/redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { OnboardingSteps } from '~/server/common/enums';
import {
  completeOnboardingHandler,
  setUserSettingHandler,
  updateUserHandler,
} from '~/server/controllers/user.controller';

const USER_ID = 5;
// The hub's own derivation (`sessionCacheKey` in @civitai/auth, and `produceSessionUser`'s write in
// apps/auth) — built here from the same shared constant, NOT from the string the main app builds.
const hubKey = (userId: number) => `${REDIS_KEYS.USER.SESSION}:${userId}`;

const OLD_AVATAR = 'https://images.example.test/old-avatar.jpg';
const NEW_AVATAR = 'https://images.example.test/new-avatar.jpg';

const warmSessionCache = () =>
  sharedCache.set(hubKey(USER_ID), { id: USER_ID, username: 'ada', image: OLD_AVATAR });

const changeAvatar = () =>
  updateUserHandler({
    ctx: { user: { id: USER_ID } },
    input: {
      id: USER_ID,
      profilePicture: { id: 99, url: NEW_AVATAR, type: 'image', width: 256, height: 256 },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  sharedCache.clear();

  // The user had a DIFFERENT profile picture before this save — the replacement branch, which is the
  // one that hard-deletes the previous image (#4272) and so makes staleness a 404 rather than a
  // merely-old avatar.
  mockGetUserById.mockResolvedValue({ profilePictureId: 42 });
  mockUpdateUserById.mockResolvedValue({ id: USER_ID, profilePictureId: 99 });
  mockIngestImage.mockResolvedValue(undefined);
  mockDeleteImageById.mockResolvedValue(undefined);
  mockGetUserSettings.mockResolvedValue({});
  mockPatchUserSettings.mockResolvedValue({});

  // Back the canonical redis mock with a real keyspace so a bust is OBSERVABLE. Left as the default
  // `del: () => 0` spy, every assertion below would be about a call rather than an effect.
  redisMock.redis.del.mockImplementation(async (key: string) => (sharedCache.delete(key) ? 1 : 0));
  // `updateSessionState` scans the user's token hash before busting; an empty set is the shape that
  // matters here (this test is about the cache entry, not token revocation).
  redisMock.sysRedis.hScanNoValues.mockResolvedValue({ cursor: '0', fields: [] });

  hubInvalidate.mockImplementation(async (userId: number) => {
    sharedCache.delete(hubKey(userId));
  });
});

describe('avatar change → shaped session-user cache (#4298)', () => {
  it('busts the hub-owned session:data2 entry, so the next read cannot serve the deleted avatar', async () => {
    warmSessionCache();
    expect(sharedCache.has(hubKey(USER_ID))).toBe(true);

    await changeAvatar();

    // The property is the ABSENCE of the entry — not that some function was called. A bust that
    // addressed the wrong key, or that never reached redis, leaves this entry in place and the
    // session keeps serving OLD_AVATAR for the remaining 4h of its TTL.
    expect(sharedCache.has(hubKey(USER_ID))).toBe(false);
  });

  it('addresses the same key the hub writes, even when the hub hop fails', async () => {
    // `clearSessionCache` falls back to a hand-built key string on a hub blip. That string is a
    // SECOND spelling of a hub-owned namespace, so it can drift from the hub's own derivation
    // silently; this pins the two together.
    hubInvalidate.mockRejectedValue(new Error('hub unreachable'));
    warmSessionCache();

    await changeAvatar();

    expect(sharedCache.has(hubKey(USER_ID))).toBe(false);
  });

  it('busts only AFTER the new avatar is written, so the re-produce reads the new row', async () => {
    warmSessionCache();

    await changeAvatar();

    // Ordering is the whole property: busting before the write lets a concurrent read re-produce the
    // OLD row into the cache with a fresh 4h TTL, which is the same observable as never busting.
    expect(mockUpdateUserById.mock.invocationCallOrder[0]).toBeLessThan(
      hubInvalidate.mock.invocationCallOrder[0]
    );
  });

  it('busts on a username change too — same shaped entry, same 4h window', async () => {
    warmSessionCache();

    await updateUserHandler({
      ctx: { user: { id: USER_ID } },
      input: { id: USER_ID, username: 'ada-new' },
    } as never);

    expect(sharedCache.has(hubKey(USER_ID))).toBe(false);
  });
});

/**
 * The same defect class as #4298, found by enumerating the shaped SessionUser's fields against their
 * writers rather than by re-reading the avatar path: a handler whose bust GATE is narrower than the
 * set of session-carried fields it WRITES. Both of these were live gaps.
 */
describe('user.setSettings — session-projected settings keys', () => {
  const setSetting = (input: Record<string, unknown>) =>
    setUserSettingHandler({
      ctx: { user: { id: USER_ID }, features: {} },
      input,
    } as never);

  it('busts when allowAds changes — it is projected onto the session, like isEarlyAdopter', async () => {
    // The gap: `allowAds` is folded into the SessionUser by the hub's shapeSessionUser, but the bust
    // used to fire only for `isEarlyAdopter`. Turning ads off therefore kept `allowAds: true` in the
    // session — and in every Flipt context built from it — for the rest of the 4h TTL.
    mockGetUserSettings.mockResolvedValue({ allowAds: true });
    warmSessionCache();

    await setSetting({ allowAds: false });

    expect(sharedCache.has(hubKey(USER_ID))).toBe(false);
  });

  it('still busts when isEarlyAdopter changes', async () => {
    mockGetUserSettings.mockResolvedValue({ isEarlyAdopter: false });
    warmSessionCache();

    await setSetting({ isEarlyAdopter: true });

    expect(sharedCache.has(hubKey(USER_ID))).toBe(false);
  });

  it('does NOT bust for a settings key the session does not carry', async () => {
    // The gate has to stay narrow. Busting on every unrelated toggle would re-produce the whole
    // shaped user (a DB round trip) on each one, which is the cost the change-gate exists to avoid.
    mockGetUserSettings.mockResolvedValue({ hideDonationGoals: false });
    warmSessionCache();

    await setSetting({ hideDonationGoals: true });

    expect(sharedCache.has(hubKey(USER_ID))).toBe(true);
  });

  it('does NOT bust when a projected key is re-sent unchanged', async () => {
    mockGetUserSettings.mockResolvedValue({ allowAds: true });
    warmSessionCache();

    await setSetting({ allowAds: true });

    expect(sharedCache.has(hubKey(USER_ID))).toBe(true);
  });
});

describe('user.completeOnboarding — Profile step writes identity unconditionally', () => {
  it('busts on a Profile re-submit even when the onboarding bit is already set', async () => {
    // The Profile step writes `username`/`email` whether or not the bitmask advances, but the bust
    // used to be gated on the bitmask alone. A re-submit therefore changed the username in the
    // database and left the old one in the session for the rest of its 4h TTL.
    warmSessionCache();

    await completeOnboardingHandler({
      ctx: { user: { id: USER_ID, onboarding: OnboardingSteps.Profile }, domain: 'blue' },
      input: { step: OnboardingSteps.Profile, username: 'ada-renamed' },
    } as never);

    expect(sharedCache.has(hubKey(USER_ID))).toBe(false);
  });

  it('still busts when the step genuinely advances the bitmask', async () => {
    warmSessionCache();

    await completeOnboardingHandler({
      ctx: { user: { id: USER_ID, onboarding: 0 }, domain: 'blue' },
      input: { step: OnboardingSteps.BrowsingLevels },
    } as never);

    expect(sharedCache.has(hubKey(USER_ID))).toBe(false);
  });

  it('does NOT bust on a no-op re-submit that writes no session field', async () => {
    warmSessionCache();

    await completeOnboardingHandler({
      ctx: { user: { id: USER_ID, onboarding: OnboardingSteps.BrowsingLevels }, domain: 'blue' },
      input: { step: OnboardingSteps.BrowsingLevels },
    } as never);

    expect(sharedCache.has(hubKey(USER_ID))).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';
import type * as ErrorHandling from '~/server/utils/errorHandling';

/**
 * A cache-invalidation failure must not turn a COMMITTED write into a 500 (#4304).
 *
 * The chain under test is real, not stubbed:
 *
 *   <handler>  ──▶ refreshSession ──▶ updateSessionState ──▶ clearSessionCache
 *                                                              ├─ sessionClient.invalidate(userId)
 *                                                              │    └─ .catch(() => redis.del(sessionKey))
 *                                                              └─ redis.del(<3 more per-user keys>)
 *
 * `updateSessionState` is deliberately fail-open on BOTH sysRedis legs (its own comments say so),
 * but `clearSessionCache` is awaited OUTSIDE that guard and only the hub hop has a `.catch` — and
 * that `.catch` falls back to a bare `redis.del`. So when the cache redis is unreachable, the
 * fallback rejects, `refreshSession` rejects, and at an unguarded call site the rejection lands in
 * the handler's own `catch { throwDbError }`. The row is already written at that point: the user is
 * told the mutation failed, and a retrying client re-applies a write that already succeeded.
 *
 * 🔴 These assert the OUTCOME, not the presence of a `.catch`. A `.catch(e => { throw e })` passes a
 * structural check and fails every test here. The logging assertion is the other half: the guard has
 * to degrade to TTL-bounded staleness *visibly*, never silently.
 *
 * The pre-existing `session-invalidation.test.ts` cannot see any of this — it mocks
 * `../session-cache` to a resolved no-op, so the one leg that can throw is stubbed out.
 */

// Defeat the global stub from `src/__tests__/setup.ts`; without it `refreshSession` is a `vi.fn()`
// that resolves, the failure below is never injected, and every test here passes vacuously.
vi.unmock('~/server/auth/session-invalidation');

const {
  sharedCache,
  hubInvalidate,
  mockHandleLogError,
  mockUpdateUserById,
  mockGetUserById,
  mockGetUserSettings,
  mockPatchUserSettings,
  mockQueueUpdate,
  mockUpdateLeaderboardRank,
} = vi.hoisted(() => ({
  sharedCache: new Map<string, unknown>(),
  hubInvalidate: vi.fn(),
  mockHandleLogError: vi.fn(),
  mockUpdateUserById: vi.fn(),
  mockGetUserById: vi.fn(),
  mockGetUserSettings: vi.fn(),
  mockPatchUserSettings: vi.fn(),
  mockQueueUpdate: vi.fn(),
  mockUpdateLeaderboardRank: vi.fn(),
}));

vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { invalidate: hubInvalidate },
}));
vi.mock('~/server/services/orchestrator/civitai', () => ({
  invalidateCivitaiUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn().mockResolvedValue(undefined) },
}));
// Spread the original: the controller pulls `throwDbError` / `throwAuthorizationError` / … from
// here, and a wholesale stub would make a thrown TRPCError indistinguishable from a stub artifact.
vi.mock('~/server/utils/errorHandling', async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  handleLogError: mockHandleLogError,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserById: mockGetUserById,
  updateUserById: mockUpdateUserById,
  updateLeaderboardRankForUsers: mockUpdateLeaderboardRank,
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
  ingestImage: vi.fn(),
  deleteImageById: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({ usersSearchIndex: { queueUpdate: mockQueueUpdate } }));
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
const sessionKey = (userId: number) => `${REDIS_KEYS.USER.SESSION}:${userId}`;
const REDIS_DOWN = 'cache redis unreachable';

/** The cache redis is gone: every `del` rejects, so `clearSessionCache`'s hub FALLBACK rejects too. */
const breakCacheRedis = () => {
  hubInvalidate.mockRejectedValue(new Error('hub unreachable'));
  redisMock.redis.del.mockRejectedValue(new Error(REDIS_DOWN));
};

const ctx = () => ({ user: { id: USER_ID }, features: {}, domain: 'blue' } as never);

const completeOnboarding = () =>
  completeOnboardingHandler({
    ctx: { user: { id: USER_ID, onboarding: 0 }, domain: 'blue' },
    input: { step: OnboardingSteps.BrowsingLevels },
  } as never);

const updateUser = () =>
  updateUserHandler({
    ctx: ctx(),
    input: { id: USER_ID, username: 'ada-renamed' },
  } as never);

const setSetting = () => setUserSettingHandler({ ctx: ctx(), input: { allowAds: false } } as never);

beforeEach(() => {
  vi.clearAllMocks();
  sharedCache.clear();

  mockGetUserById.mockResolvedValue({ profilePictureId: null });
  mockUpdateUserById.mockResolvedValue({ id: USER_ID, username: 'ada-renamed' });
  mockGetUserSettings.mockResolvedValue({ allowAds: true });
  mockPatchUserSettings.mockResolvedValue({ allowAds: false });
  mockQueueUpdate.mockResolvedValue(undefined);
  mockUpdateLeaderboardRank.mockResolvedValue(undefined);

  // Healthy default — a real keyspace so a successful bust is OBSERVABLE (the positive control).
  redisMock.redis.del.mockImplementation(async (key: string) => (sharedCache.delete(key) ? 1 : 0));
  redisMock.sysRedis.hScanNoValues.mockResolvedValue({ cursor: '0', fields: [] });
  hubInvalidate.mockImplementation(async (userId: number) => {
    sharedCache.delete(sessionKey(userId));
  });
});

describe('positive control — the injection reaches a real bust', () => {
  it('a HEALTHY cache redis actually busts the session entry', async () => {
    // Without this the "resolves" assertions below would be indistinguishable from a chain wired to
    // nothing: a `refreshSession` that never touches redis also never rejects.
    sharedCache.set(sessionKey(USER_ID), { id: USER_ID });

    await updateUser();

    expect(sharedCache.has(sessionKey(USER_ID))).toBe(false);
  });

  it('a BROKEN cache redis makes refreshSession itself reject', async () => {
    // The premise of #4304, asserted directly rather than assumed: `updateSessionState` is fail-open
    // on its sysRedis legs, but `clearSessionCache` is not, so this rejects.
    breakCacheRedis();
    const { refreshSession } = await import('~/server/auth/session-invalidation');

    await expect(refreshSession(USER_ID, { sendSignal: false })).rejects.toThrow(REDIS_DOWN);
  });
});

describe('completeOnboardingHandler', () => {
  it('still resolves when the session bust fails, after the step is committed', async () => {
    breakCacheRedis();

    await expect(completeOnboarding()).resolves.not.toThrow();
  });

  it('reports the failed bust instead of swallowing it', async () => {
    breakCacheRedis();

    await completeOnboarding();

    expect(mockHandleLogError).toHaveBeenCalledTimes(1);
    expect(mockHandleLogError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((mockHandleLogError.mock.calls[0][0] as Error).message).toContain(REDIS_DOWN);
  });

  it('logs nothing when the bust succeeds', async () => {
    await completeOnboarding();

    expect(mockHandleLogError).not.toHaveBeenCalled();
  });
});

describe('updateUserHandler (the Promise.all batch)', () => {
  it('still returns the updated user when the session bust fails', async () => {
    breakCacheRedis();

    // The row is written before the batch runs, so the only correct response is the written row.
    await expect(updateUser()).resolves.toMatchObject({ id: USER_ID, username: 'ada-renamed' });
    expect(mockUpdateUserById).toHaveBeenCalledTimes(1);
  });

  it('does not take the rest of the batch down with it', async () => {
    // `Promise.all` rejects on the FIRST rejection. Guarding the member (rather than the batch)
    // is what keeps the other post-update work reportable on its own terms.
    breakCacheRedis();

    await updateUser();

    expect(mockQueueUpdate).toHaveBeenCalledTimes(1);
  });

  it('STILL fails when a different batch member fails — the guard is narrow', async () => {
    // The counterpart property. Guarding the whole `Promise.all` would have swallowed this too,
    // which is the failure mode "don't make it fail silently" is about.
    mockUpdateLeaderboardRank.mockRejectedValue(new Error('leaderboard write failed'));

    await expect(
      updateUserHandler({
        ctx: ctx(),
        input: { id: USER_ID, username: 'ada-renamed', leaderboardShowcase: 'overall' },
      } as never)
    ).rejects.toThrow();
  });
});

describe('setUserSettingHandler', () => {
  it('still returns the stored settings when the session bust fails', async () => {
    breakCacheRedis();

    await expect(setSetting()).resolves.toMatchObject({ allowAds: false });
    expect(mockPatchUserSettings).toHaveBeenCalledTimes(1);
  });

  it('reports the failed bust instead of swallowing it', async () => {
    breakCacheRedis();

    await setSetting();

    expect(mockHandleLogError).toHaveBeenCalledTimes(1);
    expect((mockHandleLogError.mock.calls[0][0] as Error).message).toContain(REDIS_DOWN);
  });
});

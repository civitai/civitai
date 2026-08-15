import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as UserService from '~/server/services/user.service';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';

/**
 * THE LOAD-BEARING BEHAVIOUR OF THE SESSION-CARRIED DESIGN.
 *
 * `isEarlyAdopter` lives in `User.settings` but is READ off the session
 * (`SessionUser.isEarlyAdopter` → `buildFliptContext`). The auth hub caches that
 * projection in `session:data2:{id}` for 4h, so writing the setting is NOT enough: without
 * an explicit `refreshSession`, the user flips the switch, the client patches its own
 * `getSettings` cache optimistically so the UI looks applied — and every server-side Flipt
 * evaluation keeps returning the OLD cohort decision for up to four hours. The toggle
 * silently does nothing. That is the failure mode of this design, so it is pinned here.
 *
 * `setUserSettingHandler` is run for REAL against a mocked service layer; the assertion is
 * on whether `refreshSession` was called and with what.
 */

const {
  mockGetUserSettings,
  mockSetUserSetting,
  mockRefreshSession,
  mockQueueReindex,
} = vi.hoisted(() => ({
  mockGetUserSettings: vi.fn(),
  mockSetUserSetting: vi.fn().mockResolvedValue(undefined),
  mockRefreshSession: vi.fn().mockResolvedValue(undefined),
  mockQueueReindex: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings: mockGetUserSettings,
  setUserSetting: mockSetUserSetting,
}));

vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession: mockRefreshSession,
}));

// `user.controller` imports exactly ONE symbol from model.service, so stub it wholesale
// rather than with `importOriginal` — the real module drags in the whole image/event-engine
// graph for no benefit here.
vi.mock('~/server/services/model.service', () => ({
  queueModelMetricPrivacyReindex: mockQueueReindex,
}));

const { setUserSettingHandler } = await import('~/server/controllers/user.controller');

const USER_ID = 4242;

const ctx = () =>
  ({
    user: { id: USER_ID },
    features: { assistantPersonality: true },
  } as never);

const call = (input: Record<string, unknown>) =>
  setUserSettingHandler({ input: input as never, ctx: ctx() });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserSettings.mockResolvedValue({});
});

describe('setUserSettingHandler — session refresh on the early-adopter toggle', () => {
  it('refreshes the session when the user OPTS IN', async () => {
    mockGetUserSettings.mockResolvedValue({});

    await call({ isEarlyAdopter: true });

    expect(mockSetUserSetting).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).toHaveBeenCalledWith(USER_ID, { caller: 'profile' });
  });

  it('refreshes the session when the user OPTS OUT', async () => {
    // Leaving the programme must take effect as promptly as joining it, or a user who
    // turns it off keeps seeing the in-progress features they just opted out of.
    mockGetUserSettings.mockResolvedValue({ isEarlyAdopter: true });

    await call({ isEarlyAdopter: false });

    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).toHaveBeenCalledWith(USER_ID, { caller: 'profile' });
  });

  it('does NOT refresh when an unrelated setting is written', async () => {
    // The refresh busts a shared cache and fans a signal out to every open tab. Doing it on
    // every settings write would put that cost on the tour-settings/ToS paths for nothing.
    mockGetUserSettings.mockResolvedValue({});

    await call({ swipeGalleryCards: true });

    expect(mockSetUserSetting).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it('does NOT refresh when an unrelated setting is written by an ALREADY-opted-in user', async () => {
    // The regression this guards: `setUserSettingHandler` does a read-modify-write, so the
    // payload handed to `setUserSetting` carries `isEarlyAdopter` on EVERY write once the
    // user has opted in. A presence check (`'isEarlyAdopter' in newSettings`) would fire the
    // refresh on every unrelated toggle for exactly the cohort that uses the site most.
    mockGetUserSettings.mockResolvedValue({ isEarlyAdopter: true, allowAds: false });

    await call({ swipeGalleryCards: true });

    // The write still carries the existing opt-in through (read-modify-write intact) ...
    expect(mockSetUserSetting).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ isEarlyAdopter: true })
    );
    // ... but nothing CHANGED, so no refresh.
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it('does NOT refresh on a no-op write of the same value', async () => {
    mockGetUserSettings.mockResolvedValue({ isEarlyAdopter: true });

    await call({ isEarlyAdopter: true });

    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it('refreshes when the value goes from unset to explicitly false', async () => {
    // undefined → false is a real transition of the stored value. It does not change the
    // Flipt context (both coerce to 'false'), so this is an INVARIANT GUARD on the
    // change-detection predicate, not regression coverage for an observed bug: it pins that
    // the predicate compares values rather than testing truthiness.
    mockGetUserSettings.mockResolvedValue({});

    await call({ isEarlyAdopter: false });

    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });

  it('still returns the merged settings to the caller', async () => {
    mockGetUserSettings.mockResolvedValue({ allowAds: false });

    const result = await call({ isEarlyAdopter: true });

    expect(result).toMatchObject({ allowAds: false, isEarlyAdopter: true });
  });

  it('the refresh is AWAITED, so the cache bust lands before the mutation resolves', async () => {
    // If the call were fire-and-forget, the client's follow-up session fetch could race the
    // bust and re-cache the stale projection — the same race `updateContentSettings`
    // documents on its own awaited refresh.
    let settled = false;
    mockRefreshSession.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve();
          }, 10)
        )
    );
    mockGetUserSettings.mockResolvedValue({});

    await call({ isEarlyAdopter: true });

    expect(settled).toBe(true);
  });
});

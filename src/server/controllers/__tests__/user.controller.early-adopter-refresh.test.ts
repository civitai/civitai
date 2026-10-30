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

const { mockGetUserSettings, mockPatchUserSettings, mockRefreshSession, mockQueueReindex } =
  vi.hoisted(() => ({
    mockGetUserSettings: vi.fn(),
    mockPatchUserSettings: vi.fn().mockResolvedValue({}),
    mockRefreshSession: vi.fn().mockResolvedValue(undefined),
    mockQueueReindex: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings: mockGetUserSettings,
  patchUserSettings: mockPatchUserSettings,
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
  mockPatchUserSettings.mockResolvedValue({});
});

describe('setUserSettingHandler — session refresh on the early-adopter toggle', () => {
  it('refreshes the session when the user OPTS IN', async () => {
    mockGetUserSettings.mockResolvedValue({});

    await call({ isEarlyAdopter: true });

    expect(mockPatchUserSettings).toHaveBeenCalledTimes(1);
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

    expect(mockPatchUserSettings).toHaveBeenCalledTimes(1);
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it('does NOT refresh when an unrelated setting is written by an ALREADY-opted-in user', async () => {
    // The change-detection predicate compares against the PREVIOUS value, so it must not
    // fire for a user who merely already holds the opt-in. (Before the atomic-write change
    // the handler also rewrote the whole blob, which put `isEarlyAdopter` in the payload on
    // every write — so a presence check would have refreshed on every unrelated toggle for
    // exactly the cohort that uses the site most. The presence check is still wrong; the
    // payload no longer carries the key at all.)
    mockGetUserSettings.mockResolvedValue({ isEarlyAdopter: true, allowAds: false });

    await call({ swipeGalleryCards: true });

    // The write carries ONLY what this request is changing. Writing back the read snapshot
    // is the lost-update defect — see user-settings-race.behavior.test.ts.
    const [, patch] = mockPatchUserSettings.mock.calls[0];
    expect(patch.set).toEqual({ swipeGalleryCards: true });
    expect(patch.set).not.toHaveProperty('isEarlyAdopter');
    expect(patch.set).not.toHaveProperty('allowAds');
    // ... and nothing CHANGED, so no refresh.
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

  it('returns the STORED settings to the caller, not a JS-side reconstruction', async () => {
    // The handler used to return the object it had just computed. That object was a
    // read-modify-write of a possibly-stale snapshot, so the client could be handed values
    // that were never in the database. The write now returns the row it produced.
    mockGetUserSettings.mockResolvedValue({ allowAds: false });
    mockPatchUserSettings.mockResolvedValue({ allowAds: false, isEarlyAdopter: true });

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

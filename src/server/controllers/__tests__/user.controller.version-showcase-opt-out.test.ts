import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';
import type * as SessionInvalidation from '~/server/auth/session-invalidation';

/**
 * The account-settings opt-out goes through `setUserSettingHandler`, so that is where the author's
 * images leave (or rejoin) every showcase featuring them.
 */

const { mockGetUserSettings, mockPatchUserSettings, mockBustForUser } = vi.hoisted(() => ({
  mockGetUserSettings: vi.fn(),
  mockPatchUserSettings: vi.fn(),
  mockBustForUser: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings: mockGetUserSettings,
  patchUserSettings: mockPatchUserSettings,
}));
vi.mock('~/server/auth/session-invalidation', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionInvalidation>()),
  refreshSession: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/model.service', () => ({ queueModelMetricPrivacyReindex: vi.fn() }));
vi.mock('~/server/services/version-showcase.service', () => ({
  bustVersionShowcasesForUser: mockBustForUser,
}));

const { setUserSettingHandler } = await import('~/server/controllers/user.controller');

const USER_ID = 4242;
const call = (input: Record<string, unknown>) =>
  setUserSettingHandler({ input: input as never, ctx: { user: { id: USER_ID } } as never });

beforeEach(() => {
  vi.clearAllMocks();
  mockPatchUserSettings.mockResolvedValue({});
});

describe('setUserSettingHandler: the version showcase opt-out', () => {
  it('refreshes the showcases featuring the user when they opt out', async () => {
    mockGetUserSettings.mockResolvedValue({});
    await call({ hideFromVersionShowcases: true });
    expect(mockBustForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('refreshes them again when they opt back in', async () => {
    mockGetUserSettings.mockResolvedValue({ hideFromVersionShowcases: true });
    await call({ hideFromVersionShowcases: false });
    expect(mockBustForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('leaves them alone when the value did not change, or another setting was written', async () => {
    mockGetUserSettings.mockResolvedValue({ hideFromVersionShowcases: true });
    await call({ hideFromVersionShowcases: true });
    await call({ allowAds: false });
    expect(mockBustForUser).not.toHaveBeenCalled();
  });
});

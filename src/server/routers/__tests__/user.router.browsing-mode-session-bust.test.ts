import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as UserService from '~/server/services/user.service';
import type * as ErrorHandling from '~/server/utils/errorHandling';

/**
 * `user.updateBrowsingMode` — the fourth site of #4304's defect class, and the one the issue did
 * not list because it lives in the router rather than the controller.
 *
 * The shape is identical: `updateUserById` commits, then the session cache bust is awaited with
 * nothing catching it, so an unreachable cache redis turns a succeeded mutation into a 500. A
 * browsing-mode toggle is one of the highest-frequency writes on the site and the client re-submits
 * on failure, so this is the site most likely to actually produce the re-applied-write symptom.
 *
 * Driven through the REAL router with `createCaller`, so the assertion is about what a caller
 * observes rather than about how the procedure was written.
 */

const { mockUpdateUserById, mockHandleLogError } = vi.hoisted(() => ({
  mockUpdateUserById: vi.fn(),
  mockHandleLogError: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  updateUserById: mockUpdateUserById,
}));

vi.mock('~/server/utils/errorHandling', async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  handleLogError: mockHandleLogError,
}));

import { refreshSession } from '~/server/auth/session-invalidation';
import { userRouter } from '~/server/routers/user.router';

const USER_ID = 31;
const REDIS_DOWN = 'cache redis unreachable';

// `guardedProcedure` = protected + onboarded + not-muted, so the fixture user has to satisfy all
// three or the test measures the middleware rather than the handler.
const user = {
  id: USER_ID,
  isModerator: false,
  tier: 'free',
  username: 'ada',
  muted: false,
  onboarding: 0xff,
};

const caller = () =>
  userRouter.createCaller({
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: undefined,
  } as never);

const refreshSessionMock = vi.mocked(refreshSession);

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateUserById.mockResolvedValue({ id: USER_ID });
  refreshSessionMock.mockResolvedValue(undefined);
});

describe('user.updateBrowsingMode', () => {
  it('positive control — the bust is actually reached on the happy path', async () => {
    await caller().updateBrowsingMode({ showNsfw: true });

    expect(refreshSessionMock).toHaveBeenCalledWith(USER_ID, { caller: 'browsing-mode' });
  });

  it('still resolves when the session bust fails, after the toggle is committed', async () => {
    refreshSessionMock.mockRejectedValue(new Error(REDIS_DOWN));

    await expect(caller().updateBrowsingMode({ showNsfw: true })).resolves.not.toThrow();
    expect(mockUpdateUserById).toHaveBeenCalledTimes(1);
  });

  it('logs the failed bust rather than swallowing it', async () => {
    refreshSessionMock.mockRejectedValue(new Error(REDIS_DOWN));

    await caller().updateBrowsingMode({ showNsfw: true });

    expect(mockHandleLogError).toHaveBeenCalledTimes(1);
    expect((mockHandleLogError.mock.calls[0][0] as Error).message).toBe(REDIS_DOWN);
  });

  it('still FAILS when the toggle write itself fails', async () => {
    mockUpdateUserById.mockRejectedValue(new Error('db write failed'));

    await expect(caller().updateBrowsingMode({ showNsfw: true })).rejects.toThrow();
  });
});

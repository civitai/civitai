import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ErrorHandling from '~/server/utils/errorHandling';

/**
 * The email-change pair, same defect class as #4304's controller sites.
 *
 * `confirmEmailChange` is the worst instance in the codebase: by the time it busts the session
 * cache the email column is written AND the one-time token has been deleted from redis. A
 * rejection there does not merely misreport a committed write — it misreports one the user
 * CANNOT retry, because the link in their inbox is already spent. `requestEmailChange` is the
 * same shape one step earlier: the verification email has been sent and the token issued.
 *
 * Asserted as OUTCOMES (the call resolves, with its success payload, and the failure is logged),
 * not as the presence of a `.catch` — `.catch(e => { throw e })` would satisfy a structural check
 * and fail every test here.
 */

const { mockHandleLogError } = vi.hoisted(() => ({ mockHandleLogError: vi.fn() }));

vi.mock('~/server/utils/errorHandling', async (importOriginal) => ({
  ...(await importOriginal<typeof ErrorHandling>()),
  handleLogError: mockHandleLogError,
}));

// `requestEmailChange` now runs the email-domain guard first, whose MX probe would otherwise do a
// live DNS lookup for `ada@example.test` (a reserved TLD that never resolves) and reject before any
// of the session-bust behaviour under test is reached.
vi.mock('~/server/utils/email-domain', () => ({ domainAcceptsMail: async () => true }));

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));
vi.mock('~/server/email/templates/emailVerification.email', () => ({
  emailVerificationEmail: { send: mockSend },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { refreshSession } from '~/server/auth/session-invalidation';
import { confirmEmailChange, requestEmailChange } from '../email-verification.service';

const USER_ID = 77;
const NEW_EMAIL = 'ada@example.test';
const TOKEN = 'deadbeef';
const REDIS_DOWN = 'cache redis unreachable';

/** The global setup stub; `.mockRejectedValue` models the whole chain in `session-invalidation`. */
const refreshSessionMock = vi.mocked(refreshSession);

beforeEach(() => {
  vi.clearAllMocks();
  refreshSessionMock.mockResolvedValue(undefined);
  mockSend.mockResolvedValue(undefined);

  dbMock.dbRead.user.findFirst.mockResolvedValue(null);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ email: 'old@example.test', username: 'ada' });
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });

  redisMock.redis.set.mockResolvedValue('OK');
  redisMock.redis.get.mockResolvedValue(
    JSON.stringify({ userId: USER_ID, newEmail: NEW_EMAIL, createdAt: new Date().toISOString() })
  );
  redisMock.redis.del.mockResolvedValue(1);
});

describe('confirmEmailChange', () => {
  it('positive control — the refresh is actually reached on the happy path', async () => {
    // Without this, "still resolves" below is indistinguishable from a call that never happens.
    await confirmEmailChange(TOKEN);

    expect(refreshSessionMock).toHaveBeenCalledWith(USER_ID, { caller: 'email-verification' });
  });

  it('still reports success when the session bust fails', async () => {
    refreshSessionMock.mockRejectedValue(new Error(REDIS_DOWN));

    await expect(confirmEmailChange(TOKEN)).resolves.toMatchObject({ success: true });
    // The email really was changed — that is what makes a 500 here a lie, not a warning.
    expect(dbMock.dbWrite.user.update).toHaveBeenCalledTimes(1);
  });

  it('logs the failed bust rather than swallowing it', async () => {
    refreshSessionMock.mockRejectedValue(new Error(REDIS_DOWN));

    await confirmEmailChange(TOKEN);

    expect(mockHandleLogError).toHaveBeenCalledTimes(1);
    expect((mockHandleLogError.mock.calls[0][0] as Error).message).toBe(REDIS_DOWN);
  });

  it('still FAILS when the email write itself fails', async () => {
    // The guard has to stay on the cache bust. A real write failure must still surface.
    dbMock.dbWrite.user.update.mockRejectedValue(new Error('db write failed'));

    await expect(confirmEmailChange(TOKEN)).rejects.toThrow('db write failed');
  });
});

describe('requestEmailChange', () => {
  it('still reports success when the session bust fails, after the email is sent', async () => {
    refreshSessionMock.mockRejectedValue(new Error(REDIS_DOWN));

    await expect(requestEmailChange(USER_ID, NEW_EMAIL)).resolves.toMatchObject({ success: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('logs the failed bust rather than swallowing it', async () => {
    // The sibling of the `confirmEmailChange` assertion below. Without it, `.catch(handleLogError)`
    // here is indistinguishable from `.catch(() => undefined)` — degrading to TTL-bounded staleness
    // is only acceptable because the degradation is VISIBLE.
    refreshSessionMock.mockRejectedValue(new Error(REDIS_DOWN));

    await requestEmailChange(USER_ID, NEW_EMAIL);

    expect(mockHandleLogError).toHaveBeenCalledTimes(1);
    expect((mockHandleLogError.mock.calls[0][0] as Error).message).toBe(REDIS_DOWN);
  });

  it('still FAILS when sending the verification email fails', async () => {
    mockSend.mockRejectedValue(new Error('smtp down'));

    await expect(requestEmailChange(USER_ID, NEW_EMAIL)).rejects.toThrow('smtp down');
  });
});

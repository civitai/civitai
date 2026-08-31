import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlocklistService from '~/server/services/blocklist.service';

/**
 * 🔴 These test the ENFORCEMENT, not the guard. `email-domain-guard.test.ts` proves
 * `assertEmailAllowed` rejects the right addresses; nothing there notices if a call site stops
 * calling it, and a guard nobody calls is theatre.
 *
 * Both directions matter and they pull against each other:
 *
 *   - Miss the guard on a NEW address and the burner ring walks back in through onboarding, which is
 *     the door this whole change exists to close.
 *   - Run it on an EXISTING address and every user whose domain was blocklisted AFTER they signed up
 *     is locked out of their own profile. The measured false-positive rate is not zero, so this
 *     direction is a live user-facing risk, not a theoretical one.
 *
 * Mutations these catch that the unit suite does not: flipping `!==` to `===` in the onboarding call
 * site (guard fires only when the address is UNCHANGED — wholly inert on the Reddit path), and
 * swapping `delete data.email` for a guard call in `updateUserById` (the lockout).
 */

const { mockAssertEmailAllowed } = vi.hoisted(() => ({ mockAssertEmailAllowed: vi.fn() }));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  assertEmailAllowed: mockAssertEmailAllowed,
}));

vi.mock('~/server/email/templates/emailVerification.email', () => ({
  emailVerificationEmail: { send: vi.fn().mockResolvedValue(undefined) },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { completeOnboardingHandler } from '~/server/controllers/user.controller';
import { updateUserById } from '~/server/services/user.service';
import { requestEmailChange } from '~/server/services/email-verification.service';

const USER_ID = 4242;
const NEW_EMAIL = 'fresh@example.test';
const OLD_EMAIL = 'existing@example.test';

function onboardingCtx(email?: string) {
  return {
    user: { id: USER_ID, onboarding: 0, email },
    domain: 'blue',
  } as unknown as Parameters<typeof completeOnboardingHandler>[0]['ctx'];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertEmailAllowed.mockResolvedValue(undefined);
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
  dbMock.dbWrite.user.findFirst.mockResolvedValue(null);
  dbMock.dbRead.user.findFirst.mockResolvedValue(null);
  dbMock.dbRead.user.findUnique.mockResolvedValue({ email: OLD_EMAIL, username: 'ada' });
  redisMock.redis.set.mockResolvedValue('OK');
});

describe('onboarding Profile step', () => {
  it('runs the guard on a NEW address', async () => {
    await completeOnboardingHandler({
      input: { step: OnboardingSteps.Profile, email: NEW_EMAIL },
      ctx: onboardingCtx(undefined),
    } as Parameters<typeof completeOnboardingHandler>[0]);

    expect(mockAssertEmailAllowed).toHaveBeenCalledTimes(1);
    expect(mockAssertEmailAllowed).toHaveBeenCalledWith(NEW_EMAIL);
  });

  it('does NOT run the guard when the address is UNCHANGED', async () => {
    // The lockout direction: a user re-submitting this step with the address already on their
    // account must not be re-judged against a list that has moved since they signed up.
    await completeOnboardingHandler({
      input: { step: OnboardingSteps.Profile, email: OLD_EMAIL },
      ctx: onboardingCtx(OLD_EMAIL),
    } as Parameters<typeof completeOnboardingHandler>[0]);

    expect(mockAssertEmailAllowed).not.toHaveBeenCalled();
  });

  it('propagates the guard rejection instead of writing the address', async () => {
    mockAssertEmailAllowed.mockRejectedValue(new Error('blocked'));

    await expect(
      completeOnboardingHandler({
        input: { step: OnboardingSteps.Profile, email: NEW_EMAIL },
        ctx: onboardingCtx(undefined),
      } as Parameters<typeof completeOnboardingHandler>[0])
    ).rejects.toThrow();

    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
  });
});

describe('updateUserById', () => {
  it('runs the guard when the user has NO address on file', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue({ email: null });

    await updateUserById({ id: USER_ID, data: { email: NEW_EMAIL } });

    expect(mockAssertEmailAllowed).toHaveBeenCalledTimes(1);
    expect(mockAssertEmailAllowed).toHaveBeenCalledWith(NEW_EMAIL);
  });

  it('does NOT run the guard when the user ALREADY has an address, and drops the field', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue({ email: OLD_EMAIL });

    await updateUserById({ id: USER_ID, data: { email: NEW_EMAIL } });

    expect(mockAssertEmailAllowed).not.toHaveBeenCalled();
    // The existing "don't overwrite an existing email" rule still holds: the field is stripped, so
    // the guard has nothing to judge and the user cannot be locked out by a later list change.
    const [call] = dbMock.dbWrite.user.update.mock.calls;
    expect(call[0].data).not.toHaveProperty('email');
  });

  it('propagates the guard rejection instead of writing', async () => {
    dbMock.dbWrite.user.findFirst.mockResolvedValue({ email: null });
    mockAssertEmailAllowed.mockRejectedValue(new Error('blocked'));

    await expect(updateUserById({ id: USER_ID, data: { email: NEW_EMAIL } })).rejects.toThrow();

    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
  });
});

describe('requestEmailChange', () => {
  it('runs the guard on the requested address', async () => {
    await requestEmailChange(USER_ID, NEW_EMAIL);

    expect(mockAssertEmailAllowed).toHaveBeenCalledTimes(1);
    expect(mockAssertEmailAllowed).toHaveBeenCalledWith(NEW_EMAIL);
  });

  it('runs the guard BEFORE issuing a token or sending mail', async () => {
    mockAssertEmailAllowed.mockRejectedValue(new Error('blocked'));

    await expect(requestEmailChange(USER_ID, NEW_EMAIL)).rejects.toThrow();

    expect(redisMock.redis.set).not.toHaveBeenCalled();
  });
});

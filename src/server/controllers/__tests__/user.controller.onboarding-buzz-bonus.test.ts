import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';

const { createBuzzTransaction } = vi.hoisted(() => ({
  createBuzzTransaction: vi.fn().mockResolvedValue({}),
}));

vi.mock('~/server/recaptcha/client', () => ({
  verifyCaptchaToken: vi.fn().mockResolvedValue(true),
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransaction,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import { completeOnboardingHandler } from '~/server/controllers/user.controller';

const USER_ID = 4242;

// The session copy of `onboarding` is deliberately 0 in every case: it can be hours stale, so only
// the primary row may decide whether the bonus is owed.
function submitBuzzStep(row: { onboarding: number; meta?: unknown }) {
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ meta: {}, ...row });
  return completeOnboardingHandler({
    input: { step: OnboardingSteps.Buzz, recaptchaToken: 'token' },
    ctx: { user: { id: USER_ID, onboarding: 0 }, domain: 'blue', ip: '127.0.0.1' },
  } as unknown as Parameters<typeof completeOnboardingHandler>[0]);
}

beforeEach(() => {
  createBuzzTransaction.mockClear();
});

describe('completeOnboardingHandler, Buzz step bonus', () => {
  it('pays the bonus the first time the step completes', async () => {
    await submitBuzzStep({ onboarding: OnboardingSteps.TOS | OnboardingSteps.Profile });

    expect(createBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ toAccountId: USER_ID, description: 'Onboarding bonus' })
    );
  });

  it('does not pay again when the step was already complete', async () => {
    await submitBuzzStep({ onboarding: OnboardingSteps.TOS | OnboardingSteps.Buzz });

    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('never pays a system account', async () => {
    await submitBuzzStep({ onboarding: 0, meta: { systemAccount: true } });

    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });
});

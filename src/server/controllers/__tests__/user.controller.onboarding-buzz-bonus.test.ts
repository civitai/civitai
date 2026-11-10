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

function submitBuzzStep(row: { onboarding: number; meta?: unknown }) {
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ meta: {}, ...row });
  return completeOnboardingHandler({
    input: { step: OnboardingSteps.Buzz, recaptchaToken: 'token' },
    ctx: { user: { id: USER_ID, onboarding: row.onboarding }, domain: 'blue', ip: '127.0.0.1' },
  } as unknown as Parameters<typeof completeOnboardingHandler>[0]);
}

const paidBonus = () =>
  expect(createBuzzTransaction).toHaveBeenCalledWith(
    expect.objectContaining({
      toAccountId: USER_ID,
      externalTransactionId: `${USER_ID}-onboarding-bonus`,
    })
  );

beforeEach(() => {
  createBuzzTransaction.mockReset();
  createBuzzTransaction.mockResolvedValue({});
});

describe('completeOnboardingHandler, Buzz step bonus', () => {
  it('pays the bonus when the step first completes', async () => {
    await submitBuzzStep({ onboarding: OnboardingSteps.TOS | OnboardingSteps.Profile });

    paidBonus();
  });

  // The step bit is committed before the payment, and a payment failure is only logged, so the
  // resubmit is the retry. The fixed externalTransactionId is what keeps it from paying twice.
  it('pays on a resubmit after the first payment failed', async () => {
    createBuzzTransaction.mockRejectedValue(new Error('buzz service unavailable'));
    await submitBuzzStep({ onboarding: OnboardingSteps.TOS | OnboardingSteps.Profile });

    createBuzzTransaction.mockReset();
    createBuzzTransaction.mockResolvedValue({});
    await submitBuzzStep({
      onboarding: OnboardingSteps.TOS | OnboardingSteps.Profile | OnboardingSteps.Buzz,
    });

    paidBonus();
  });

  it('never pays a system account', async () => {
    await submitBuzzStep({ onboarding: 0, meta: { systemAccount: true } });

    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });
});

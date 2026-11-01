import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BountyService from '~/server/services/bounty.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `bounty.resolveUnpaidAward` through the real router and middleware: who may call it, and what
 * input reaches the service. The service is covered in `bounty-payout-lock.service.test.ts`.
 */

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('~/server/services/bounty.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyService>()),
  resolveUnpaidBountyAward: resolve,
}));

const { bountyRouter } = await import('~/server/routers/bounty.router');

const ctx = (user: object | null) =>
  ({
    user,
    acceptableOrigin: true,
    // A narrower scope would FORBID for a scope reason and pass the cases below for the wrong one.
    tokenScope: TokenScope.Full,
    features: {},
  } as never);
const member = { id: 41, isModerator: false, muted: false, onboarding: OnboardingSteps.Buzz };
const moderator = { ...member, id: 88, isModerator: true };
const input = () => ({
  bountyId: 4,
  userId: 5,
  ruling: 'paid_winner' as const,
  ledgerReference: '  manual payout to the winner  ',
});

beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockResolvedValue({ recorded: true });
});

describe('bounty.resolveUnpaidAward', () => {
  it('records a moderator ruling, as that moderator, with the reference trimmed', async () => {
    await expect(
      bountyRouter.createCaller(ctx(moderator)).resolveUnpaidAward(input())
    ).resolves.toEqual({ recorded: true });
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      bountyId: 4,
      userId: 5,
      ruling: 'paid_winner',
      ledgerReference: 'manual payout to the winner',
      moderatorId: 88,
    });
  });

  it.each([
    ['a member', member, 'FORBIDDEN'],
    ['no one signed in', null, 'UNAUTHORIZED'],
  ])('refuses %s before the service is reached', async (_, user, code) => {
    await expect(
      bountyRouter.createCaller(ctx(user)).resolveUnpaidAward(input())
    ).rejects.toMatchObject({ code });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown ruling', { ruling: 'paid_owner' }],
    ['an empty reference', { ledgerReference: '   ' }],
    ['a reference over 500 characters', { ledgerReference: 'x'.repeat(501) }],
  ])('refuses %s', async (_, change) => {
    await expect(
      bountyRouter
        .createCaller(ctx(moderator))
        .resolveUnpaidAward({ ...input(), ...change } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(resolve).not.toHaveBeenCalled();
  });
});

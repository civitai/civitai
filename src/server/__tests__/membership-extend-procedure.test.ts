import { describe, expect, it, vi } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Drives the REAL subscriptions router, so what is asserted is the middleware chain on the two
 * procedures (moderator + the `membershipExtend` granted flag), not a reimplementation of it. The
 * service is mocked: it is tested on its own (membership-extend.service.test.ts).
 */

const { extendMembership, previewMembershipExtension } = vi.hoisted(() => ({
  extendMembership: vi.fn(async () => 'extended'),
  previewMembershipExtension: vi.fn(async () => 'previewed'),
}));
vi.mock('~/server/services/membership-extend.service', () => ({
  extendMembership,
  previewMembershipExtension,
}));

import { createCallerFactory } from '~/server/trpc';
import { subscriptionsRouter } from '~/server/routers/subscriptions.router';

const createCaller = createCallerFactory(subscriptionsRouter);

function ctxFor(user: Record<string, unknown> | null, tokenScope = TokenScope.Full) {
  return {
    user,
    acceptableOrigin: true,
    tokenScope,
    // No trpcFlagGuardPerRequest: the flag is evaluated by getFeatureFlags, the real `granted` rule.
    features: { canViewNsfw: true },
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
  } as never;
}

const ONBOARDED = 1 | 2 | 4 | 8;
const grantedMod = {
  id: 5,
  isModerator: true,
  onboarding: ONBOARDED,
  permissions: ['membershipExtend'],
};
const plainMod = { id: 6, isModerator: true, onboarding: ONBOARDED, permissions: [] };
const grantedUser = {
  id: 7,
  isModerator: false,
  onboarding: ONBOARDED,
  permissions: ['membershipExtend'],
};

const extendInput = {
  userId: 10495685,
  days: 3,
  reason: 'Support case 123: 3 free days',
  expectedCurrentPeriodEnd: 1795314120,
};

describe('subscriptions.extendMembership / previewMembershipExtension auth', () => {
  it('a moderator granted membershipExtend gets through (the positive control), with their own id as actor', async () => {
    const caller = createCaller(ctxFor(grantedMod));
    await expect(caller.extendMembership(extendInput)).resolves.toBe('extended');
    await expect(caller.previewMembershipExtension({ userId: 10495685, days: 3 })).resolves.toBe(
      'previewed'
    );
    expect(extendMembership).toHaveBeenCalledWith({ ...extendInput, actorId: 5 });
    expect(previewMembershipExtension).toHaveBeenCalledWith({
      userId: 10495685,
      days: 3,
      actorId: 5,
    });
  });

  it('a moderator without the grant is FORBIDDEN: being a mod is not enough', async () => {
    const caller = createCaller(ctxFor(plainMod));
    await expect(caller.extendMembership(extendInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.previewMembershipExtension({ userId: 10495685, days: 3 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a non-moderator holding the grant is FORBIDDEN', async () => {
    const caller = createCaller(ctxFor(grantedUser));
    await expect(caller.extendMembership(extendInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('signed out is UNAUTHORIZED', async () => {
    const caller = createCaller(ctxFor(null));
    await expect(caller.extendMembership(extendInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('input limits: days 1-31 whole, a reason of 10+ chars, an expectedCurrentPeriodEnd', async () => {
    const caller = createCaller(ctxFor(grantedMod));
    for (const days of [0, 32, 1.5])
      await expect(caller.extendMembership({ ...extendInput, days })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    await expect(
      caller.extendMembership({ ...extendInput, reason: 'short' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const { expectedCurrentPeriodEnd: _, ...noCas } = extendInput;
    await expect(caller.extendMembership(noCas as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

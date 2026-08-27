import type { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  createCallerFactory,
  guardedProcedure,
  guardedProcedureAllowUnverifiedEmail,
  router,
} from '~/server/trpc';

/**
 * Drives the REAL exported procedures, so what is asserted is the middleware CHAIN, not a
 * reimplementation of the predicate. `requiresEmailVerification` being correct says nothing about
 * whether anything calls it; a one-line edit to `guardedProcedure` makes the whole gate inert and
 * every test of the predicate stays green.
 */
const testRouter = router({
  gated: guardedProcedure.meta({ requiredScope: TokenScope.UserWrite }).mutation(() => 'ran'),
  exempt: guardedProcedureAllowUnverifiedEmail
    .meta({ requiredScope: TokenScope.UserWrite })
    .mutation(() => 'ran'),
});

const createCaller = createCallerFactory(testRouter);

const ONBOARDED = 1 | 2 | 4 | 8;

function ctxFor(user: Record<string, unknown> | null) {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { canViewNsfw: true },
    track: {},
    ip: '127.0.0.1',
    cache: {},
    req: undefined,
    res: undefined,
  } as never;
}

const stamped = {
  id: 1,
  onboarding: ONBOARDED,
  emailVerified: null,
  meta: { emailVerificationRequired: true },
};
const legacy = { id: 2, onboarding: ONBOARDED, emailVerified: null, meta: {} };
const verified = {
  id: 3,
  onboarding: ONBOARDED,
  emailVerified: new Date('2026-08-27T00:00:00Z'),
  meta: { emailVerificationRequired: true },
};

describe('guardedProcedure — email verification', () => {
  it('refuses a stamped, unverified account with FORBIDDEN', async () => {
    const caller = createCaller(ctxFor(stamped));
    await expect(caller.gated()).rejects.toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: 'Verify your email address to do this',
      })
    );
  });

  it('carries the flag the client reads to offer the resend', async () => {
    const caller = createCaller(ctxFor(stamped));
    const error = await caller.gated().catch((e: TRPCError) => e);
    expect((error as TRPCError).cause).toMatchObject({ emailVerificationRequired: true });
  });

  /** The §4 population. If this ever goes red, ~7.1M accounts have just lost the ability to post. */
  it('lets a legacy unverified account through', async () => {
    const caller = createCaller(ctxFor(legacy));
    await expect(caller.gated()).resolves.toBe('ran');
  });

  it('lets a verified account through', async () => {
    const caller = createCaller(ctxFor(verified));
    await expect(caller.gated()).resolves.toBe('ran');
  });
});

describe('guardedProcedureAllowUnverifiedEmail', () => {
  it('lets the same stamped account through', async () => {
    const caller = createCaller(ctxFor(stamped));
    await expect(caller.exempt()).resolves.toBe('ran');
  });

  it('still refuses an account that has not finished onboarding', async () => {
    const caller = createCaller(ctxFor({ ...stamped, onboarding: 1 }));
    await expect(caller.exempt()).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('still refuses a signed-out caller', async () => {
    const caller = createCaller(ctxFor(null));
    await expect(caller.exempt()).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED' })
    );
  });
});

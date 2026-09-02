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
  gatedQuery: guardedProcedure.meta({ requiredScope: TokenScope.UserRead }).query(() => 'ran'),
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

  /** The §4 population. If this ever goes red, ~7.1M accounts have just lost the ability to post. */
  it('lets a legacy unverified account through', async () => {
    const caller = createCaller(ctxFor(legacy));
    await expect(caller.gated()).resolves.toBe('ran');
  });

  /**
   * Narrowing the middleware to `type === 'mutation'` was green before this existed. The gate has no
   * business distinguishing them — `orchestrator.statusUpdate` and `model.getTemplateFields` are
   * queries on `guardedProcedure` — and a type check is the obvious "small" way to make a refusal go
   * away.
   */
  it('refuses a QUERY on the same chain, not only a mutation', async () => {
    const caller = createCaller(ctxFor(stamped));
    await expect(caller.gatedQuery()).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' })
    );
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

  /**
   * The exemption drops the EMAIL check and nothing else. Dropping `.use(isMuted)` from it was green
   * across the whole suite, and it sits on `report.create`, `feedback.create` and
   * `user.updateBrowsingMode` — surfaces a muted account reaches for.
   */
  it('still refuses a MUTED account', async () => {
    const caller = createCaller(ctxFor({ ...stamped, muted: true, mutedAt: new Date() }));
    await expect(caller.exempt()).rejects.toThrow(
      expect.objectContaining({
        code: 'FORBIDDEN',
        message: expect.stringContaining('restricted'),
      })
    );
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

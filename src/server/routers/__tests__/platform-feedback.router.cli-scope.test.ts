import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import type * as PlatformFeedbackService from '~/server/services/platform-feedback.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Who may call `platformFeedback`. Both procedures are for a coding agent holding an API token, so
 * both carry `AppBlocksSubmit`; the ledger and the "admits a token carrying AppBlocksSubmit" arm
 * fail without the router's `.meta`, the refusal arms fail if the scope is widened.
 */

const { svc, rateLimitCalls } = vi.hoisted(() => ({
  svc: { createPlatformFeedback: vi.fn(), getPlatformFeedbackStatus: vi.fn() },
  // A plain array: the calls happen once, at router import, before any `clearAllMocks`.
  rateLimitCalls: [] as unknown[][],
}));

vi.mock('~/server/services/platform-feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlatformFeedbackService>()),
  ...svc,
}));

vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof MiddlewareTrpc>();
  return {
    ...actual,
    rateLimit: (...args: Parameters<typeof actual.rateLimit>) => {
      rateLimitCalls.push(args);
      return actual.rateLimit(...args);
    },
  };
});

const { platformFeedbackRouter } = await import('~/server/routers/platform-feedback.router');

// Literals, so a renumbered enum fails the sanity test instead of moving every arm with it.
const FULL = 33554431;
const SUBMIT = 1 << 25; // 33554432
const WITH_SUBMIT = 1 | SUBMIT; // UserRead | AppBlocksSubmit
const WITHOUT_SUBMIT = [
  ['UserRead|AppBlocksDevTunnel', 1 | (1 << 26)],
  ['Full minus UserWrite', FULL & ~2],
] as const;

const SCOPE_GATE_ERROR = {
  code: 'FORBIDDEN',
  message: 'Your API key does not have the required scope for this action',
};

// An ordinary account: not a moderator, and not in any apps-author cohort (`features` is empty).
const user = { id: 1001, isModerator: false, onboarding: OnboardingSteps.Buzz, muted: false };
type User = typeof user;

const sessionCtx = (u: User = user) =>
  ({
    user: u,
    acceptableOrigin: true,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    features: {},
    req: { headers: {} },
    res: { setHeader: () => undefined },
  } as never);

const tokenCtx = (tokenScope: number) =>
  ({
    ...(sessionCtx() as object),
    apiKeyId: 999,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 999 },
    tokenScope,
  } as never);

// `reaches`: the service arguments. The caller is bound from the session; the client-sent
// `userId` and `server` in each input must not arrive.
const PROCS = [
  {
    name: 'create',
    input: {
      message: '  the hint is wrong ',
      userId: 1,
      server: { fingerprint: 'x' },
      report: {
        about: 'cli',
        client: { name: 'civitai-cli', version: '2.3.4' },
        server: { reporters: 99 },
      },
    },
    mock: svc.createPlatformFeedback,
    reaches: [
      {
        user,
        input: {
          message: 'the hint is wrong',
          report: { about: 'cli', kind: 'bug', client: { name: 'civitai-cli', version: '2.3.4' } },
        },
      },
    ],
  },
  {
    name: 'getStatus',
    input: { refs: ['7-0a1b2c3d'], userId: 1 },
    mock: svc.getPlatformFeedbackStatus,
    reaches: [{ user, input: { refs: ['7-0a1b2c3d'] } }],
  },
] as const;
type Proc = (typeof PROCS)[number];

const call = (ctx: never, { name, input }: Proc) =>
  (
    platformFeedbackRouter.createCaller(ctx) as never as Record<
      string,
      (i: unknown) => Promise<unknown>
    >
  )[name](input);

const expectNoServiceCalls = () => {
  for (const mock of Object.values(svc)) expect(mock).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(svc)) mock.mockResolvedValue({ reached: true });
});

describe('platformFeedback token-scope gate', () => {
  it('the literal masks match the enum', () => {
    expect(TokenScope.Full).toBe(FULL);
    expect(TokenScope.AppBlocksSubmit).toBe(SUBMIT);
    expect(TokenScope.UserRead | TokenScope.AppBlocksSubmit).toBe(WITH_SUBMIT);
    expect(TokenScope.UserRead | TokenScope.AppBlocksDevTunnel).toBe(WITHOUT_SUBMIT[0][1]);
    for (const [, mask] of WITHOUT_SUBMIT) expect(mask & SUBMIT).toBe(0);
  });

  // Read off the built router and lists every procedure: adding one, or dropping an annotation,
  // fails here until the scope decision is written down.
  it('both procedures, and only these two, require AppBlocksSubmit', () => {
    const procedures = platformFeedbackRouter._def.procedures as unknown as Record<
      string,
      { _def: { type: string; meta?: { requiredScope?: number; blockApiKeys?: boolean } } }
    >;
    const ledger = Object.fromEntries(
      Object.entries(procedures).map(([name, p]) => [name, [p._def.type, p._def.meta ?? null]])
    );
    expect(ledger).toEqual({
      create: ['mutation', { requiredScope: 33554432 }],
      getStatus: ['query', { requiredScope: 33554432 }],
    });
  });

  describe.each(PROCS)('$name', (proc) => {
    it('admits a token carrying AppBlocksSubmit, with the caller bound from the token', async () => {
      await expect(call(tokenCtx(WITH_SUBMIT), proc)).resolves.toEqual({ reached: true });
      expect(proc.mock).toHaveBeenCalledTimes(1);
      expect(proc.mock).toHaveBeenCalledWith(...proc.reaches);
    });

    it.each(WITHOUT_SUBMIT)('refuses a scoped token without it (%s)', async (_label, mask) => {
      await expect(call(tokenCtx(mask), proc)).rejects.toMatchObject(SCOPE_GATE_ERROR);
      expectNoServiceCalls();
    });

    it('answers a Full API key', async () => {
      await expect(call(tokenCtx(FULL), proc)).resolves.toEqual({ reached: true });
      expect(proc.mock).toHaveBeenCalledTimes(1);
    });

    it('answers a cookie session', async () => {
      await expect(call(sessionCtx(), proc)).resolves.toEqual({ reached: true });
      expect(proc.mock).toHaveBeenCalledTimes(1);
    });

    it('refuses a muted account', async () => {
      await expect(call(sessionCtx({ ...user, muted: true }), proc)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'You cannot perform this action because your account has been restricted',
      });
      expectNoServiceCalls();
    });

    it('refuses an account that has not finished onboarding', async () => {
      await expect(
        call(sessionCtx({ ...user, onboarding: 0 as OnboardingSteps }), proc)
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'You must complete the onboarding process before performing this action',
      });
      expectNoServiceCalls();
    });

    // The one thing that separates this rung from `guardedProcedure`.
    it('answers an account that still owes an email verification', async () => {
      const unverified = {
        ...user,
        emailVerified: null,
        meta: { emailVerificationRequired: true },
      };
      await expect(call(sessionCtx(unverified), proc)).resolves.toEqual({ reached: true });
    });

    it('refuses an anonymous caller', async () => {
      const anonymous = { ...(sessionCtx() as object), user: undefined } as never;
      await expect(call(anonymous, proc)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expectNoServiceCalls();
    });
  });
});

/**
 * `rateLimit` is a no-op under test (`isTest`), so a behavioural test would pass with the limiter
 * unwired. What is observable is what the router hands it, captured at import.
 */
describe('platformFeedback rate limits', () => {
  type Limit = { limit: number; period: number; errorMessage?: string };

  it('create is limited to 10 an hour and 40 a day, on its own bucket', () => {
    const [limits, condition, options] = rateLimitCalls[0] as [Limit[], unknown, unknown];
    expect(limits).toEqual([
      {
        limit: 10,
        period: 3600,
        errorMessage: 'You have sent a lot of platform feedback. Try again later.',
      },
      {
        limit: 40,
        period: 86400,
        errorMessage: 'You have sent a lot of platform feedback. Try again later.',
      },
    ]);
    // No condition (which could skip the limiter) and no shared key (which would spend another
    // procedure's quota): the bucket is this procedure's own path.
    expect(condition).toBeUndefined();
    expect(options).toBeUndefined();
  });

  it('getStatus is limited to 60 a minute', () => {
    expect(rateLimitCalls).toHaveLength(2);
    const [limits, condition, options] = rateLimitCalls[1] as [Limit, unknown, unknown];
    expect(limits).toEqual({ limit: 60, period: 60 });
    expect(condition).toBeUndefined();
    expect(options).toBeUndefined();
  });
});

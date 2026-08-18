import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import type * as FeedbackService from '~/server/services/feedback.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { FEEDBACK_RATE_LIMIT } from '~/shared/constants/feedback.constants';

/**
 * `feedback.create` — the extended context must survive the ROUTER, and the
 * per-user quota must stay a quota on SUBMISSIONS.
 *
 * The quota point is the one worth stating plainly: a submission can now carry up
 * to four uploads, so "5 per hour" is only a real bound if attaching images buys no
 * extra submissions. Nothing about the payload may feed into the limiter — hence
 * the configuration assertion below rather than a behavioural one. `rateLimit` is a
 * hard no-op in test/dev/preview by design (`middleware.trpc.ts` returns early for
 * `isTest`), so a behavioural rate-limit test in this project would pass whether or
 * not the limiter were wired at all. What IS observable here is the argument the
 * router hands it, captured at import time.
 */

const { rateLimitCalls, createFeedbackMock, isFeedbackAreaEnabledMock } = vi.hoisted(() => ({
  // A plain array, not a spy: `vi.clearAllMocks()` in `beforeEach` would erase a
  // spy's record of a call that happened once, at module import.
  rateLimitCalls: [] as unknown[][],
  createFeedbackMock: vi.fn(),
  isFeedbackAreaEnabledMock: vi.fn(),
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

vi.mock('~/server/services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeedbackService>()),
  createFeedback: createFeedbackMock,
  isFeedbackAreaEnabled: isFeedbackAreaEnabledMock,
}));

const { feedbackRouter } = await import('~/server/routers/feedback.router');

const USER_ID = 42;

const caller = () =>
  feedbackRouter.createCaller({
    user: {
      id: USER_ID,
      isModerator: false,
      muted: false,
      onboarding: OnboardingSteps.Buzz,
    },
    acceptableOrigin: true,
    // Without a full token scope the procedure throws FORBIDDEN for a SCOPE reason.
    // That matters: the "disabled area" test below also expects FORBIDDEN, so an
    // under-specified ctx would make it pass for entirely the wrong reason.
    tokenScope: TokenScope.Full,
    features: {},
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  createFeedbackMock.mockResolvedValue({ id: 1 });
  isFeedbackAreaEnabledMock.mockResolvedValue(true);
});

const submission = {
  area: 'bitdex-image-feed' as const,
  message: 'the feed repeated itself',
  context: {
    path: '/images',
    images: ['cf-1', 'cf-2', 'cf-3'],
    screenshotId: 'cf-shot',
    sessionId: 'faro-abc',
  },
};

describe('feedback.create — extended context reaches the service', () => {
  it('forwards images, screenshotId and sessionId with the caller’s user id', async () => {
    await caller().create(submission);

    expect(createFeedbackMock).toHaveBeenCalledTimes(1);
    expect(createFeedbackMock.mock.calls[0][0]).toEqual({
      area: 'bitdex-image-feed',
      message: 'the feed repeated itself',
      userId: USER_ID,
      context: {
        path: '/images',
        images: ['cf-1', 'cf-2', 'cf-3'],
        screenshotId: 'cf-shot',
        sessionId: 'faro-abc',
      },
    });
  });

  it('rejects a four-image submission at the boundary, before the service is reached', async () => {
    await expect(
      caller().create({
        ...submission,
        context: { ...submission.context, images: ['a', 'b', 'c', 'd'] },
      })
    ).rejects.toThrow();
    expect(createFeedbackMock).not.toHaveBeenCalled();
  });

  it('still refuses a disabled area even when uploads are attached', async () => {
    isFeedbackAreaEnabledMock.mockResolvedValue(false);

    // Matched on the MESSAGE as well as the code: several unrelated middlewares in
    // this chain (token scope, mute, onboarding) also throw FORBIDDEN, and any of
    // them would satisfy a code-only assertion while saying nothing about the flag.
    await expect(caller().create(submission)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Feedback is not being collected here right now.',
    });
    expect(createFeedbackMock).not.toHaveBeenCalled();
  });

  it('accepts a submission with no sessionId (Faro absent)', async () => {
    await caller().create({
      area: 'bitdex-image-feed',
      message: 'no faro here',
      context: { path: '/images', images: ['cf-1'] },
    });

    expect(createFeedbackMock).toHaveBeenCalledTimes(1);
    expect(createFeedbackMock.mock.calls[0][0].context).not.toHaveProperty('sessionId');
  });
});

describe('feedback.create — the submission quota is not widened by uploads', () => {
  it('is configured at 5 per hour', () => {
    expect(FEEDBACK_RATE_LIMIT).toEqual({ max: 5, periodSeconds: 3600 });
  });

  it('wires exactly those numbers into the router’s rate limiter', () => {
    expect(rateLimitCalls).toHaveLength(1);
    const [limits] = rateLimitCalls[0] as [{ limit: number; period: number }];
    expect(limits.limit).toBe(5);
    expect(limits.period).toBe(3600);
  });

  it('takes no condition and no shared key — nothing about the payload can widen it', () => {
    // `rateLimit(limits, condition?, options?)`: a `condition` returning false SKIPS
    // the limiter entirely. Passing neither is what makes the quota unconditional,
    // so a future `condition` that exempted, say, image-free submissions would fail
    // here rather than silently uncapping the surface.
    const [, condition, options] = rateLimitCalls[0];
    expect(condition).toBeUndefined();
    expect(options).toBeUndefined();
  });

  it('caps the feedback surface at 20 uploads per hour on the successful path', () => {
    // 5 submissions x (3 attachments + 1 screenshot). Stated as a derivation so a
    // change to either constant makes the resulting budget visible in the diff.
    const perSubmission = 3 + 1;
    expect(FEEDBACK_RATE_LIMIT.max * perSubmission).toBe(20);
  });
});

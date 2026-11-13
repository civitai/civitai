import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingSteps } from '~/server/common/enums';
import type * as AppFeedbackService from '~/server/services/blocks/app-feedback.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `appFeedback` procedure wiring.
 *
 * Drives the real routers through `createCaller`, so the procedure tiers (protected / guarded /
 * moderator) decide; the service is replaced only where a test needs to see what reached it.
 */

const svc = vi.hoisted(() => ({
  createAppFeedback: vi.fn(),
  getAppFeedbackEligibility: vi.fn(),
  modListAppFeedback: vi.fn(),
  modCountFlaggedAppFeedback: vi.fn(),
  modSetAppFeedbackHidden: vi.fn(),
}));

vi.mock('~/server/services/blocks/app-feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppFeedbackService>()),
  createAppFeedback: svc.createAppFeedback,
  getAppFeedbackEligibility: svc.getAppFeedbackEligibility,
  modListAppFeedback: svc.modListAppFeedback,
  modCountFlaggedAppFeedback: svc.modCountFlaggedAppFeedback,
  modSetAppFeedbackHidden: svc.modSetAppFeedbackHidden,
}));

const { appFeedbackRouter } = await import('~/server/routers/app-feedback.router');

const ctx = (user: Record<string, unknown> | undefined) =>
  ({
    user: user && { onboarding: OnboardingSteps.Buzz, muted: false, ...user },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: {},
    req: { headers: {} },
    res: { setHeader: () => undefined },
  } as never);

const reporter = { id: 1001, isModerator: false };
const moderator = { id: 6006, isModerator: true };

beforeEach(() => {
  vi.clearAllMocks();
  svc.createAppFeedback.mockResolvedValue({ id: 1 });
  svc.getAppFeedbackEligibility.mockResolvedValue({ eligible: false });
  svc.modListAppFeedback.mockResolvedValue({ items: [], nextCursor: undefined });
  svc.modCountFlaggedAppFeedback.mockResolvedValue(0);
  svc.modSetAppFeedbackHidden.mockResolvedValue({ id: 9, hidden: true });
});

describe('appFeedback.create', () => {
  it('stores only { surface, modelId } of a hand-crafted context', async () => {
    await appFeedbackRouter.createCaller(ctx(reporter)).create({
      target: { appBlockId: 'blk_1' },
      message: '  slow to load  ',
      context: {
        surface: 'slot',
        modelId: 12,
        consoleErrors: [{ message: 'boom', count: 1 }],
        networkErrors: [{ url: '/x', status: 500, initiatorType: 'fetch' }],
        sessionId: 'faro-123',
        screenshotId: '99999999-8888-4777-b666-555544443333',
        images: ['11111111-2222-4333-8444-555555555555'],
        path: '/models/1',
      } as never,
    });
    expect(svc.createAppFeedback).toHaveBeenCalledTimes(1);
    expect(svc.createAppFeedback.mock.calls[0][0].input).toEqual({
      target: { appBlockId: 'blk_1' },
      message: 'slow to load',
      context: { surface: 'slot', modelId: 12 },
    });
  });

  it('rejects a target naming both a slug and an AppBlock', async () => {
    await expect(
      appFeedbackRouter.createCaller(ctx(reporter)).create({
        target: { slug: 'a', appBlockId: 'b' } as never,
        message: 'hi',
        context: { surface: 'page' },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(svc.createAppFeedback).not.toHaveBeenCalled();
  });

  it('refuses a muted user before the service', async () => {
    await expect(
      appFeedbackRouter.createCaller(ctx({ ...reporter, muted: true })).create({
        target: { slug: 'a' },
        message: 'hi',
        context: { surface: 'page' },
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You cannot perform this action because your account has been restricted',
    });
    expect(svc.createAppFeedback).not.toHaveBeenCalled();
  });
});

describe('appFeedback.getEligibility', () => {
  it('forwards the session user and the target', async () => {
    await appFeedbackRouter.createCaller(ctx(reporter)).getEligibility({ target: { slug: 'a' } });
    expect(svc.getAppFeedbackEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1001 }),
      { slug: 'a' }
    );
  });

  it('refuses a user who has not finished onboarding, as create does', async () => {
    const c = appFeedbackRouter.createCaller(ctx({ ...reporter, onboarding: 0 }));
    await expect(c.getEligibility({ target: { slug: 'a' } })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You must complete the onboarding process before performing this action',
    });
    await expect(
      c.create({ target: { slug: 'a' }, message: 'hi', context: { surface: 'page' } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(svc.getAppFeedbackEligibility).not.toHaveBeenCalled();
    expect(svc.createAppFeedback).not.toHaveBeenCalled();
  });

  it('requires a signed-in user', async () => {
    await expect(
      appFeedbackRouter.createCaller(ctx(undefined)).getEligibility({ target: { slug: 'a' } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(svc.getAppFeedbackEligibility).not.toHaveBeenCalled();
  });
});

describe('moderator procedures', () => {
  const calls = {
    modList: (c: ReturnType<typeof appFeedbackRouter.createCaller>) => c.modList({}),
    modCountFlagged: (c: ReturnType<typeof appFeedbackRouter.createCaller>) => c.modCountFlagged(),
    modSetHidden: (c: ReturnType<typeof appFeedbackRouter.createCaller>) =>
      c.modSetHidden({ id: 9, hidden: true }),
  };

  // The message is `moderatorProcedure`'s own, so this pins that the PROCEDURE refuses — there is
  // no per-handler recheck behind it. Paired with the moderator cases below, which reach the service.
  it.each(Object.entries(calls))('%s refuses a non-moderator', async (_name, call) => {
    await expect(call(appFeedbackRouter.createCaller(ctx(reporter)))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission to perform this action',
    });
    expect(svc.modListAppFeedback).not.toHaveBeenCalled();
    expect(svc.modCountFlaggedAppFeedback).not.toHaveBeenCalled();
    expect(svc.modSetAppFeedbackHidden).not.toHaveBeenCalled();
  });

  it('modSetHidden binds the actor to the session, never the input', async () => {
    await appFeedbackRouter
      .createCaller(ctx(moderator))
      .modSetHidden({ id: 9, hidden: true, moderatorId: 1 } as never);
    expect(svc.modSetAppFeedbackHidden).toHaveBeenCalledWith({
      moderatorId: 6006,
      input: { id: 9, hidden: true },
    });
  });

  it('modCountFlagged answers a moderator', async () => {
    svc.modCountFlaggedAppFeedback.mockResolvedValueOnce(4);
    expect(await appFeedbackRouter.createCaller(ctx(moderator)).modCountFlagged()).toBe(4);
  });

  it('modList applies the input defaults', async () => {
    await appFeedbackRouter.createCaller(ctx(moderator)).modList({});
    expect(svc.modListAppFeedback).toHaveBeenCalledWith({ limit: 50, hidden: 'all' });
  });

  it('modList accepts flagged: true and refuses flagged: false at the schema', async () => {
    const c = appFeedbackRouter.createCaller(ctx(moderator));
    await c.modList({ flagged: true });
    expect(svc.modListAppFeedback).toHaveBeenCalledWith({
      limit: 50,
      hidden: 'all',
      flagged: true,
    });
    svc.modListAppFeedback.mockClear();
    await expect(c.modList({ flagged: false } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(svc.modListAppFeedback).not.toHaveBeenCalled();
  });

  it('modList accepts listingDeleted: true and refuses listingDeleted: false at the schema', async () => {
    const c = appFeedbackRouter.createCaller(ctx(moderator));
    await c.modList({ listingDeleted: true });
    expect(svc.modListAppFeedback).toHaveBeenCalledWith({
      limit: 50,
      hidden: 'all',
      listingDeleted: true,
    });
    svc.modListAppFeedback.mockClear();
    await expect(c.modList({ listingDeleted: false } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(svc.modListAppFeedback).not.toHaveBeenCalled();
  });
});

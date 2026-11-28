import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppAccessRequestService from '~/server/services/app-access-request.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { APP_ACCESS_WHAT_TO_BUILD_TOO_LONG } from '~/server/schema/app-access-request.schema';

/**
 * `appAccessRequest.*` through the REAL router and middleware: who may call what, and what the
 * validation lets through. The service is replaced so these tests measure the router alone; its SQL
 * is covered against real rows in `services/__tests__/app-access-request.service.test.ts`.
 */

const { service } = vi.hoisted(() => ({
  service: {
    submit: vi.fn(),
    getMine: vi.fn(),
    list: vi.fn(),
    countPending: vi.fn(),
    decide: vi.fn(),
  },
}));

vi.mock('~/server/services/app-access-request.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAccessRequestService>()),
  submitAppAccessRequest: service.submit,
  getMyAppAccessRequest: service.getMine,
  listAppAccessRequests: service.list,
  countPendingAppAccessRequests: service.countPending,
  decideAppAccessRequest: service.decide,
}));

const { appAccessRequestRouter } = await import('~/server/routers/app-access-request.router');

const REQUESTER_ID = 4127;
const MODERATOR_ID = 88;
const IDEA = 'A colour-palette picker that builds prompts from the images I have liked.';

const ctx = (user: object | null) =>
  ({
    user,
    acceptableOrigin: true,
    // A narrower scope would FORBID for a scope reason and make the FORBIDDEN cases below pass for
    // the wrong one.
    tokenScope: TokenScope.Full,
    features: {},
  } as never);

const requester = {
  id: REQUESTER_ID,
  isModerator: false,
  muted: false,
  onboarding: OnboardingSteps.Buzz,
};
const moderator = { ...requester, id: MODERATOR_ID, isModerator: true };

const asAnon = () => appAccessRequestRouter.createCaller(ctx(null));
const asRequester = () => appAccessRequestRouter.createCaller(ctx(requester));
const asModerator = () => appAccessRequestRouter.createCaller(ctx(moderator));

beforeEach(() => {
  vi.clearAllMocks();
  service.submit.mockResolvedValue({ id: 31, status: 'pending' });
  service.getMine.mockResolvedValue(null);
  service.list.mockResolvedValue({ items: [], nextCursor: null });
  service.countPending.mockResolvedValue(0);
  service.decide.mockResolvedValue({ id: 31, status: 'approved' });
});

describe('sign-in is required', () => {
  it('refuses submit and getMine without a user, before the service is reached', async () => {
    await expect(asAnon().submit({ whatToBuild: IDEA })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(asAnon().getMine()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(service.submit).not.toHaveBeenCalled();
    expect(service.getMine).not.toHaveBeenCalled();
  });
});

describe('submit', () => {
  // The CALLER's session user: the service reads the auto-approve flag with it, per user.
  it('passes the CALLER’s session user with the trimmed text, and nothing else', async () => {
    await asRequester().submit({ whatToBuild: `  ${IDEA}  ` });
    expect(service.submit).toHaveBeenCalledWith({
      user: requester,
      input: { whatToBuild: IDEA },
    });
  });

  it('🔴 a client cannot set its own status, reviewer or user id — those keys never reach the service', async () => {
    await asRequester().submit({
      whatToBuild: IDEA,
      status: 'approved',
      reviewedById: MODERATOR_ID,
      userId: 1,
      appBuilderApproved: true,
    } as never);
    expect(service.submit).toHaveBeenCalledWith({
      user: requester,
      input: { whatToBuild: IDEA },
    });
    expect(service.submit.mock.calls[0][0].user.id).toBe(REQUESTER_ID);
  });

  it('refuses too long with BAD_REQUEST and its message', async () => {
    const error = await asRequester()
      .submit({ whatToBuild: 'x'.repeat(2001) })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String((error as Error).message)).toContain(APP_ACCESS_WHAT_TO_BUILD_TOO_LONG);
    expect(service.submit).not.toHaveBeenCalled();
  });

  // The answer is OPTIONAL: a request is one click.
  it.each([
    ['an empty answer', { whatToBuild: '' }, ''],
    ['only whitespace', { whatToBuild: '   ' }, ''],
    ['no answer at all', {}, ''],
    ['a short answer', { whatToBuild: ' a game ' }, 'a game'],
  ])('🔴 accepts %s, as the trimmed (possibly empty) text', async (_label, input, stored) => {
    await asRequester().submit(input as never);
    expect(service.submit).toHaveBeenCalledTimes(1);
    expect(service.submit.mock.calls[0][0].input).toEqual({ whatToBuild: stored });
  });

  it('accepts the upper boundary: 2000 characters', async () => {
    await asRequester().submit({ whatToBuild: 'z'.repeat(2000) });
    expect(service.submit).toHaveBeenCalledTimes(1);
  });
});

describe('only moderators can list and decide', () => {
  it('refuses a signed-in non-moderator', async () => {
    await expect(asRequester().list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(asRequester().decide({ id: 31, decision: 'approved' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(asRequester().decide({ id: 31, decision: 'declined' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(service.list).not.toHaveBeenCalled();
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('refuses anyone signed out', async () => {
    await expect(asAnon().list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(asAnon().decide({ id: 31, decision: 'declined' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(service.decide).not.toHaveBeenCalled();
  });

  it('lets a moderator list, with the default page size', async () => {
    await asModerator().list({ status: 'pending' });
    expect(service.list).toHaveBeenCalledWith({ status: 'pending', limit: 50 });
  });

  it.each(['approved', 'declined'] as const)(
    'lets a moderator record %s, attributed to THEM',
    async (decision) => {
      await asModerator().decide({ id: 31, decision });
      expect(service.decide).toHaveBeenCalledWith({
        moderatorId: MODERATOR_ID,
        input: { id: 31, decision },
      });
    }
  );

  it('refuses a decision outside approve/decline', async () => {
    await expect(
      asModerator().decide({ id: 31, decision: 'pending' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(service.decide).not.toHaveBeenCalled();
  });
});

describe('countPending — the /apps/review tab badge', () => {
  it('answers a moderator with the service’s pending count', async () => {
    // 137: past the list proc's 100-row page ceiling, so a badge still reading one list page
    // could not produce it.
    service.countPending.mockResolvedValueOnce(137);
    expect(await asModerator().countPending()).toBe(137);
    expect(service.countPending).toHaveBeenCalledTimes(1);
  });

  it('refuses a signed-in non-moderator, before the service is reached', async () => {
    await expect(asRequester().countPending()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(service.countPending).not.toHaveBeenCalled();
  });

  it('refuses anyone signed out, before the service is reached', async () => {
    await expect(asAnon().countPending()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(service.countPending).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import type * as AppAccessRequestService from '~/server/services/app-access-request.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { APP_ACCESS_REQUEST_SUBMIT_RATE_LIMITS } from '~/shared/constants/app-access-request.constants';
import {
  APP_ACCESS_LINK_INVALID,
  APP_ACCESS_TOO_MANY_LINKS,
  APP_ACCESS_UNSTORABLE_MESSAGE,
  APP_ACCESS_WHAT_TO_BUILD_TOO_LONG,
  APP_ACCESS_WHAT_TO_BUILD_TOO_SHORT,
} from '~/server/schema/app-access-request.schema';

/**
 * `appAccessRequest.*` through the REAL router and middleware: who may call what, what the
 * validation lets through, and which limiter guards `submit`. The service is replaced so these
 * tests measure the router alone; its SQL is covered against real rows in
 * `services/__tests__/app-access-request.service.test.ts`.
 */

const { rateLimitCalls, built, service } = vi.hoisted(() => ({
  // Plain arrays, not spies: `clearAllMocks` would erase a record of calls made at import.
  rateLimitCalls: [] as unknown[][],
  built: new Set<unknown>(),
  service: {
    submit: vi.fn(),
    getMine: vi.fn(),
    list: vi.fn(),
    decide: vi.fn(),
  },
}));

vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof MiddlewareTrpc>();
  return {
    ...actual,
    rateLimit: (...args: Parameters<typeof actual.rateLimit>) => {
      rateLimitCalls.push(args);
      const middleware = actual.rateLimit(...args);
      built.add(middleware);
      for (const fn of (middleware as unknown as { _middlewares?: unknown[] })._middlewares ?? [])
        built.add(fn);
      return middleware;
    },
  };
});

vi.mock('~/server/services/app-access-request.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppAccessRequestService>()),
  submitAppAccessRequest: service.submit,
  getMyAppAccessRequest: service.getMine,
  listAppAccessRequests: service.list,
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
const moderator = {
  id: MODERATOR_ID,
  isModerator: true,
  muted: false,
  onboarding: OnboardingSteps.Buzz,
};

const asAnon = () => appAccessRequestRouter.createCaller(ctx(null));
const asRequester = () => appAccessRequestRouter.createCaller(ctx(requester));
const asModerator = () => appAccessRequestRouter.createCaller(ctx(moderator));

beforeEach(() => {
  vi.clearAllMocks();
  service.submit.mockResolvedValue({ id: 31, status: 'pending' });
  service.getMine.mockResolvedValue(null);
  service.list.mockResolvedValue({ items: [], nextCursor: null });
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

  it('refuses a banned account', async () => {
    await expect(
      appAccessRequestRouter
        .createCaller(ctx({ ...requester, bannedAt: new Date('2026-09-14T08:00:00Z') }))
        .submit({ whatToBuild: IDEA })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(service.submit).not.toHaveBeenCalled();
  });
});

describe('submit', () => {
  it('passes the CALLER’s id with the trimmed text and links', async () => {
    await asRequester().submit({
      whatToBuild: `  ${IDEA}  `,
      links: [' https://example.com/palette-mock '],
    });
    expect(service.submit).toHaveBeenCalledWith({
      userId: REQUESTER_ID,
      input: { whatToBuild: IDEA, links: ['https://example.com/palette-mock'] },
    });
  });

  it('defaults links to none', async () => {
    await asRequester().submit({ whatToBuild: IDEA });
    expect(service.submit.mock.calls[0][0].input.links).toEqual([]);
  });

  it.each([
    ['too short', { whatToBuild: 'a game' }, APP_ACCESS_WHAT_TO_BUILD_TOO_SHORT],
    [
      'only whitespace past the minimum',
      { whatToBuild: `short idea${' '.repeat(30)}` },
      APP_ACCESS_WHAT_TO_BUILD_TOO_SHORT,
    ],
    ['too long', { whatToBuild: 'x'.repeat(2001) }, APP_ACCESS_WHAT_TO_BUILD_TOO_LONG],
    ['a NUL byte', { whatToBuild: `${IDEA}\u0000` }, APP_ACCESS_UNSTORABLE_MESSAGE],
    [
      'a javascript: link',
      { whatToBuild: IDEA, links: ['javascript:alert(1)'] },
      APP_ACCESS_LINK_INVALID,
    ],
    ['a relative link', { whatToBuild: IDEA, links: ['/apps/build'] }, APP_ACCESS_LINK_INVALID],
    [
      'six links',
      { whatToBuild: IDEA, links: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`) },
      APP_ACCESS_TOO_MANY_LINKS,
    ],
  ])('refuses %s with BAD_REQUEST and its message', async (_label, input, message) => {
    const error = await asRequester()
      .submit(input as never)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(String((error as Error).message)).toContain(message);
    expect(service.submit).not.toHaveBeenCalled();
  });

  it('accepts the boundaries: 20 characters, 2000 characters, five links', async () => {
    await asRequester().submit({ whatToBuild: 'y'.repeat(20) });
    await asRequester().submit({
      whatToBuild: 'z'.repeat(2000),
      links: Array.from({ length: 5 }, (_, i) => `http://example.org/ref-${i}`),
    });
    expect(service.submit).toHaveBeenCalledTimes(2);
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

type ProcedureDef = { _def: { middlewares: unknown[] } };
const procedure = (name: string) =>
  (appAccessRequestRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })._def
    .procedures[name];

describe('submit is rate-limited', () => {
  // `rateLimit` skips itself under test, so what is pinned here is that `submit` is BUILT with it,
  // at these numbers; `app-access-request.rate-limit.test.ts` drives the numbers through the real
  // middleware.
  it('is built with 10 an hour and 40 a day', () => {
    expect(
      APP_ACCESS_REQUEST_SUBMIT_RATE_LIMITS.map(({ limit, period }) => ({ limit, period }))
    ).toEqual([
      { limit: 10, period: 3600 },
      { limit: 40, period: 86400 },
    ]);
    expect(rateLimitCalls).toContainEqual([APP_ACCESS_REQUEST_SUBMIT_RATE_LIMITS]);
  });

  it('carries that limiter in its own middleware chain', () => {
    expect(procedure('submit')._def.middlewares.filter((m) => built.has(m))).toHaveLength(1);
  });

  it('is the only procedure that carries one (the control)', () => {
    for (const name of ['getMine', 'list', 'decide'])
      expect(procedure(name)._def.middlewares.filter((m) => built.has(m))).toHaveLength(0);
  });
});

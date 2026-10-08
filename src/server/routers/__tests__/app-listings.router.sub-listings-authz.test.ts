import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Sub-listings tab on `/apps/review` is moderated by the same people as the app review
 * queue. The page admits a viewer by `isAppReviewer`; these procedures must admit exactly the
 * same viewers, so each case asserts the page predicate and the procedure TOGETHER.
 */

const { mockList, mockCount, mockModerate } = vi.hoisted(() => ({
  mockList: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  mockCount: vi.fn(async () => 3),
  mockModerate: vi.fn(async () => ({ id: 'asl_1', status: 'approved', pendingEdit: false })),
}));

vi.mock('~/server/services/blocks/app-sub-listing.service', () => ({
  listSubListingQueue: mockList,
  countSubListingQueue: mockCount,
  moderateSubListing: mockModerate,
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { appListingsRouter } from '../app-listings.router';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';
import { TokenScope } from '~/shared/constants/token-scope.constants';

function fakeCtx(user: unknown) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

const V = '2026-10-01T00:00:00.000Z';
const reviewer = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const regular = { id: 2, isModerator: false, tier: 'free', username: 'user', onboarding: 0x1f };

const procs = {
  list: (c: ReturnType<typeof appListingsRouter.createCaller>) => c.listSubListingQueue({}),
  count: (c: ReturnType<typeof appListingsRouter.createCaller>) => c.countSubListingQueue(),
  moderate: (c: ReturnType<typeof appListingsRouter.createCaller>) =>
    c.moderateSubListing({ id: 'asl_1', action: 'approve', version: V }),
};

beforeEach(() => vi.clearAllMocks());

describe('Sub-listing moderation follows the app review queue’s audience', () => {
  it.each(Object.entries(procs))(
    'a user who can see the review queue can call %s',
    async (_name, run) => {
      expect(isAppReviewer(reviewer)).toBe(true);
      await expect(
        run(appListingsRouter.createCaller(fakeCtx(reviewer) as never))
      ).resolves.toBeTruthy();
    }
  );

  it.each(Object.entries(procs))('a regular user is FORBIDDEN from %s', async (_name, run) => {
    expect(isAppReviewer(regular)).toBe(false);
    await expect(
      run(appListingsRouter.createCaller(fakeCtx(regular) as never))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCount).not.toHaveBeenCalled();
    expect(mockModerate).not.toHaveBeenCalled();
  });

  it('an anonymous caller is refused before any service runs', async () => {
    await expect(
      appListingsRouter.createCaller(fakeCtx(undefined) as never).countSubListingQueue()
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('records the acting moderator from the session, never the input', async () => {
    await appListingsRouter
      .createCaller(fakeCtx(reviewer) as never)
      .moderateSubListing({ id: 'asl_1', action: 'hide', reason: 'spam', version: V });
    expect(mockModerate).toHaveBeenCalledWith({
      input: { id: 'asl_1', action: 'hide', reason: 'spam', version: V },
      moderatorId: reviewer.id,
    });
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'TOO_MANY_REQUESTS'],
    [503, 'SERVICE_UNAVAILABLE'],
    [400, 'BAD_REQUEST'],
  ])('maps a service %i refusal to %s', async (status, code) => {
    mockModerate.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { name: 'SubListingError', status })
    );
    await expect(
      appListingsRouter
        .createCaller(fakeCtx(reviewer) as never)
        .moderateSubListing({ id: 'asl_1', action: 'approve', version: V })
    ).rejects.toMatchObject({ code });
  });

  it('returns the queue count for the tab label', async () => {
    await expect(
      appListingsRouter.createCaller(fakeCtx(reviewer) as never).countSubListingQueue()
    ).resolves.toEqual({ count: 3 });
  });
});

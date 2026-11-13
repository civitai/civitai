import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `appListings.setListingOfficial` — the moderator-only setter for the "Official" flag.
 *
 * Drives the REAL `appListingsRouter` via `createCaller`, so the middleware wiring decides who
 * may call it: a moderator reaches the service with the actor bound to `ctx.user.id`; a
 * non-moderator — including the listing's own OWNER — is FORBIDDEN and the service is never
 * reached. The service itself (SQL, audit event, migration window) is covered against a real
 * Postgres in `app-listing-official.service.test.ts`.
 */

const { mockSetOfficial, mockIsAppBlocksEnabled, mockIsAppBlocksAuthorEnabled } = vi.hoisted(
  () => ({
    mockSetOfficial: vi.fn(
      async (args: { appListingId: string; isOfficial: boolean; moderatorUserId: number }) => ({
        appListingId: args.appListingId,
        isOfficial: args.isOfficial,
        changed: true,
      })
    ),
    mockIsAppBlocksEnabled: vi.fn(),
    mockIsAppBlocksAuthorEnabled: vi.fn(),
  })
);

vi.mock('~/server/services/blocks/app-listing-official.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setListingOfficialAsModerator: mockSetOfficial,
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: () => false,
  isRedCapableHost: () => false,
}));

import { appListingsRouter } from '../app-listings.router';
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

// Distinct ids: the moderator, an unrelated non-moderator, and the listing's owner.
const mod = { id: 1001, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const tester = { id: 2002, isModerator: false, tier: 'free', username: 'tester', onboarding: 0x1f };
const owner = { id: 3003, isModerator: false, tier: 'free', username: 'owner', onboarding: 0x1f };
const LISTING = 'apl_owned_by_3003';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockImplementation((opts?: { user?: { isModerator?: boolean } }) =>
    Promise.resolve(!!opts?.user?.isModerator)
  );
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(true);
});

describe('appListings.setListingOfficial — moderator only', () => {
  it('a moderator can SET the flag; the actor is the session user, never client-supplied', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.setListingOfficial({ appListingId: LISTING, isOfficial: true })
    ).resolves.toEqual({ appListingId: LISTING, isOfficial: true, changed: true });
    expect(mockSetOfficial).toHaveBeenCalledTimes(1);
    expect(mockSetOfficial).toHaveBeenCalledWith({
      appListingId: LISTING,
      isOfficial: true,
      moderatorUserId: mod.id,
    });
  });

  it('a moderator can CLEAR the flag', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.setListingOfficial({ appListingId: LISTING, isOfficial: false })
    ).resolves.toMatchObject({ isOfficial: false });
    expect(mockSetOfficial).toHaveBeenCalledWith({
      appListingId: LISTING,
      isOfficial: false,
      moderatorUserId: mod.id,
    });
  });

  it('an extra `moderatorUserId` in the input cannot spoof the actor', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.setListingOfficial({
      appListingId: LISTING,
      isOfficial: true,
      moderatorUserId: 9999,
    } as never);
    expect(mockSetOfficial.mock.calls[0][0].moderatorUserId).toBe(mod.id);
  });

  it.each([
    ['a non-moderator', tester],
    ["the listing's OWNER (not a moderator)", owner],
  ])('%s is FORBIDDEN and the service is never reached', async (_label, user) => {
    const caller = appListingsRouter.createCaller(fakeCtx(user) as never);
    for (const isOfficial of [true, false]) {
      await expect(
        caller.setListingOfficial({ appListingId: LISTING, isOfficial })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(mockSetOfficial).not.toHaveBeenCalled();
  });

  it('an anonymous caller is UNAUTHORIZED', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(
      caller.setListingOfficial({ appListingId: LISTING, isOfficial: true })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockSetOfficial).not.toHaveBeenCalled();
  });

  it('the input requires a boolean — a missing or non-boolean flag is BAD_REQUEST', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(
      caller.setListingOfficial({ appListingId: LISTING } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.setListingOfficial({ appListingId: LISTING, isOfficial: 'true' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockSetOfficial).not.toHaveBeenCalled();
  });
});

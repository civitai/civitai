import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * `appListings.listMyApps` — the `/apps` "My apps" home read.
 *
 * Three properties, each a way a caller would notice it broken:
 *   1. a signed-out caller is refused (it is a per-user read);
 *   2. a caller the store gate leaves dark (`none`) is refused, and the service never runs;
 *   3. the user it reads is `ctx.user.id` — there is no input that can name another user.
 *
 * Mocks mirror `app-listings.router.read-flag-gate.test.ts`: the scope resolver is faked
 * per caller (moderator → `full`, everyone else → `none`), the services are stubbed so the
 * router's import graph never loads Prisma.
 */

const { mockResolveStoreVisibilityScope, mockListMyApps, mockHide, mockUnhide } = vi.hoisted(
  () => ({
    mockResolveStoreVisibilityScope: vi.fn(),
    mockListMyApps: vi.fn(),
    mockHide: vi.fn(),
    mockUnhide: vi.fn(),
  })
);

vi.mock('~/server/services/app-blocks-flag', () => ({
  resolveStoreVisibilityScope: mockResolveStoreVisibilityScope,
  resolveViewerAudienceFloor: vi.fn(async () => 'public'),
}));
vi.mock('~/server/services/blocks/my-apps.service', () => ({
  listMyApps: (...a: unknown[]) => mockListMyApps(...a),
}));
vi.mock('~/server/services/blocks/my-apps-hidden.service', () => ({
  hideMyApp: (...a: unknown[]) => mockHide(...a),
  unhideMyApp: (...a: unknown[]) => mockUnhide(...a),
}));
vi.mock('~/server/services/blocks/app-listing.service', () => ({
  listAvailableListings: vi.fn(),
  getListingDetail: vi.fn(),
  getListingCard: vi.fn(),
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

function fakeCtx(user: unknown, features: Record<string, boolean> = {}) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: features as never,
    track: undefined,
  };
}

const modUser = { id: 41, isModerator: true, tier: 'free', username: 'mod' };
const otherMod = { id: 73, isModerator: true, tier: 'free', username: 'mod2' };
const normalUser = { id: 58, isModerator: false, tier: 'free', username: 'user' };

beforeEach(() => {
  mockResolveStoreVisibilityScope.mockReset();
  mockResolveStoreVisibilityScope.mockImplementation(
    async (opts?: { user?: { isModerator?: boolean } }) =>
      opts?.user?.isModerator ? 'full' : 'none'
  );
  mockListMyApps.mockReset();
  mockListMyApps.mockImplementation(async (args: { userId: number }) => ({
    apps: [{ listingId: `apl_for_${args.userId}` }],
    removedCount: args.userId,
    hidden: { [`hidden-for-${args.userId}`]: '2026-10-10T11:22:33.000Z' },
  }));
  mockHide.mockReset();
  mockHide.mockImplementation(async (args: { slug: string }) => ({
    slug: args.slug,
    hiddenAt: '2026-10-10T11:22:33.000Z',
  }));
  mockUnhide.mockReset();
  mockUnhide.mockImplementation(async (args: { slug: string }) => ({ slug: args.slug }));
});

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(TRPCError);
    return (err as TRPCError).code;
  }
}

describe('appListings.listMyApps', () => {
  it('rejects a signed-out caller, and never reads', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    expect(await codeOf(caller.listMyApps())).toBe('UNAUTHORIZED');
    expect(mockListMyApps).not.toHaveBeenCalled();
  });

  it('rejects a signed-in caller the store gate leaves dark (flag off), and never reads', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(normalUser) as never);
    expect(await codeOf(caller.listMyApps())).toBe('UNAUTHORIZED');
    expect(mockListMyApps).not.toHaveBeenCalled();
    // Control: the scope resolver really was consulted for THIS user — the refusal is the
    // flag gate, not the auth gate firing for some other reason.
    expect(mockResolveStoreVisibilityScope).toHaveBeenCalledWith({ user: normalUser });
  });

  it('reads the CALLER — two users, each gets their own rows', async () => {
    const a = await appListingsRouter.createCaller(fakeCtx(modUser) as never).listMyApps();
    const b = await appListingsRouter.createCaller(fakeCtx(otherMod) as never).listMyApps();
    // The service's payload for the caller, passed through whole (the hides are read inside
    // the service, keyed on the same userId — `my-apps.service.test.ts`).
    expect(a).toEqual({
      apps: [{ listingId: 'apl_for_41' }],
      removedCount: 41,
      hidden: { 'hidden-for-41': '2026-10-10T11:22:33.000Z' },
    });
    expect(b).toEqual({
      apps: [{ listingId: 'apl_for_73' }],
      removedCount: 73,
      hidden: { 'hidden-for-73': '2026-10-10T11:22:33.000Z' },
    });
    expect(mockListMyApps.mock.calls.map(([args]) => (args as { userId: number }).userId)).toEqual([
      41, 73,
    ]);
  });

  it('🔴 an input naming another user is ignored — the read is still the caller', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(modUser) as never);
    // Not part of the procedure's type; a hostile client can still send it.
    await (caller.listMyApps as unknown as (input: unknown) => Promise<unknown>)({ userId: 73 });
    expect(mockListMyApps).toHaveBeenCalledTimes(1);
    expect(mockListMyApps.mock.calls[0][0]).toMatchObject({ userId: 41, scope: 'full' });
  });

  it('threads the page-app flag through as canOpenPage', async () => {
    await appListingsRouter
      .createCaller(fakeCtx(modUser, { appBlocksPages: true }) as never)
      .listMyApps();
    await appListingsRouter.createCaller(fakeCtx(modUser, {}) as never).listMyApps();
    expect(
      mockListMyApps.mock.calls.map(([args]) => (args as { canOpenPage: boolean }).canOpenPage)
    ).toEqual([true, false]);
  });
});

describe.each([
  ['hideMyApp', () => mockHide],
  ['unhideMyApp', () => mockUnhide],
] as const)('appListings.%s', (proc, mock) => {
  const call = (user: unknown, input: unknown) =>
    (
      appListingsRouter.createCaller(fakeCtx(user) as never) as unknown as Record<
        string,
        (i: unknown) => Promise<unknown>
      >
    )[proc](input);

  it('🔴 rejects a signed-out caller, and never writes', async () => {
    expect(await codeOf(call(undefined, { slug: 'pixel-forge' }))).toBe('UNAUTHORIZED');
    expect(mock()).not.toHaveBeenCalled();
  });

  it('rejects a caller the store gate leaves dark, and never writes', async () => {
    expect(await codeOf(call(normalUser, { slug: 'pixel-forge' }))).toBe('UNAUTHORIZED');
    expect(mock()).not.toHaveBeenCalled();
  });

  it('🔴 writes for the CALLER only — an input naming another user is ignored', async () => {
    await call(modUser, { slug: 'pixel-forge', userId: 73 });
    expect(mock()).toHaveBeenCalledTimes(1);
    expect(mock().mock.calls[0][0]).toEqual({ userId: 41, slug: 'pixel-forge' });
  });

  it.each([
    ['empty', { slug: '' }],
    ['too long', { slug: 'x'.repeat(65) }],
    ['missing', {}],
  ])('rejects a slug that is %s (BAD_REQUEST), and never writes', async (_l, input) => {
    expect(await codeOf(call(modUser, input))).toBe('BAD_REQUEST');
    expect(mock()).not.toHaveBeenCalled();
  });

  it('is idempotent at the boundary: two identical calls both succeed', async () => {
    const first = await call(modUser, { slug: 'pixel-forge' });
    const second = await call(modUser, { slug: 'pixel-forge' });
    expect(second).toEqual(first);
    expect(mock()).toHaveBeenCalledTimes(2);
  });
});

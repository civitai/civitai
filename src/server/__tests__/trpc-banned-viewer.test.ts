import { EventEmitter } from 'events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { OnboardingSteps } from '~/server/common/enums';

/**
 * A banned cookie session is no viewer to a public tRPC procedure: it gets the signed-out answer.
 * The ban still reaches the auth middleware, which refuses it with the banned message and lets it
 * reach the site appeal form. Driven through the real `createContext` and the real SSR prefetch
 * context, with the session resolver stubbed.
 */

const state = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => state.session),
}));
// The appeal form's flag stands in for a rollout segmented by user: on only for a signed-in one.
// `trpcFlagGuardPerRequest` picks where the flag guard reads it: the context's own flags (on), or a
// fresh evaluation against the context's current `user` (off).
const guard = vi.hoisted(() => ({ perRequest: true }));
const flagsFor = (user: unknown) =>
  ({
    trpcFlagGuardPerRequest: guard.perRequest,
    ...(user ? { siteAppealForm: true } : {}),
  } as never);
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsLazy: vi.fn(({ user }: { user?: unknown }) => flagsFor(user)),
  getFeatureFlags: vi.fn(({ user }: { user?: unknown }) => flagsFor(user)),
}));
vi.mock('~/server/routers', async () => {
  const { publicProcedure, protectedProcedure, restrictedAccountAppealProcedure, router } =
    await import('~/server/trpc');
  return {
    appRouter: router({
      viewer: publicProcedure.query(({ ctx }) => ctx.user?.id ?? 'anonymous'),
      account: protectedProcedure.query(({ ctx }) => ctx.user.id),
      appealState: restrictedAccountAppealProcedure.query(({ ctx }) => ctx.user.id),
    }),
  };
});

const { createContext } = await import('~/server/createContext');
const { createCallerFactory } = await import('~/server/trpc');
const { appRouter } = await import('~/server/routers');
const { getServerProxySSGHelpers } = await import('~/server/utils/server-side-helpers');

const call = createCallerFactory(appRouter as never) as unknown as (ctx: unknown) => {
  viewer: () => Promise<number | 'anonymous'>;
  account: () => Promise<number>;
  appealState: () => Promise<number>;
};

const ACTIVE = {
  id: 41,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  deletedAt: null,
  muted: false,
};
const BANNED = { ...ACTIVE, id: 42, bannedAt: new Date('2026-10-01') };

function request() {
  const req = {
    headers: { host: 'civitai.com', cookie: 'civ-token=x' },
    url: '/api/trpc/viewer',
    query: {},
    cookies: {},
  } as unknown as NextApiRequest;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  }) as unknown as NextApiResponse;
  return { req, res };
}

async function apiCaller(user: Record<string, unknown>) {
  state.session = { user };
  const ctx = await createContext(request());
  return { ctx, caller: call(ctx) };
}

beforeEach(() => {
  state.session = null;
  guard.perRequest = true;
});

describe('tRPC over a cookie session', () => {
  it('answers a public procedure for a banned session as for a signed-out visitor', async () => {
    const { caller } = await apiCaller(BANNED);
    await expect(caller.viewer()).resolves.toBe('anonymous');
  });

  it('still personalizes a public procedure for an active user', async () => {
    const { caller } = await apiCaller(ACTIVE);
    await expect(caller.viewer()).resolves.toBe(ACTIVE.id);
  });

  it('refuses a banned session on a protected procedure with the banned message', async () => {
    const { caller } = await apiCaller(BANNED);
    await expect(caller.account()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'You cannot perform this action because your account has been banned',
    });
  });

  // The appeal form's procedures are flag-gated, so the context's flags come from the full session:
  // a banned account evaluated as signed-out would lose the form it is meant to use.
  it.each([
    ['from the context', true],
    ['evaluated per call', false],
  ])(
    'lets a banned session past the site appeal form flag gate, flags read %s',
    async (_, perRequest) => {
      guard.perRequest = perRequest;
      const { caller } = await apiCaller(BANNED);
      await expect(caller.appealState()).resolves.toBe(BANNED.id);
    }
  );

  // A banned session still reads its own appeal state, so its responses must stay out of the
  // shared cache, as any signed-in session's do.
  it('keeps a banned session out of the edge cache', async () => {
    const { ctx } = await apiCaller(BANNED);
    expect(ctx.cache?.edgeTTL).toBe(0);
  });
});

describe('SSR prefetch over a cookie session', () => {
  const ssgFor = (user: Record<string, unknown>) =>
    getServerProxySSGHelpers(
      request() as never,
      { user } as never,
      flagsFor(user)
    ) as unknown as Promise<{
      viewer: { fetch: () => Promise<unknown> };
      appealState: { fetch: () => Promise<unknown> };
    }>;

  it('prefetches the anonymous answer for a banned session, and the appeal state still loads', async () => {
    const ssg = await ssgFor(BANNED);
    await expect(ssg.viewer.fetch()).resolves.toBe('anonymous');
    await expect(ssg.appealState.fetch()).resolves.toBe(BANNED.id);
  });

  it('still prefetches the personalized answer for an active user', async () => {
    const ssg = await ssgFor(ACTIVE);
    await expect(ssg.viewer.fetch()).resolves.toBe(ACTIVE.id);
  });
});

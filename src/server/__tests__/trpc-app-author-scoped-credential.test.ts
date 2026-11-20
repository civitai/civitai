import { EventEmitter } from 'events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * A moderator on a scoped API key or an app token has no moderator rights on tRPC (#9627), and
 * keeps the App Blocks AUTHOR capability, as on the REST author routes: a moderator is always an
 * author. Driven through the real `createContext`, the real flag evaluation, the real
 * `appDeveloperProcedure` and the real `enforceAppBlocksAuthorFlag`. Only Flipt is stubbed; the
 * session is the one `getServerAuthSession` finds already resolved on `req.context`.
 */

// `app-blocks-author` as Flipt has it: on for the moderators segment, which keys on the evaluated
// user's `isModerator`. The users below are in none of its other segments.
// `trpc-flag-guard-per-request` picks where the flag guard reads the flag: the context's own flags
// (on), or a fresh evaluation against the context's `user` (off). Every other key is unknown.
const guard = vi.hoisted(() => ({ perRequest: true }));
const evaluate = (key: string, context?: Record<string, string>) => {
  if (key === 'app-blocks-author') return context?.isModerator === 'true';
  if (key === 'trpc-flag-guard-per-request') return guard.perRequest;
  return null;
};
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(
    async (key: string, _entity?: string, context?: Record<string, string>) =>
      evaluate(key, context) === true
  ),
  isFliptSync: vi.fn((key: string, _entity?: string, context?: Record<string, string>) =>
    evaluate(key, context)
  ),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));

const { createContext } = await import('~/server/createContext');
const { appDeveloperProcedure, createCallerFactory, protectedProcedure, router } = await import(
  '~/server/trpc'
);
const { getFeatureFlagsAsync } = await import('~/server/services/feature-flags.service');

const appRouter = router({
  // Annotated like the CLI's author procedures (`appListings.getMyListingForApp`).
  author: appDeveloperProcedure
    .meta({ requiredScope: TokenScope.AppBlocksSubmit })
    .query(({ ctx }) => ({ isModerator: ctx.user.isModerator })),
});
const call = createCallerFactory(appRouter as never) as unknown as (ctx: unknown) => {
  author: () => Promise<{ isModerator?: boolean }>;
};

const USER = {
  id: 51,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date('2026-01-01'),
  bannedAt: null,
  deletedAt: null,
  muted: false,
};
const MOD = { ...USER, id: 52, isModerator: true };

const CLI_SCOPE = TokenScope.UserRead | TokenScope.AppBlocksSubmit;
const scopedKey = {
  tokenScope: CLI_SCOPE,
  apiKeyId: 7,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 7 },
};
const appToken = { ...scopedKey, subject: { type: 'oauth', id: 'civitai-cli' } };
const fullKey = { ...scopedKey, tokenScope: TokenScope.Full };
const fullAppToken = { ...appToken, tokenScope: TokenScope.Full };

// The session as `getServerAuthSession` records it on `req.context`: for a bearer credential, beside
// the credential fields; for a cookie session, alone.
function request(session: { user: Record<string, unknown> }, credential?: Record<string, unknown>) {
  const req = {
    headers: { host: 'civitai.com' },
    url: '/api/trpc/author',
    query: {},
    cookies: {},
    context: { session, ...credential },
  } as unknown as NextApiRequest;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  }) as unknown as NextApiResponse;
  return { req, res };
}

async function callerAs(user: Record<string, unknown>, credential?: Record<string, unknown>) {
  const ctx = await createContext(request({ user }, credential));
  return { ctx, caller: call(ctx) };
}

const AUTHOR_REFUSAL = { code: 'FORBIDDEN', message: 'You do not have access to Apps authoring' };

beforeAll(async () => {
  // Loads the (stubbed) Flipt module the flag evaluator reads synchronously.
  await getFeatureFlagsAsync({});
});

beforeEach(() => {
  guard.perRequest = true;
});

describe.each([
  ['from the context', true],
  ['evaluated per call', false],
])('appDeveloperProcedure, flags read %s', (_, perRequest) => {
  beforeEach(() => {
    guard.perRequest = perRequest;
  });

  it.each([
    ['a scoped personal key', scopedKey],
    ['an app token', appToken],
  ])('lets a moderator on %s author, without moderator rights', async (_, credential) => {
    const { ctx, caller } = await callerAs(MOD, credential);
    expect(ctx.user?.isModerator).toBe(false);
    await expect(caller.author()).resolves.toEqual({ isModerator: false });
  });

  it.each([
    ['a scoped personal key', scopedKey],
    ['an app token', appToken],
  ])('refuses a non-moderator outside the author cohort on %s', async (_, credential) => {
    const { caller } = await callerAs(USER, credential);
    await expect(caller.author()).rejects.toMatchObject(AUTHOR_REFUSAL);
  });

  it.each([
    ['a session', undefined],
    ['a full-scope personal key', fullKey],
  ])('keeps a moderator on %s an author with moderator rights', async (_, credential) => {
    const { ctx, caller } = await callerAs(MOD, credential);
    expect(ctx.user?.isModerator).toBe(true);
    await expect(caller.author()).resolves.toEqual({ isModerator: true });
  });

  it('refuses a non-moderator outside the author cohort on a session', async () => {
    const { caller } = await callerAs(USER);
    await expect(caller.author()).rejects.toMatchObject(AUTHOR_REFUSAL);
  });
});

// The routers' author gate evaluates `isAppBlocksAuthorEnabled`. The procedures it guards carry no
// scope annotation, so only a full-scope credential reaches them: a full-scope app token still
// withholds moderator rights.
describe('enforceAppBlocksAuthorFlag', () => {
  async function authorFlagAs(user: Record<string, unknown>, credential?: Record<string, unknown>) {
    const { enforceAppBlocksAuthorFlag } = await import(
      '~/server/trpc/app-blocks-author.middleware'
    );
    const gated = router({
      authorFlag: protectedProcedure.use(enforceAppBlocksAuthorFlag).query(() => 'ok'),
    });
    const ctx = await createContext(request({ user }, credential));
    const caller = createCallerFactory(gated as never)(ctx as never) as unknown as {
      authorFlag: () => Promise<string>;
    };
    return { ctx, caller };
  }

  it('lets a moderator on a full-scope app token through, without moderator rights', async () => {
    const { ctx, caller } = await authorFlagAs(MOD, fullAppToken);
    expect(ctx.user?.isModerator).toBe(false);
    await expect(caller.authorFlag()).resolves.toBe('ok');
  });

  it('refuses a non-moderator outside the author cohort on the same token', async () => {
    const { caller } = await authorFlagAs(USER, fullAppToken);
    await expect(caller.authorFlag()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Apps authoring is not enabled',
    });
  });

  it('lets a moderator on a session through', async () => {
    const { caller } = await authorFlagAs(MOD);
    await expect(caller.authorFlag()).resolves.toBe('ok');
  });
});

// The subject is read for the author capability only: a banned session is no one, and a subject
// for another user is ignored.
describe('appBlocksAuthorAccount', () => {
  it('reads as no one for a banned session', async () => {
    const { appBlocksAuthorAccount } = await import('~/server/auth/full-user-credential');
    const { ctx } = await callerAs({ ...MOD, bannedAt: new Date('2026-10-01') }, scopedKey);
    expect(ctx.user).toBeUndefined();
    expect(appBlocksAuthorAccount(ctx)).toBeUndefined();
  });

  it('ignores a subject for another user', async () => {
    const { appBlocksAuthorAccount } = await import('~/server/auth/full-user-credential');
    const user = { id: 1, isModerator: false };
    expect(
      appBlocksAuthorAccount({ user, appBlocksAuthorSubject: { id: 2, isModerator: true } })
    ).toBe(user);
  });
});

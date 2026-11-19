import { EventEmitter } from 'events';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * A moderator on a scoped API key or an app token has no moderator rights on tRPC (#9627), and
 * keeps the App Blocks AUTHOR capability, as on the REST author routes: a moderator is always an
 * author. Driven through the real `createContext`, the real `appDeveloperProcedure`, and the real
 * `enforceAppBlocksAuthorFlag` of the collaborators router, with the session resolver and Flipt
 * stubbed.
 */

const state = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => state.session),
}));

// `app-blocks-author` as Flipt has it: on for the moderators segment, which keys on the
// evaluated user's `isModerator`. The users below are in none of its other segments.
const authorSegment = (user: unknown) =>
  !!(user as { isModerator?: boolean } | undefined)?.isModerator;
// `trpcFlagGuardPerRequest` picks where the flag guard reads the flag: the context's own flags
// (on), or a fresh evaluation against the context's `user` (off).
const guard = vi.hoisted(() => ({ perRequest: true }));
const flagsFor = (user: unknown) =>
  ({
    trpcFlagGuardPerRequest: guard.perRequest,
    ...(authorSegment(user) ? { appBlocksAuthor: true } : {}),
  } as never);
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsLazy: vi.fn(({ user }: { user?: unknown }) => flagsFor(user)),
  getFeatureFlags: vi.fn(({ user }: { user?: unknown }) => flagsFor(user)),
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn(
    async (key: string, _entity?: string, context?: Record<string, string>) =>
      key === 'app-blocks-author' && context?.isModerator === 'true'
  ),
  isFliptSync: vi.fn(() => null),
}));
vi.mock('~/server/services/blocks/app-collaborator.service', () => ({
  listMyPendingInvites: vi.fn(async () => []),
  mapCollaboratorError: (err: unknown) => err,
}));

const { createContext } = await import('~/server/createContext');
const { appDeveloperProcedure, createCallerFactory, router } = await import('~/server/trpc');
const { appCollaboratorsRouter } = await import('~/server/routers/app-collaborators.router');

const appRouter = router({
  // Annotated like the CLI's author procedures (`appListings.getMyListingForApp`).
  author: appDeveloperProcedure
    .meta({ requiredScope: TokenScope.AppBlocksSubmit })
    .query(({ ctx }) => ({ isModerator: ctx.user.isModerator })),
  appCollaborators: appCollaboratorsRouter,
});
const call = createCallerFactory(appRouter as never) as unknown as (ctx: unknown) => {
  author: () => Promise<{ isModerator?: boolean }>;
  appCollaborators: { listMyPendingInvites: () => Promise<unknown> };
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

function request(context?: Record<string, unknown>) {
  const req = {
    headers: { host: 'civitai.com' },
    url: '/api/trpc/author',
    query: {},
    cookies: {},
    ...(context ? { context } : {}),
  } as unknown as NextApiRequest;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  }) as unknown as NextApiResponse;
  return { req, res };
}

async function callerAs(user: Record<string, unknown>, credential?: Record<string, unknown>) {
  state.session = { user };
  const ctx = await createContext(request(credential));
  return { ctx, caller: call(ctx) };
}

const AUTHOR_REFUSAL = { code: 'FORBIDDEN', message: 'You do not have access to Apps authoring' };

beforeEach(() => {
  state.session = null;
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

// The invitee-facing collaborator procedures gate on `isAppBlocksAuthorEnabled` directly. They
// carry no scope annotation, so only a full-scope credential reaches them: a full-scope app token
// still withholds moderator rights.
describe('enforceAppBlocksAuthorFlag', () => {
  it('lets a moderator on a full-scope app token through, without moderator rights', async () => {
    const { ctx, caller } = await callerAs(MOD, fullAppToken);
    expect(ctx.user?.isModerator).toBe(false);
    await expect(caller.appCollaborators.listMyPendingInvites()).resolves.toEqual([]);
  });

  it('refuses a non-moderator outside the author cohort on the same token', async () => {
    const { caller } = await callerAs(USER, fullAppToken);
    await expect(caller.appCollaborators.listMyPendingInvites()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Apps authoring is not enabled',
    });
  });

  it('lets a moderator on a session through', async () => {
    const { caller } = await callerAs(MOD);
    await expect(caller.appCollaborators.listMyPendingInvites()).resolves.toEqual([]);
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

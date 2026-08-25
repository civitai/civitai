import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCError } from '@trpc/server';

/**
 * `appListings.messageAppOwner` — the moderator → app-developer message proc.
 *
 * Drives the REAL `appListingsRouter` via `createCaller`, so the middleware wiring is
 * what decides rather than a re-statement of it.
 *
 * 🔴 EVERY REFUSAL ASSERTS THE SERVICE WAS NOT CALLED, not merely that the call threw.
 * "It rejected" is satisfied by a proc that sends the message and then throws on the
 * way out; only the un-called mock says the refusal happened BEFORE any write or send.
 *
 * 🔴 WHICH CASES ACTUALLY TEST THE MOD GATE — stated rather than assumed, because
 * getting this wrong is how an authz matrix reads as coverage while providing none.
 * `moderatorProcedure` is `protectedProcedure.use(isMod)`, so an ANONYMOUS caller is
 * refused by `isAuthed` with UNAUTHORIZED before `isMod` is ever reached — and that is
 * equally true if the gate is downgraded to `protectedProcedure`. The anonymous case is
 * therefore STRUCTURALLY incapable of discriminating mod-gated from
 * merely-authenticated: it is an AUTH guard, labelled as one. The TESTER case is the
 * mod guard, and it is the one that dies to the downgrade mutant.
 */

const { mockMessageAppOwner, mockIsAppBlocksEnabled, mockIsAppBlocksAuthorEnabled } = vi.hoisted(
  () => ({
    mockMessageAppOwner: vi.fn(async () => ({
      appListingId: 'apl_1',
      eventId: 'alme_1',
      recipientCount: 1,
    })),
    mockIsAppBlocksEnabled: vi.fn(),
    mockIsAppBlocksAuthorEnabled: vi.fn(),
  })
);

vi.mock('~/server/services/blocks/app-moderator-message.service', () => ({
  messageAppOwner: mockMessageAppOwner,
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({ isHostForColor: () => false }));

import { appListingsRouter } from '../app-listings.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  MOD_MESSAGE_BODY_MAX,
  MOD_MESSAGE_BODY_MIN,
  MOD_MESSAGE_SUBJECT_MAX,
} from '~/server/schema/blocks/app-moderator-message.schema';

function modMessageErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'AppModeratorMessageError', code });
}

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

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const tester = { id: 2, isModerator: false, tier: 'free', username: 'tester', onboarding: 0x1f };
// An app DEVELOPER is still just a logged-in user here — the load-bearing negative: the
// person this feature messages must not be able to use it.
const developer = { id: 3, isModerator: false, tier: 'free', username: 'dev', onboarding: 0x1f };

const INPUT = {
  appListingId: 'apl_1',
  subject: 'Your listing describes a spend confirmation that does not exist',
  body: 'It says it asks before it spends. It has never shown a confirmation to a user.',
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockMessageAppOwner.mockResolvedValue({
    appListingId: 'apl_1',
    eventId: 'alme_1',
    recipientCount: 1,
  });
  mockIsAppBlocksEnabled.mockImplementation((opts?: { user?: { isModerator?: boolean } }) =>
    Promise.resolve(!!opts?.user?.isModerator)
  );
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
});

describe('authorization — one case per role, and the service never runs on a refusal', () => {
  it('🔴 MOD GATE: a non-moderator is FORBIDDEN and the service is NOT called', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(tester) as never);
    // FORBIDDEN specifically, not `instanceof TRPCError` — a caller invoking a proc
    // that does not exist ALSO rejects with a TRPCError (NOT_FOUND, "No procedure found
    // on path"), so the loose assertion would be green on a branch where
    // `messageAppOwner` was never added, i.e. it would prove the gate without the gate.
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockMessageAppOwner).not.toHaveBeenCalled();
  });

  it('🔴 MOD GATE: an app DEVELOPER cannot message anyone, including themselves', async () => {
    // The population this feature acts ON. A developer with access to it could send a
    // "Civitai moderation" notification to any app owner — the platform's own framing,
    // wielded by an untrusted party.
    const caller = appListingsRouter.createCaller(fakeCtx(developer) as never);
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockMessageAppOwner).not.toHaveBeenCalled();
  });

  it('AUTH GUARD (not the mod gate): anonymous is UNAUTHORIZED; service NOT called', async () => {
    // Labelled: this case survives a downgrade of the proc to `protectedProcedure`, so
    // it is not evidence of moderator-only. Kept because "anon cannot reach this" is
    // still worth pinning.
    const caller = appListingsRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockMessageAppOwner).not.toHaveBeenCalled();
  });

  it('a moderator passes, and the actor is bound to ctx.user.id (never client-supplied)', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.messageAppOwner(INPUT)).resolves.toMatchObject({ recipientCount: 1 });
    expect(mockMessageAppOwner).toHaveBeenCalledTimes(1);
    // Field-by-field rather than `input: INPUT`: a middleware in the shared chain
    // decorates the parsed input (it adds `browsingLevel`), so comparing against the
    // literal makes this assertion a claim about the middleware chain rather than
    // about what the proc forwards.
    expect(mockMessageAppOwner.mock.calls[0][0]).toMatchObject({
      moderatorUserId: mod.id,
      input: { appListingId: INPUT.appListingId, subject: INPUT.subject, body: INPUT.body },
    });
  });

  it('🔴 a client-supplied moderatorUserId cannot override the ctx-bound one', async () => {
    // Mass-assignment / impersonation guard: the schema has no such field, so it is
    // stripped, and the service is handed the session's id regardless.
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.messageAppOwner({ ...INPUT, moderatorUserId: 999 } as never);
    expect(mockMessageAppOwner.mock.calls[0][0]).toMatchObject({ moderatorUserId: mod.id });
    expect(
      (mockMessageAppOwner.mock.calls[0][0] as { input: Record<string, unknown> }).input
    ).not.toHaveProperty('moderatorUserId');
  });

  it('there is EXACTLY ONE message endpoint — no protectedProcedure self-serve variant', async () => {
    const procs = Object.keys(
      (appListingsRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
        .procedures
    );
    expect(procs).toContain('messageAppOwner');
    // Assert by absence: the mod gate is the whole trust boundary here, exactly as it
    // is for `claimListing`. A sibling that let a user message an owner would be a
    // user-to-user DM with the platform's moderation framing on it.
    expect(procs.filter((p) => /message/i.test(p))).toEqual(['messageAppOwner']);
  });
});

describe('error mapping', () => {
  it('🔴 RATE_LIMITED maps to TOO_MANY_REQUESTS, not the BAD_REQUEST default', async () => {
    // BAD_REQUEST reads as "your input was wrong" and carries no retry semantics, so a
    // moderator who hit the hourly ceiling would be told to fix a message that is fine.
    mockMessageAppOwner.mockRejectedValueOnce(
      modMessageErr('RATE_LIMITED', 'Too many moderator messages — try again in 900s.')
    );
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.stringContaining('900'),
    });
  });

  it('NOT_FOUND maps to NOT_FOUND', async () => {
    mockMessageAppOwner.mockRejectedValueOnce(modMessageErr('NOT_FOUND', 'Listing not found.'));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('BLOCKED_LINK and INVALID_TEXT map to BAD_REQUEST', async () => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    mockMessageAppOwner.mockRejectedValueOnce(
      modMessageErr('BLOCKED_LINK', 'The message contains a blocked link domain.')
    );
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    mockMessageAppOwner.mockRejectedValueOnce(modMessageErr('INVALID_TEXT', 'body too short'));
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('an unexpected infra error maps to INTERNAL without leaking the raw message', async () => {
    const raw = 'connect ECONNREFUSED 10.0.0.5:5432 postgres://secret-dsn';
    mockMessageAppOwner.mockRejectedValueOnce(new Error(raw));
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    const err = await caller.messageAppOwner(INPUT).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e) => e as TRPCError
    );
    expect(err.code).toBe('INTERNAL_SERVER_ERROR');
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('secret-dsn');
  });

  it('🔴 mapping the NEW error name did not break the two existing ones', async () => {
    // `mapOffsiteError` is shared. Widening its `name` test is exactly the edit that
    // silently narrows it — an `===` swapped for the new name alone would send every
    // delist/claim failure to INTERNAL_SERVER_ERROR.
    mockMessageAppOwner.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { name: 'OffsiteModerationError', code: 'NOT_FOUND' })
    );
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    mockMessageAppOwner.mockRejectedValueOnce(
      Object.assign(new Error('nope'), { name: 'OffsiteRequestError', code: 'NOT_OWNED' })
    );
    await expect(caller.messageAppOwner(INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('schema bounds — rejected at the boundary, service NEVER called', () => {
  it.each([
    ['a missing subject', { subject: undefined }],
    ['a missing body', { body: undefined }],
    ['an empty subject', { subject: '' }],
    ['a 2-character subject', { subject: 'hi' }],
    ['a body under the floor', { body: 'x'.repeat(MOD_MESSAGE_BODY_MIN - 1) }],
    ['an over-long subject', { subject: 'x'.repeat(MOD_MESSAGE_SUBJECT_MAX + 1) }],
    ['an over-long body', { body: 'x'.repeat(MOD_MESSAGE_BODY_MAX + 1) }],
    ['a missing appListingId', { appListingId: undefined }],
    ['an empty appListingId', { appListingId: '' }],
    ['a non-boolean includeCollaborators', { includeCollaborators: 'yes' }],
  ])('rejects %s with BAD_REQUEST', async (_label, patch) => {
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    // BAD_REQUEST specifically — a missing proc rejects with NOT_FOUND, so a bare
    // `instanceof TRPCError` here would be green with no schema at all.
    await expect(caller.messageAppOwner({ ...INPUT, ...patch } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockMessageAppOwner).not.toHaveBeenCalled();
  });

  it('accepts the boundary values on both ends', async () => {
    // The other half of the bounds pin: a schema that rejected everything would pass
    // every case above.
    const caller = appListingsRouter.createCaller(fakeCtx(mod) as never);
    await caller.messageAppOwner({
      ...INPUT,
      subject: 'x'.repeat(MOD_MESSAGE_SUBJECT_MAX),
      body: 'x'.repeat(MOD_MESSAGE_BODY_MAX),
      includeCollaborators: true,
    });
    await caller.messageAppOwner({ ...INPUT, body: 'x'.repeat(MOD_MESSAGE_BODY_MIN) });
    expect(mockMessageAppOwner).toHaveBeenCalledTimes(2);
    expect(
      (mockMessageAppOwner.mock.calls[0][0] as { input: { includeCollaborators?: boolean } }).input
        .includeCollaborators
    ).toBe(true);
  });
});

describe('the mod-only limiter is not the inert middleware', () => {
  it('🔴 the proc does NOT rely on the tRPC rateLimit middleware', () => {
    // `rateLimit` short-circuits for moderators, so wiring it here would cap nothing
    // while reading as a limit. This asserts the SOURCE, because the behaviour is
    // unobservable: an inert middleware and no middleware are indistinguishable from
    // outside, which is precisely what makes the mistake survivable in review.
    const src = readFileSync(
      path.join(process.cwd(), 'src/server/routers/app-listings.router.ts'),
      'utf8'
    );
    const proc = src.slice(src.indexOf('messageAppOwner: moderatorProcedure'));
    const body = proc.slice(0, proc.indexOf('\n  }),'));
    expect(body).toContain('moderatorProcedure');
    expect(body).not.toContain('.use(rateLimit(');
    // …and the real ceilings exist and are reached from the service.
    const svc = readFileSync(
      path.join(process.cwd(), 'src/server/services/blocks/app-moderator-message.service.ts'),
      'utf8'
    );
    expect(svc).toContain('checkModMessageModeratorQuota');
    expect(svc).toContain('checkModMessageListingQuota');
  });
});

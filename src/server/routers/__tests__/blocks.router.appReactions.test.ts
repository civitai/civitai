import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageServiceMod from '~/server/services/image.service';
import type * as ReactionControllerMod from '~/server/controllers/reaction.controller';
import type * as UserAppSurfaceMod from '~/server/services/blocks/user-app-surface.service';

/**
 * `blocks.setReactionFromApp` / `blocks.getReactionsForApp` — the router-level guard matrix
 * for app reactions (civitai-app-starters#669, image-only v1).
 *
 * 🔴 EVERY REFUSAL ASSERTS ITS OWN MESSAGE AND THAT THE WRITE NEVER RAN. Several gates here
 * throw FORBIDDEN; a case that checked only the code would pass when an unrelated earlier gate
 * fired instead. The provenance cases in particular pin the TICKET guard's own message on a
 * token that passes every other gate, so a regression that drops the ticket check goes red
 * here for that reason and not because of a scope refusal.
 */

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  isAppBlocksEnabled: vi.fn(),
  isAppReactionsEnabled: vi.fn(),
  getSessionUser: vi.fn(),
  catalogRate: vi.fn(),
  recordScopeInvocation: vi.fn(),
  toggle: vi.fn(),
  getImageMetricsObject: vi.fn(),
  getUserReactionsForImages: vi.fn(),
  rateLimitRuns: [] as Array<{ path: string; limits: unknown; options: unknown }>,
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => h.isAppBlocksEnabled(...a),
  isAppBlocksAuthorEnabled: vi.fn(),
  isAppBlocksPostCreationEnabled: vi.fn(),
  isAppBlocksAppReactionsEnabled: (...a: unknown[]) => h.isAppReactionsEnabled(...a),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => h.getSessionUser(...a) },
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => h.catalogRate(...a),
  checkBlockPostRateLimit: vi.fn(),
  checkBlockPostAppRateLimit: vi.fn(),
  checkBlockPublishRateLimit: vi.fn(),
}));
vi.mock('~/server/services/blocks/user-app-surface.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAppSurfaceMod>()),
  recordScopeInvocation: (...a: unknown[]) => h.recordScopeInvocation(...a),
}));
vi.mock('~/server/controllers/reaction.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactionControllerMod>()),
  toggleReactionHandler: (...a: unknown[]) => h.toggle(...a),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageServiceMod>()),
  getImageMetricsObject: (...a: unknown[]) => h.getImageMetricsObject(...a),
  getUserReactionsForImages: (...a: unknown[]) => h.getUserReactionsForImages(...a),
}));
// The real `rateLimit` cannot load in a router suite (its import chain evaluates a top-level
// `Prisma.validator`). This stand-in RECORDS what each procedure handed the limiter and the
// path it ran under, then passes through. What those arguments do to the redis key is proven
// against the REAL middleware in `block-reaction.rate-limit-key.test.ts`.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return {
    rateLimit: (limits: unknown, _condition: unknown, options: unknown) =>
      middleware(({ path, next }) => {
        h.rateLimitRuns.push({ path, limits, options });
        return next();
      }),
  };
});

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { blocksRouter } from '../blocks.router';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { reactionRateLimits } from '~/server/schema/reaction.schema';
import { signReactTicket } from '~/server/services/blocks/react-ticket.service';
import {
  APP_REACTION_SERVER_ERRORS,
  SITE_REACTION_RATE_LIMIT_KEY,
} from '~/shared/constants/block-reaction.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const SECRET = 'test-react-ticket-secret';
const VIEWER_ID = 42;
const OTHER_USER_ID = 7;
const IMAGE_ID = 9001;
const APP_BLOCK_ID = 'apb_alpha';

function claims(over: Record<string, unknown> = {}) {
  return {
    sub: `user:${VIEWER_ID}`,
    scopes: ['social:react:self'],
    appId: 'appblk-alpha',
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'page_apb_alpha',
    blockId: 'my-app',
    maxBrowsingLevel: 1,
    ...over,
  };
}

function ticketFor(
  over: { entityId?: number; appBlockId?: string; sub?: string; nowSeconds?: number } = {}
) {
  return signReactTicket(
    {
      entityType: 'image',
      entityId: over.entityId ?? IMAGE_ID,
      appBlockId: over.appBlockId ?? APP_BLOCK_ID,
      sub: over.sub ?? `user:${VIEWER_ID}`,
    },
    { secret: SECRET, ...(over.nowSeconds != null ? { nowSeconds: over.nowSeconds } : {}) }
  );
}

function ctx(user: { id: number } | null = { id: VIEWER_ID }, apiKeyId: number | null = null) {
  return {
    acceptableOrigin: true,
    // guardedProcedure: an onboarded, unmuted, email-verified session.
    user: user ? { ...user, isModerator: false, onboarding: 0xffff, muted: false } : undefined,
    apiKeyId,
    tokenScope: TokenScope.Full,
    ip: '203.0.113.9',
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: { reaction: vi.fn(async () => undefined) },
  };
}

const caller = (c = ctx()) => blocksRouter.createCaller(c as never);

function setInput(over: Record<string, unknown> = {}) {
  return {
    blockToken: 'tok',
    entityType: 'image' as const,
    entityId: IMAGE_ID,
    reaction: 'Heart' as const,
    reacted: true,
    ticket: ticketFor(),
    ...over,
  };
}

/** The viewer's reactions on the PRIMARY after the write (the read-back). */
function afterWrite(rows: Array<{ reaction: string }>) {
  dbMock.dbWrite.imageReaction.findMany.mockResolvedValue(rows);
}

/** The viewer currently holds (or does not hold) the reaction, on the PRIMARY. */
function viewerHolds(holds: boolean) {
  dbMock.dbWrite.imageReaction.findFirst.mockResolvedValue(holds ? { id: 1 } : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXTAUTH_SECRET', SECRET);
  h.rateLimitRuns.length = 0;
  h.authorize.mockResolvedValue(claims());
  h.isAppBlocksEnabled.mockResolvedValue(true);
  h.isAppReactionsEnabled.mockResolvedValue(true);
  h.getSessionUser.mockResolvedValue({ id: VIEWER_ID, isModerator: false });
  h.catalogRate.mockResolvedValue({ allowed: true });
  h.toggle.mockResolvedValue('created');
  h.getImageMetricsObject.mockImplementation(async (data: { id: number }[]) =>
    Object.fromEntries(
      data.map(({ id }) => [
        id,
        {
          imageId: id,
          reactionLike: 3,
          reactionHeart: 5,
          reactionLaugh: null,
          reactionCry: 1,
          comment: null,
          collection: null,
          buzz: null,
        },
      ])
    )
  );
  h.getUserReactionsForImages.mockResolvedValue({ [IMAGE_ID]: ['Heart'] });
  viewerHolds(false);
  // The post-write state of the viewer's reactions, read on the PRIMARY.
  dbMock.dbWrite.imageReaction.findMany.mockResolvedValue([{ reaction: 'Heart' }]);
});

const MISMATCH = 'this app session belongs to a different account; reload the page to continue';

describe.each([
  {
    proc: 'setReactionFromApp' as const,
    input: () => setInput(),
    downstream: () => [h.toggle, dbMock.dbWrite.imageReaction.findFirst],
  },
  {
    proc: 'getReactionsForApp' as const,
    input: () => ({
      blockToken: 'tok',
      entityType: 'image' as const,
      ids: [IMAGE_ID],
      tickets: { [String(IMAGE_ID)]: ticketFor() },
    }),
    downstream: () => [h.catalogRate, h.getImageMetricsObject, h.getUserReactionsForImages],
  },
])('$proc — the shared authorization ladder', ({ proc, input, downstream }) => {
  const call = (c = ctx()) => caller(c)[proc](input() as never);
  const nothingDownstream = () => {
    for (const m of downstream()) expect(m).not.toHaveBeenCalled();
  };

  it('REFUSES an anonymous token subject', async () => {
    h.authorize.mockResolvedValue(claims({ sub: 'anon' }));
    await expect(call()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'reacting requires a signed-in viewer',
    });
    nothingDownstream();
  });

  it('REFUSES when the session user is not the token subject', async () => {
    await expect(call(ctx({ id: OTHER_USER_ID }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: MISMATCH,
    });
    // Refused before the flag and the hydration, not by a later gate.
    expect(h.isAppBlocksEnabled).not.toHaveBeenCalled();
    expect(h.isAppReactionsEnabled).not.toHaveBeenCalled();
    nothingDownstream();
  });

  it('REFUSES with no session at all, before any token work', async () => {
    await expect(call(ctx(null))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(h.authorize).not.toHaveBeenCalled();
    nothingDownstream();
  });

  it('REFUSES an API key / OAuth token, before any token work', async () => {
    await expect(call(ctx({ id: VIEWER_ID }, 99))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.authorize).not.toHaveBeenCalled();
    nothingDownstream();
  });

  it('REFUSES a token without social:react:self — the viewer has not consented', async () => {
    // The token carries a DIFFERENT write scope. Consent to post is not consent to react.
    h.authorize.mockResolvedValue(claims({ scopes: ['posts:write:self'] }));
    await expect(call()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: APP_REACTION_SERVER_ERRORS.missingScope,
    });
    nothingDownstream();
  });

  it('REFUSES when the app-reactions flag is off (fail-closed kill switch)', async () => {
    h.isAppReactionsEnabled.mockResolvedValue(false);
    await expect(call()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: APP_REACTION_SERVER_ERRORS.disabled,
    });
    // Evaluated on the HYDRATED token subject, never on a client value.
    expect(h.isAppReactionsEnabled).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: VIEWER_ID }),
    });
    nothingDownstream();
  });
});

describe('setReactionFromApp — the image allowlist', () => {
  it('REFUSES Dislike with the allowlist message, before any ticket or write work', async () => {
    await expect(
      caller().setReactionFromApp(setInput({ reaction: 'Dislike' }) as never)
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: APP_REACTION_SERVER_ERRORS.reactionNotAllowed,
    });
    expect(h.toggle).not.toHaveBeenCalled();
  });

  it.each(['Like', 'Heart', 'Laugh', 'Cry'])('ACCEPTS %s', async (reaction) => {
    await caller().setReactionFromApp(setInput({ reaction }) as never);
    expect(h.toggle).toHaveBeenCalledTimes(1);
  });
});

describe('setReactionFromApp — provenance tickets', () => {
  // Each of these passes EVERY other gate (scope, session, flags) — only the ticket is wrong —
  // so the expected error is the TICKET guard's own, not a scope or session refusal.
  const expectTicketRefusal = async (input: Record<string, unknown>) => {
    await expect(caller().setReactionFromApp(input as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: APP_REACTION_SERVER_ERRORS.ticket,
    });
    expect(h.toggle).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.imageReaction.findFirst).not.toHaveBeenCalled();
    expect(h.recordScopeInvocation).not.toHaveBeenCalled();
  };

  it('REFUSES an id with no ticket', async () => {
    await expectTicketRefusal(setInput({ ticket: undefined }));
  });

  it('REFUSES a ticket issued for a DIFFERENT image', async () => {
    await expectTicketRefusal(setInput({ ticket: ticketFor({ entityId: IMAGE_ID + 1 }) }));
  });

  it('REFUSES a ticket issued to ANOTHER APP for this same image and viewer', async () => {
    await expectTicketRefusal(setInput({ ticket: ticketFor({ appBlockId: 'apb_other' }) }));
  });

  it('REFUSES a ticket issued to ANOTHER VIEWER for this same image and app', async () => {
    await expectTicketRefusal(setInput({ ticket: ticketFor({ sub: `user:${OTHER_USER_ID}` }) }));
  });

  it('REFUSES an EXPIRED ticket', async () => {
    // Signed two days ago with the default 24h TTL.
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    await expectTicketRefusal(setInput({ ticket: ticketFor({ nowSeconds: twoDaysAgo }) }));
  });

  it('REFUSES a well-formed ticket signed with a different secret', async () => {
    const forged = signReactTicket(
      {
        entityType: 'image',
        entityId: IMAGE_ID,
        appBlockId: APP_BLOCK_ID,
        sub: `user:${VIEWER_ID}`,
      },
      { secret: 'not-the-server-secret' }
    );
    await expectTicketRefusal(setInput({ ticket: forged }));
  });

  it('ACCEPTS the ticket issued for exactly this (image, app, viewer) — the positive control', async () => {
    await expect(caller().setReactionFromApp(setInput() as never)).resolves.toMatchObject({
      changed: true,
    });
    expect(h.toggle).toHaveBeenCalledTimes(1);
  });
});

describe('setReactionFromApp — set semantics', () => {
  it('🔴 reacted:true on an EXISTING reaction writes nothing, pays nothing and audits nothing', async () => {
    viewerHolds(true);
    const result = await caller().setReactionFromApp(setInput({ reacted: true }) as never);
    expect(result.changed).toBe(false);
    // The site handler is where rewards, metrics and notifications live: not calling it is
    // what "pays nothing" means.
    expect(h.toggle).not.toHaveBeenCalled();
    expect(h.recordScopeInvocation).not.toHaveBeenCalled();
    // The current state was read on the PRIMARY, for this viewer, image and reaction.
    expect(dbMock.dbWrite.imageReaction.findFirst).toHaveBeenCalledWith({
      where: { imageId: IMAGE_ID, userId: VIEWER_ID, reaction: 'Heart' },
      select: { id: true },
    });
  });

  it('reacted:false on an ABSENT reaction is also a no-op', async () => {
    viewerHolds(false);
    afterWrite([]);
    const result = await caller().setReactionFromApp(setInput({ reacted: false }) as never);
    expect(result.changed).toBe(false);
    expect(result.reacted).toBe(false);
    expect(h.toggle).not.toHaveBeenCalled();
    expect(h.recordScopeInvocation).not.toHaveBeenCalled();
  });

  it('reacted:true on an absent reaction calls the SITE handler once, as the session viewer', async () => {
    viewerHolds(false);
    const c = ctx();
    const result = await caller(c).setReactionFromApp(setInput({ reacted: true }) as never);
    expect(h.toggle).toHaveBeenCalledTimes(1);
    const [{ ctx: handlerCtx, input }] = h.toggle.mock.calls[0] as [
      { ctx: { user: { id: number }; ip: string }; input: unknown }
    ];
    expect(input).toEqual({ entityType: 'image', entityId: IMAGE_ID, reaction: 'Heart' });
    // Same viewer and IP the site handler would see from a click: rewards key on both.
    expect(handlerCtx.user.id).toBe(VIEWER_ID);
    expect(handlerCtx.ip).toBe('203.0.113.9');
    expect(result).toEqual({
      entityType: 'image',
      entityId: IMAGE_ID,
      reaction: 'Heart',
      reacted: true,
      changed: true,
      counts: { Like: 3, Heart: 5, Laugh: 0, Cry: 1 },
      viewerReactions: ['Heart'],
      statsUnknown: false,
    });
  });

  it('reacted:false on a held reaction removes it, reports it and audits the removal', async () => {
    viewerHolds(true);
    afterWrite([]);
    h.toggle.mockResolvedValue('removed');
    const result = await caller().setReactionFromApp(setInput({ reacted: false }) as never);
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ changed: true, reacted: false, viewerReactions: [] });
    expect(h.recordScopeInvocation).toHaveBeenCalledTimes(1);
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reacted: false, outcome: 'ok' }),
      })
    );
  });

  // 'noop': the site's own (replica) check saw a row the primary no longer has, so its delete
  // matched nothing. 'ignored': the reverse-toggle guard dropped it. Either way the primary
  // read-back is the truth: still not reacted.
  it.each(['noop', 'ignored'] as const)(
    '🔴 a toggle that did not apply (%s) is reported TRUTHFULLY, not as asked',
    async (outcome) => {
      viewerHolds(false);
      afterWrite([]);
      h.toggle.mockResolvedValue(outcome);
      const result = await caller().setReactionFromApp(setInput({ reacted: true }) as never);
      expect(h.toggle).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ changed: false, reacted: false, viewerReactions: [] });
      // Nothing changed on the viewer's account, so nothing is audited.
      expect(h.recordScopeInvocation).not.toHaveBeenCalled();
    }
  );

  it('never toggles twice — a toggle that went the other way is reported and audited as such', async () => {
    // Asked to REMOVE; the site's replica check missed the row, so the toggle CREATED instead.
    viewerHolds(true);
    afterWrite([{ reaction: 'Heart' }]);
    h.toggle.mockResolvedValue('created');
    const result = await caller().setReactionFromApp(setInput({ reacted: false }) as never);
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ changed: true, reacted: true });
    // The audit names what THIS request wrote — a create — not what it asked for.
    expect(h.recordScopeInvocation).toHaveBeenCalledTimes(1);
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ reacted: true, outcome: 'ok' }) })
    );
  });

  it('a concurrent change made by SOMEONE ELSE is not audited against this app', async () => {
    // Already held, so no toggle; the viewer un-reacted on the site before the read-back.
    viewerHolds(true);
    afterWrite([]);
    const result = await caller().setReactionFromApp(setInput({ reacted: true }) as never);
    expect(h.toggle).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: false, reacted: false });
    expect(h.recordScopeInvocation).not.toHaveBeenCalled();
  });

  it('a create this request made IS audited even if a racing removal undid it before the read-back', async () => {
    viewerHolds(false);
    afterWrite([]);
    h.toggle.mockResolvedValue('created');
    const result = await caller().setReactionFromApp(setInput({ reacted: true }) as never);
    // The reply tells the truth (not reacted); the audit records the reward-paying create.
    expect(result).toMatchObject({ changed: true, reacted: false });
    expect(h.recordScopeInvocation).toHaveBeenCalledTimes(1);
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ reacted: true, outcome: 'ok' }) })
    );
  });

  it("a unique violation (the row already existed — a racing create won) is NOT this request's change", async () => {
    // A double-tap: request A created the row; B's stale replica check missed it and B's insert
    // hit the unique key. B wrote nothing, so it reports the truth and is not audited.
    viewerHolds(false);
    afterWrite([{ reaction: 'Heart' }]);
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    h.toggle.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: 'x', cause: p2002 }));
    const result = await caller().setReactionFromApp(setInput({ reacted: true }) as never);
    // The toggle WAS attempted (so the rejection path was reached), and wrote nothing.
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ changed: false, reacted: true });
    expect(h.recordScopeInvocation).not.toHaveBeenCalled();
  });

  it('a DIFFERENT Prisma error (not a unique violation) is not swallowed', async () => {
    // Negative control for the classifier: only P2002 means "the row already existed".
    viewerHolds(true);
    afterWrite([]);
    const p2003 = new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
    h.toggle.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone', cause: p2003 }));
    await expect(
      caller().setReactionFromApp(setInput({ reacted: false }) as never)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.recordScopeInvocation).toHaveBeenCalledTimes(1);
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ outcome: 'failed', reacted: false }),
      })
    );
  });

  it('any other handler error is rethrown and audited ONCE as failed — even if the state moved', async () => {
    // The state moving cannot be credited to this request: a concurrent writer could have done it.
    viewerHolds(false);
    afterWrite([{ reaction: 'Heart' }]);
    h.toggle.mockRejectedValue(new Error('tracker read failed'));
    await expect(caller().setReactionFromApp(setInput({ reacted: true }) as never)).rejects.toThrow(
      'tracker read failed'
    );
    expect(h.recordScopeInvocation).toHaveBeenCalledTimes(1);
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        detail: expect.objectContaining({ outcome: 'failed', reacted: true }),
      })
    );
  });

  it('reads the post-write state on the PRIMARY, for this viewer and image', async () => {
    afterWrite([{ reaction: 'Heart' }, { reaction: 'Like' }]);
    // The replica still lags: it would answer with nothing.
    h.getUserReactionsForImages.mockResolvedValue({});
    const result = await caller().setReactionFromApp(setInput() as never);
    expect(result.viewerReactions).toEqual(['Heart', 'Like']);
    expect(dbMock.dbWrite.imageReaction.findMany).toHaveBeenCalledWith({
      where: { imageId: IMAGE_ID, userId: VIEWER_ID },
      select: { reaction: true },
    });
  });

  it('writes ONE audit row for a change, naming the app, the image and the reaction', async () => {
    await caller().setReactionFromApp(setInput() as never);
    expect(h.recordScopeInvocation).toHaveBeenCalledTimes(1);
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: VIEWER_ID,
        appBlockId: APP_BLOCK_ID,
        scope: 'social:react:self',
        endpoint: 'reaction:set',
        statusCode: 200,
        detail: expect.objectContaining({
          action: 'reaction.set',
          entityType: 'Image',
          entityId: IMAGE_ID,
          reaction: 'Heart',
          reacted: true,
          outcome: 'ok',
        }),
      })
    );
  });

  it('marks the audit row with the dev and private-run claims of the token', async () => {
    h.authorize.mockResolvedValue(claims({ dev: true, privateRun: true }));
    await caller().setReactionFromApp(setInput() as never);
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ dev: true, privateRun: true })
    );
    h.recordScopeInvocation.mockClear();
    h.authorize.mockResolvedValue(claims());
    await caller().setReactionFromApp(setInput() as never);
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ dev: false, privateRun: false })
    );
  });

  it('a failing audit write never fails a reaction that landed', async () => {
    h.recordScopeInvocation.mockRejectedValue(new Error('audit db down'));
    await expect(caller().setReactionFromApp(setInput() as never)).resolves.toMatchObject({
      changed: true,
    });
    expect(h.toggle).toHaveBeenCalledTimes(1);
  });

  it('audits a FAILED write and still surfaces the error', async () => {
    // Nothing landed: the read-back still shows no reaction.
    afterWrite([]);
    h.toggle.mockRejectedValue(new Error('You cannot react to this entity.'));
    await expect(caller().setReactionFromApp(setInput() as never)).rejects.toThrow(
      'You cannot react to this entity.'
    );
    expect(h.recordScopeInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        detail: expect.objectContaining({ outcome: 'failed' }),
      })
    );
  });
});

describe('setReactionFromApp — ONE quota with the site', () => {
  it("charges the SITE's reaction limits under the SITE's key, not a key of its own", async () => {
    await caller().setReactionFromApp(setInput() as never);
    const runs = h.rateLimitRuns.filter((r) => r.path === 'setReactionFromApp');
    expect(runs).toHaveLength(1);
    // Identity, not equality: the same array object the site's `reaction.toggle` is built with.
    expect(runs[0].limits).toBe(reactionRateLimits);
    expect(runs[0].options).toEqual({ sharedKey: SITE_REACTION_RATE_LIMIT_KEY });
  });
});

describe('getReactionsForApp — ticketed reads', () => {
  it('answers only ticketed ids, and lists the rest as unavailable', async () => {
    const unticketed = IMAGE_ID + 1;
    const wrongApp = IMAGE_ID + 2;
    h.getUserReactionsForImages.mockResolvedValue({ [IMAGE_ID]: ['Heart', 'Like'] });
    const result = await caller().getReactionsForApp({
      blockToken: 'tok',
      entityType: 'image',
      ids: [IMAGE_ID, unticketed, wrongApp],
      tickets: {
        [String(IMAGE_ID)]: ticketFor(),
        [String(wrongApp)]: ticketFor({ entityId: wrongApp, appBlockId: 'apb_other' }),
      },
    });
    expect(result.unavailable.sort()).toEqual([unticketed, wrongApp].sort());
    expect(Object.keys(result.byId)).toEqual([String(IMAGE_ID)]);
    expect(result.byId[IMAGE_ID]).toEqual({
      counts: { Like: 3, Heart: 5, Laugh: 0, Cry: 1 },
      viewerReactions: ['Heart', 'Like'],
      statsUnknown: false,
    });
    // The viewer's own reactions were read for the TICKETED id only.
    expect(h.getUserReactionsForImages).toHaveBeenCalledWith({
      imageIds: [IMAGE_ID],
      userId: VIEWER_ID,
    });
  });

  it.each([
    ['no ticket', () => undefined],
    ['a ticket for ANOTHER image', () => ticketFor({ entityId: IMAGE_ID + 1 })],
    ['a ticket for ANOTHER APP', () => ticketFor({ appBlockId: 'apb_other' })],
    ['a ticket for ANOTHER VIEWER', () => ticketFor({ sub: `user:${OTHER_USER_ID}` })],
    [
      'an EXPIRED ticket',
      () => ticketFor({ nowSeconds: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60 }),
    ],
  ])('does not answer an id carrying %s — and never reads its reactions', async (_l, make) => {
    const ticket = make();
    const result = await caller().getReactionsForApp({
      blockToken: 'tok',
      entityType: 'image',
      ids: [IMAGE_ID],
      ...(ticket ? { tickets: { [String(IMAGE_ID)]: ticket } } : {}),
    });
    expect(result.unavailable).toEqual([IMAGE_ID]);
    expect(result.byId).toEqual({});
    expect(h.getUserReactionsForImages).not.toHaveBeenCalled();
  });

  it('dedupes ids and charges the catalog bucket of THIS install', async () => {
    await caller().getReactionsForApp({
      blockToken: 'tok',
      entityType: 'image',
      ids: [IMAGE_ID, IMAGE_ID],
      tickets: { [String(IMAGE_ID)]: ticketFor() },
    });
    expect(h.catalogRate).toHaveBeenCalledWith('page_apb_alpha');
    expect(h.getUserReactionsForImages).toHaveBeenCalledWith({
      imageIds: [IMAGE_ID],
      userId: VIEWER_ID,
    });
  });

  it('reports statsUnknown when the metric store cannot answer, rather than zeros as truth', async () => {
    h.getImageMetricsObject.mockResolvedValue({});
    const result = await caller().getReactionsForApp({
      blockToken: 'tok',
      entityType: 'image',
      ids: [IMAGE_ID],
      tickets: { [String(IMAGE_ID)]: ticketFor() },
    });
    expect(result.byId[IMAGE_ID].statsUnknown).toBe(true);
  });

  it('is bounded by the catalog bucket', async () => {
    h.catalogRate.mockResolvedValue({ allowed: false });
    await expect(
      caller().getReactionsForApp({
        blockToken: 'tok',
        entityType: 'image',
        ids: [IMAGE_ID],
        tickets: { [String(IMAGE_ID)]: ticketFor() },
      })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(h.getImageMetricsObject).not.toHaveBeenCalled();
  });

  it('refuses more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    await expect(
      caller().getReactionsForApp({ blockToken: 'tok', entityType: 'image', ids })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

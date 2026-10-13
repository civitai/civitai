import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
// Shared db/redis/env mocks and the REAL test RSA keypair, so the tokens below are really
// signed and the middleware really verifies them.
import '~/__tests__/setup';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as BridgeAuth from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccess from '~/server/services/blocks/block-token-access.service';
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';
import type * as RuntimeMetrics from '~/server/metrics/app-block-runtime.metrics';
import type * as CatalogRateLimit from '~/server/utils/block-catalog-rate-limit';

/**
 * `authorizeBlockBridgeViewer` — the tRPC middleware — driven two ways: through a probe
 * procedure, to pin each step and each option on its own, and through `blocks.getMyViewer`, the
 * one procedure that uses it. The token is really minted and the real `authorizeBlockBridgeToken`
 * runs, so the refusal codes and messages are the ones a block receives.
 *
 * `events` records the steps in the order they ran. An order assertion makes two steps refuse
 * at once and names the one that must win.
 */

const h = vi.hoisted(() => ({
  events: [] as string[],
  isRevoked: vi.fn(),
  consentLookup: vi.fn(),
  getSessionUserById: vi.fn(),
  enabledFor: [] as number[],
  catalogLimit: vi.fn(),
  recordRefusal: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => {
  const real = await importOriginal<typeof BridgeAuth>();
  return {
    ...real,
    authorizeBlockBridgeToken: async (token: string) => {
      h.events.push(`authorize(${token === 'not-a-jwt' ? token : 'jwt'})`);
      return real.authorizeBlockBridgeToken(token);
    },
  };
});
vi.mock('~/server/services/blocks/block-token-access.service', async (importOriginal) => {
  const real = await importOriginal<typeof TokenAccess>();
  return {
    ...real,
    assertAppBlocksEnabledForTokenUser: async (userId: number) => {
      h.events.push(`kill-switch(${userId})`);
      return real.assertAppBlocksEnabledForTokenUser(userId);
    },
  };
});
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  // On for the listed user ids only; an evaluation with no user answers off.
  isAppBlocksEnabled: async (opts?: { user?: { id?: number } }) =>
    opts?.user?.id != null && h.enabledFor.includes(opts.user.id),
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: (...a: unknown[]) => h.isRevoked(...a) },
}));
vi.mock('~/server/services/blocks/consent-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsentRevocationModule>()),
  ConsentRevocation: { lookup: (...a: unknown[]) => h.consentLookup(...a) },
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => h.getSessionUserById(...a) },
}));
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof CatalogRateLimit>()),
  checkBlockCatalogRateLimit: (...a: unknown[]) => h.catalogLimit(...a),
}));
vi.mock('~/server/metrics/app-block-runtime.metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeMetrics>()),
  recordBlockBridgeRateLimitRefusal: (...a: unknown[]) => h.recordRefusal(...a),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import {
  authorizeBlockBridgeViewer,
  blocksRouter,
  type BlockBridgeViewerOptions,
} from '~/server/routers/blocks.router';
import { BlockTokenService } from '~/server/services/block-token.service';
import {
  ROUTER,
  bridgeProcAuth,
  read,
} from '~/server/services/__tests__/block-bridge-router-ast.harness';
import { publicProcedure, router } from '~/server/trpc';
import { hasBlockTokenKey } from '~/shared/constants/__tests__/block-token-input.harness';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Pairwise distinct, so an assertion says WHICH identity a step used.
const SUBJECT_ID = 42;
const SESSION_USER_ID = 7;
const INSTANCE_ID = 'bki_mw';

const USER = {
  username: 'viewer',
  isModerator: false,
  tier: 'free',
  onboarding: OnboardingSteps.Buzz | OnboardingSteps.TOS,
  emailVerified: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  bannedAt: null,
  muted: false,
};

function ctx(sessionUserId = SESSION_USER_ID) {
  return {
    acceptableOrigin: true,
    user: { ...USER, id: sessionUserId },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}

async function mint(over: { scopes?: string[]; anon?: boolean } = {}) {
  const { token } = await BlockTokenService.sign({
    userId: over.anon ? null : SUBJECT_ID,
    blockId: 'mw-block',
    appId: 'app_mw',
    appBlockId: 'apb_mw',
    blockInstanceId: INSTANCE_ID,
    scopes: over.scopes ?? ['user:read:self', 'buzz:read:self', 'ai:write:budgeted'],
    ctx: { modelId: 7, slotId: 'model.sidebar_top' },
    maxBrowsingLevel: 1,
    buzzBudget: 100,
  } as Parameters<typeof BlockTokenService.sign>[0]);
  return token;
}

const check = vi.fn();

type Limited = Extract<BlockBridgeViewerOptions['rateLimit'], { onRefused: unknown }>;

const LIMITED: Limited = {
  check: (viewer) => {
    h.events.push('rate-limit');
    return check(viewer);
  },
  onRefused: 'throw',
  recordRefusalAs: null,
};

const THROWING: BlockBridgeViewerOptions = {
  scope: 'user:read:self',
  anonMessage: 'probe requires a viewer',
  rateLimit: LIMITED,
};

function withRateLimit(over: Partial<Limited>): BlockBridgeViewerOptions {
  return { ...THROWING, rateLimit: { ...LIMITED, ...over } };
}

/** A procedure that does nothing but run the middleware and hand back what it put on `ctx`. */
function probe(options: BlockBridgeViewerOptions, sessionUserId?: number) {
  const caller = router({
    run: publicProcedure
      .input(z.object({ blockToken: z.string().min(1) }))
      .use(authorizeBlockBridgeViewer(options))
      .mutation(({ ctx: { blockViewer } }) => {
        h.events.push('handler');
        return blockViewer;
      }),
  }).createCaller(ctx(sessionUserId) as never);
  return (input: unknown) => caller.run(input as { blockToken: string });
}

beforeEach(() => {
  h.events.length = 0;
  h.enabledFor = [SUBJECT_ID];
  h.isRevoked.mockReset().mockResolvedValue(false);
  h.consentLookup.mockReset().mockResolvedValue({ kind: 'none' });
  h.getSessionUserById
    .mockReset()
    .mockImplementation(async (id: number) =>
      id === SUBJECT_ID || id === SESSION_USER_ID ? { ...USER, id } : null
    );
  h.catalogLimit.mockReset().mockResolvedValue({ allowed: true });
  h.recordRefusal.mockReset();
  check.mockReset().mockResolvedValue({ allowed: true });
  dbMock.dbRead.appBlock.findUnique.mockReset().mockResolvedValue({
    id: 'apb_row',
    status: 'approved',
  });
  dbMock.dbRead.oauthClient.findUnique.mockReset().mockResolvedValue({ userId: SUBJECT_ID });
  dbMock.dbWrite.user.findUnique.mockReset().mockResolvedValue({
    id: SUBJECT_ID,
    username: 'viewer',
    bannedAt: null,
    muted: false,
    deletedAt: null,
  });
});

describe('authorizeBlockBridgeViewer — the ladder', () => {
  it('runs authorize → kill-switch → rate limit → handler, and hands the viewer over', async () => {
    const viewer = await probe(THROWING)({ blockToken: await mint() });

    expect(h.events).toEqual([
      'authorize(jwt)',
      `kill-switch(${SUBJECT_ID})`,
      'rate-limit',
      'handler',
    ]);
    expect(viewer.userId).toBe(SUBJECT_ID);
    expect(viewer.rateLimitRefused).toBe(false);
    expect(viewer.claims).toMatchObject({
      sub: `user:${SUBJECT_ID}`,
      blockInstanceId: INSTANCE_ID,
      appBlockId: 'apb_mw',
      buzzBudget: 100,
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({ claims: viewer.claims, userId: SUBJECT_ID });
  });

  it.each([[{}], [{ blockToken: '' }], [{ blockToken: 42 }]])(
    'a missing or empty token is refused by the input schema, before the authorizer: %j',
    async (input) => {
      await expect(probe(THROWING)(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(h.events).toEqual([]);
    }
  );

  it('an unverifiable token is UNAUTHORIZED `invalid block token`', async () => {
    await expect(probe(THROWING)({ blockToken: 'not-a-jwt' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'invalid block token',
    });
    expect(h.events).toEqual(['authorize(not-a-jwt)']);
  });

  it('a revoked instance is FORBIDDEN `block instance revoked`', async () => {
    h.isRevoked.mockResolvedValue(true);
    await expect(probe(THROWING)({ blockToken: await mint() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block instance revoked',
    });
    expect(h.events).toEqual(['authorize(jwt)']);
  });

  it('a non-approved app is FORBIDDEN `app block is not approved`', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ id: 'apb_row', status: 'suspended' });
    await expect(probe(THROWING)({ blockToken: await mint() })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'app block is not approved',
    });
    expect(h.events).toEqual(['authorize(jwt)']);
  });

  it('a missing app row is NOT_FOUND `app block not found`', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(probe(THROWING)({ blockToken: await mint() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'app block not found',
    });
  });

  it.each([
    ['user:read:self', 'block lacks user:read:self scope'],
    ['buzz:read:self', 'block lacks buzz:read:self scope'],
    ['ai:write:budgeted', 'block lacks ai:write:budgeted scope'],
  ] as const)('a token without %s is FORBIDDEN `%s`', async (scope, message) => {
    const others = ['user:read:self', 'buzz:read:self', 'ai:write:budgeted'].filter(
      (s) => s !== scope
    );
    await expect(
      probe({ ...THROWING, scope })({ blockToken: await mint({ scopes: others }) })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message });
    expect(h.events).toEqual(['authorize(jwt)']);

    // Control: the same token passes a procedure that asks for a scope it does carry.
    await expect(
      probe({ ...THROWING, scope: others[0] as BlockBridgeViewerOptions['scope'] })({
        blockToken: await mint({ scopes: others }),
      })
    ).resolves.toMatchObject({ userId: SUBJECT_ID });
  });

  it("an anonymous subject is UNAUTHORIZED with the procedure's own message", async () => {
    const token = await mint({ anon: true });
    await expect(probe(THROWING)({ blockToken: token })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'probe requires a viewer',
    });
    await expect(
      probe({ ...THROWING, anonMessage: 'a different procedure, a different message' })({
        blockToken: token,
      })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'a different procedure, a different message',
    });
    expect(h.events).toEqual(['authorize(jwt)', 'authorize(jwt)']);
  });

  it('the kill-switch off for the subject is UNAUTHORIZED `Apps are not enabled`', async () => {
    h.enabledFor = [];
    await expect(probe(THROWING)({ blockToken: await mint() })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Apps are not enabled',
    });
    expect(h.events).toEqual(['authorize(jwt)', `kill-switch(${SUBJECT_ID})`]);
  });

  describe('the viewer is the token subject, never the session user', () => {
    it('a session for someone else changes nothing — the subject is admitted and returned', async () => {
      const viewer = await probe(THROWING, SESSION_USER_ID)({ blockToken: await mint() });
      expect(viewer.userId).toBe(SUBJECT_ID);
      expect(h.events).toContain(`kill-switch(${SUBJECT_ID})`);
      expect(h.getSessionUserById).toHaveBeenCalledWith(SUBJECT_ID);
      expect(h.getSessionUserById).not.toHaveBeenCalledWith(SESSION_USER_ID);
    });

    it('the session user having App Blocks does not admit a subject who does not', async () => {
      h.enabledFor = [SESSION_USER_ID];
      await expect(
        probe(THROWING, SESSION_USER_ID)({ blockToken: await mint() })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
    });
  });
});

describe('authorizeBlockBridgeViewer — step order', () => {
  it('the token is authorized before the scope is read: revoked wins over a missing scope', async () => {
    h.isRevoked.mockResolvedValue(true);
    await expect(probe(THROWING)({ blockToken: await mint({ scopes: [] }) })).rejects.toMatchObject(
      { code: 'FORBIDDEN', message: 'block instance revoked' }
    );
  });

  it('scope before subject: an anonymous token without the scope gets the scope refusal', async () => {
    await expect(
      probe(THROWING)({ blockToken: await mint({ anon: true, scopes: [] }) })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'block lacks user:read:self scope' });
  });

  it('subject before kill-switch: an anonymous token never reaches it', async () => {
    h.enabledFor = [];
    await expect(probe(THROWING)({ blockToken: await mint({ anon: true }) })).rejects.toMatchObject(
      {
        code: 'UNAUTHORIZED',
        message: 'probe requires a viewer',
      }
    );
    expect(h.events).toEqual(['authorize(jwt)']);
    expect(h.getSessionUserById).not.toHaveBeenCalled();
  });

  it('kill-switch before rate limit: a switched-off viewer is refused and charged nothing', async () => {
    h.enabledFor = [];
    check.mockResolvedValue({ allowed: false });
    await expect(probe(THROWING)({ blockToken: await mint() })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Apps are not enabled',
    });
    expect(check).not.toHaveBeenCalled();
    expect(h.events).toEqual(['authorize(jwt)', `kill-switch(${SUBJECT_ID})`]);
  });
});

describe('authorizeBlockBridgeViewer — the rate-limit option', () => {
  const REFUSED = {
    code: 'TOO_MANY_REQUESTS',
    message: 'Rate limit exceeded, please retry shortly.',
  };

  it('`throw` refuses with TOO_MANY_REQUESTS and never runs the handler', async () => {
    check.mockResolvedValue({ allowed: false });
    await expect(probe(THROWING)({ blockToken: await mint() })).rejects.toMatchObject(REFUSED);
    expect(h.events).toEqual(['authorize(jwt)', `kill-switch(${SUBJECT_ID})`, 'rate-limit']);
    expect(h.recordRefusal).not.toHaveBeenCalled();
  });

  it('`recordRefusalAs` labels the refusal counter, once, and only on a refusal', async () => {
    const options = withRateLimit({ recordRefusalAs: ['someProcedure', 'poll'] });
    await probe(options)({ blockToken: await mint() });
    expect(h.recordRefusal).not.toHaveBeenCalled();

    check.mockResolvedValue({ allowed: false });
    await expect(probe(options)({ blockToken: await mint() })).rejects.toMatchObject(REFUSED);
    expect(h.recordRefusal).toHaveBeenCalledTimes(1);
    expect(h.recordRefusal).toHaveBeenCalledWith('someProcedure', 'poll');
  });

  it('`defer` does not throw: the handler runs and is told the limiter refused', async () => {
    check.mockResolvedValue({ allowed: false });
    const options = withRateLimit({
      onRefused: 'defer',
      recordRefusalAs: ['someProcedure', 'poll'],
    });
    const viewer = await probe(options)({ blockToken: await mint() });
    expect(viewer.rateLimitRefused).toBe(true);
    expect(viewer.userId).toBe(SUBJECT_ID);
    expect(h.events).toEqual([
      'authorize(jwt)',
      `kill-switch(${SUBJECT_ID})`,
      'rate-limit',
      'handler',
    ]);
    expect(h.recordRefusal).toHaveBeenCalledWith('someProcedure', 'poll');
  });

  it('`defer` reports no refusal when the limiter allows', async () => {
    const viewer = await probe(withRateLimit({ onRefused: 'defer' }))({ blockToken: await mint() });
    expect(viewer.rateLimitRefused).toBe(false);
  });

  it('`none` charges nothing and still runs every step before it', async () => {
    const viewer = await probe({ ...THROWING, rateLimit: { none: 'bounded by its input cap' } })({
      blockToken: await mint(),
    });
    expect(viewer.rateLimitRefused).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(h.events).toEqual(['authorize(jwt)', `kill-switch(${SUBJECT_ID})`, 'handler']);
  });
});

describe('blocks.getMyViewer — the procedure on the middleware', () => {
  const getMyViewer = (input: unknown, sessionUserId?: number) =>
    blocksRouter.createCaller(ctx(sessionUserId) as never).getMyViewer(input as never);

  it("returns the token subject's viewer and charges the catalog bucket for the install", async () => {
    await expect(getMyViewer({ blockToken: await mint() })).resolves.toEqual({
      id: SUBJECT_ID,
      username: 'viewer',
      status: 'active',
      buzzBudget: 100,
    });
    expect(h.events).toEqual(['authorize(jwt)', `kill-switch(${SUBJECT_ID})`]);
    expect(h.catalogLimit.mock.calls).toEqual([[INSTANCE_ID]]);
    expect(dbMock.dbWrite.user.findUnique.mock.calls).toEqual([
      [
        {
          where: { id: SUBJECT_ID },
          select: { id: true, username: true, bannedAt: true, muted: true, deletedAt: true },
        },
      ],
    ]);
  });

  it('refuses an unverifiable token before any read', async () => {
    await expect(getMyViewer({ blockToken: 'not-a-jwt' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'invalid block token',
    });
    expect(h.catalogLimit).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });

  it('requires `user:read:self`', async () => {
    await expect(
      getMyViewer({ blockToken: await mint({ scopes: ['buzz:read:self', 'ai:write:budgeted'] }) })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'block lacks user:read:self scope' });
  });

  it('refuses an anonymous subject with its own message', async () => {
    await expect(getMyViewer({ blockToken: await mint({ anon: true }) })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'viewer read requires an authenticated viewer',
    });
  });

  it('past the ceiling: TOO_MANY_REQUESTS, no refusal counter, and no primary read', async () => {
    h.catalogLimit.mockResolvedValue({ allowed: false });
    await expect(getMyViewer({ blockToken: await mint() })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Rate limit exceeded, please retry shortly.',
    });
    expect(h.recordRefusal).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });

  it('ignores the session: a different signed-in user still reads the subject', async () => {
    await expect(getMyViewer({ blockToken: await mint() }, SESSION_USER_ID)).resolves.toMatchObject(
      { id: SUBJECT_ID }
    );
  });
});

describe('every procedure that takes a block token has an auth mechanism', () => {
  type Procedure = { _def: { inputs: unknown[] } };
  const procedures = (
    blocksRouter as unknown as { _def: { procedures: Record<string, Procedure> } }
  )._def.procedures;

  function tokenProcedures(extra: Record<string, Procedure> = {}) {
    const takesToken: string[] = [];
    const unreadable: string[] = [];
    for (const [name, proc] of Object.entries({ ...procedures, ...extra })) {
      const results = proc._def.inputs.map((input) => hasBlockTokenKey(input));
      if (results.includes(true)) takesToken.push(name);
      else if (results.includes(null)) unreadable.push(name);
    }
    return { takesToken: takesToken.sort(), unreadable };
  }

  const withMechanism = [...bridgeProcAuth(read(ROUTER)).keys()].sort();

  it('the runtime population equals the set the source scan found a mechanism for', () => {
    const { takesToken, unreadable } = tokenProcedures();
    expect(unreadable).toEqual([]);
    expect(takesToken).toContain('getMyViewer');
    expect(takesToken).toContain('submitWorkflow');
    expect(takesToken).toEqual(withMechanism);
  });

  it('CONTROL — a token-taking procedure with neither mechanism breaks that equality', () => {
    const bare = publicProcedure
      .input(z.object({ blockToken: z.string().min(1) }))
      .mutation(() => null) as unknown as Procedure;
    const { takesToken } = tokenProcedures({ addedWithNeither: bare });
    expect(takesToken).toContain('addedWithNeither');
    expect(takesToken).not.toEqual(withMechanism);
  });
});

// `pnpm run typecheck` excludes `__tests__`, so it does not read the two directives below;
// `tsc -p tsconfig.tests.json` does. The run-time halves are what this suite itself proves.
describe('authorizeBlockBridgeViewer — only composes after a blockToken input', () => {
  it('ahead of `.input()` it is a type error, and admits nothing if forced', async () => {
    const misordered = router({
      run: publicProcedure
        // @ts-expect-error — no input yet, so there is no token for the middleware to read.
        .use(authorizeBlockBridgeViewer(THROWING))
        .mutation(() => 'admitted'),
    }).createCaller(ctx() as never);

    await expect(misordered.run()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(h.events).toEqual([]);
  });

  it('on an input with no blockToken it is a type error, and admits nothing if forced', async () => {
    const tokenless = router({
      run: publicProcedure
        .input(z.object({ workflowId: z.string() }))
        // @ts-expect-error — the input declares no `blockToken`.
        .use(authorizeBlockBridgeViewer(THROWING))
        .mutation(() => 'admitted'),
    }).createCaller(ctx() as never);

    await expect(tokenless.run({ workflowId: 'wf_1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'invalid block token',
    });
  });
});

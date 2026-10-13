import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
// Shared db/redis/env mocks and the REAL test RSA keypair, so the tokens below are really
// signed and the middleware really verifies them.
import '~/__tests__/setup';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as BridgeAuth from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccess from '~/server/services/blocks/block-token-access.service';
import type * as ConsentRevocationModule from '~/server/services/blocks/consent-revocation.service';
import type * as CatalogRateLimit from '~/server/utils/block-catalog-rate-limit';

/**
 * What the block-token characterisation suite cannot see about `authorizeBlockBridgeViewer`:
 * which identity reaches the limiter and the handler, the one step order no single-refusal
 * cell distinguishes, and what the middleware does when forced past its input type.
 *
 * Every refusal code and message of `blocks.getMyViewer` is pinned there, per failure mode,
 * and is not repeated here.
 */

const h = vi.hoisted(() => ({
  events: [] as string[],
  getSessionUserById: vi.fn(),
  enabledFor: [] as number[],
  catalogLimit: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => {
  const real = await importOriginal<typeof BridgeAuth>();
  return {
    ...real,
    authorizeBlockBridgeToken: async (token: string) => {
      h.events.push('authorize');
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
  BlockRevocation: { isRevoked: async () => false },
}));
vi.mock('~/server/services/blocks/consent-revocation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ConsentRevocationModule>()),
  ConsentRevocation: { lookup: async () => ({ kind: 'none' }) },
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => h.getSessionUserById(...a) },
}));
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof CatalogRateLimit>()),
  checkBlockCatalogRateLimit: (...a: unknown[]) => h.catalogLimit(...a),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import {
  authorizeBlockBridgeViewer,
  blocksRouter,
  type BlockBridgeViewerOptions,
} from '~/server/routers/blocks.router';
import { BlockTokenService } from '~/server/services/block-token.service';
import { publicProcedure, router } from '~/server/trpc';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Pairwise distinct, so an assertion says WHICH identity a step used.
const SUBJECT_ID = 42;
const SESSION_USER_ID = 7;
const APP_OWNER_ID = 99;
const MODEL_ID = 9001;
const INSTANCE_ID = 'bki_mw';

const USER = {
  isModerator: false,
  tier: 'free',
  onboarding: OnboardingSteps.Buzz | OnboardingSteps.TOS,
  emailVerified: new Date('2020-01-01T00:00:00Z'),
  createdAt: new Date('2020-01-01T00:00:00Z'),
  bannedAt: null,
  muted: false,
};
const usernameOf = (id: number) => `user-${id}`;

function ctx() {
  return {
    acceptableOrigin: true,
    user: { ...USER, id: SESSION_USER_ID, username: usernameOf(SESSION_USER_ID) },
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
    scopes: over.scopes ?? ['user:read:self'],
    ctx: { modelId: MODEL_ID, slotId: 'model.sidebar_top' },
    maxBrowsingLevel: 1,
    buzzBudget: 100,
  } as Parameters<typeof BlockTokenService.sign>[0]);
  return token;
}

const check = vi.fn();

const OPTIONS: BlockBridgeViewerOptions = {
  scope: 'user:read:self',
  anonMessage: 'probe requires a viewer',
  rateLimit: {
    check: (viewer) => {
      h.events.push('rate-limit');
      return check(viewer);
    },
  },
};

beforeEach(() => {
  h.events.length = 0;
  h.enabledFor = [SUBJECT_ID, SESSION_USER_ID];
  h.getSessionUserById
    .mockReset()
    .mockImplementation(async (id: number) => ({ ...USER, id, username: usernameOf(id) }));
  h.catalogLimit.mockReset().mockResolvedValue({ allowed: true });
  check.mockReset().mockResolvedValue({ allowed: true });
  dbMock.dbRead.appBlock.findUnique.mockReset().mockResolvedValue({
    id: 'apb_row',
    status: 'approved',
  });
  dbMock.dbRead.oauthClient.findUnique.mockReset().mockResolvedValue({ userId: APP_OWNER_ID });
  // Answers for the id it is ASKED for, so a read keyed on the wrong identity returns that
  // identity's row instead of the subject's.
  dbMock.dbWrite.user.findUnique
    .mockReset()
    .mockImplementation(async (args: { where: { id: number } }) => ({
      id: args.where.id,
      username: usernameOf(args.where.id),
      bannedAt: null,
      muted: false,
      deletedAt: null,
    }));
});

describe('authorizeBlockBridgeViewer', () => {
  /** A procedure that only runs the middleware and hands back what it put on `ctx`. */
  const probe = router({
    run: publicProcedure
      .input(z.object({ blockToken: z.string().min(1) }))
      .use(authorizeBlockBridgeViewer(OPTIONS))
      .mutation(({ ctx: { blockViewer } }) => {
        h.events.push('handler');
        return blockViewer;
      }),
  });
  const run = (blockToken: string) => probe.createCaller(ctx() as never).run({ blockToken });

  it('hands the token subject — not the session user — to the limiter and to the handler', async () => {
    const viewer = await run(await mint());

    expect(h.events).toEqual(['authorize', `kill-switch(${SUBJECT_ID})`, 'rate-limit', 'handler']);
    expect(viewer.userId).toBe(SUBJECT_ID);
    expect(viewer.claims).toMatchObject({
      sub: `user:${SUBJECT_ID}`,
      blockInstanceId: INSTANCE_ID,
    });
    expect(check.mock.calls).toEqual([[{ claims: viewer.claims, userId: SUBJECT_ID }]]);
  });

  it('checks the scope before the subject: an anonymous token without it gets the scope refusal', async () => {
    await expect(run(await mint({ anon: true, scopes: [] }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'block lacks user:read:self scope',
    });
    // Control: with the scope, the same anonymous token reaches the subject refusal.
    await expect(run(await mint({ anon: true }))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'probe requires a viewer',
    });
  });
});

describe('blocks.getMyViewer on the middleware', () => {
  it('reads the TOKEN SUBJECT from the primary, whoever is signed in', async () => {
    const result = await blocksRouter
      .createCaller(ctx() as never)
      .getMyViewer({ blockToken: await mint() });

    // The session user (7) is enabled and has a row too, so only the identity can differ.
    expect(dbMock.dbWrite.user.findUnique.mock.calls).toEqual([
      [
        {
          where: { id: SUBJECT_ID },
          select: { id: true, username: true, bannedAt: true, muted: true, deletedAt: true },
        },
      ],
    ]);
    expect(result).toEqual({
      id: SUBJECT_ID,
      username: usernameOf(SUBJECT_ID),
      status: 'active',
      buzzBudget: 100,
    });
    expect(h.events).toEqual(['authorize', `kill-switch(${SUBJECT_ID})`]);
    expect(h.catalogLimit.mock.calls).toEqual([[INSTANCE_ID]]);
  });
});

// `pnpm run typecheck` excludes `__tests__`, so it does not read the two directives below;
// `tsc -p tsconfig.tests.json` does. The run-time halves are what this suite itself proves.
describe('authorizeBlockBridgeViewer — forced past its input type, it admits nothing', () => {
  it('ahead of `.input()`', async () => {
    const misordered = router({
      run: publicProcedure
        // @ts-expect-error — no input yet, so there is no token for the middleware to read.
        .use(authorizeBlockBridgeViewer(OPTIONS))
        .mutation(() => 'admitted'),
    }).createCaller(ctx() as never);

    await expect(misordered.run()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(h.events).toEqual([]);
  });

  it('on an input with no blockToken', async () => {
    const tokenless = router({
      run: publicProcedure
        .input(z.object({ workflowId: z.string() }))
        // @ts-expect-error — the input declares no `blockToken`.
        .use(authorizeBlockBridgeViewer(OPTIONS))
        .mutation(() => 'admitted'),
    }).createCaller(ctx() as never);

    await expect(tokenless.run({ workflowId: 'wf_1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'invalid block token',
    });
  });
});

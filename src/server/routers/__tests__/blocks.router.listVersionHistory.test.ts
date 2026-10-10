import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
// Type-only imports (erased at runtime, so they are safe above the hoisted
// `vi.mock` calls) — the lint rule forbids inline `import()` type annotations.
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * `blocks.listVersionHistory` — router AUTHZ + input surface.
 *
 * Drives the REAL `blocksRouter` through `createCaller` so the MIDDLEWARE WIRING is what
 * decides, not a hand-rolled stand-in. The gate is the point:
 *
 *   1. MODERATOR-ONLY. A non-mod, an anonymous caller, and a caller who merely CLAIMS
 *      elevation in the payload are all rejected, and the SERVICE IS NEVER REACHED.
 *      ⚠️ `moderatorProcedure` ALONE satisfies every one of those arms — measured by
 *      deleting the proc's inner `ctx.user?.isModerator` belt, which left all four green.
 *      The belt is the house idiom on this router and is genuinely redundant, so it is
 *      kept; this note exists so the arms are not read as covering it.
 *   2. THE APP-BLOCKS FLAG DOES NOT GATE IT — `enforceAppBlocksFlag` throws only for a
 *      MUTATION, so the mod gate carries this read alone. Pinned below.
 *   3. SLUG BOUNDS — the zod input is slug-shaped, so a caller cannot pass a pattern, an
 *      over-long string or extra fields through to the query.
 *
 * Heavy-mock skeleton copied from `blocks.router.retriggerBuild.test.ts` so importing the
 * router doesn't drag in the generated Prisma client.
 */

const { mockIsAppBlocksEnabled, mockListVersionHistory } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(),
  mockListVersionHistory: vi.fn<(...a: any[]) => Promise<unknown>>(async () => ({
    items: [],
    truncated: false,
  })),
}));

vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
  isAppBlocksAuthorEnabled: vi.fn(async () => true),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true, appBlocksPages: false }),
}));
// The router dynamically imports the whole publish-request service; stub just the
// export under test plus the handful the module graph needs.
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  listVersionHistory: mockListVersionHistory,
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({ getOrchestratorToken: vi.fn() }));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ auditPromptServer: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn(), getUserRewardDetails: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccounts: vi.fn() }));
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    listAvailable: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    resolveBlockInstance: vi.fn(),
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
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
    features: { appBlocks: true, appBlocksAuthor: true } as never,
    track: undefined,
  };
}

const mod = { id: 1, isModerator: true, tier: 'free', username: 'mod', onboarding: 0x1f };
const tester = { id: 2, isModerator: false, tier: 'free', username: 'tester', onboarding: 0x1f };
const SLUG = 'my-app';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockListVersionHistory.mockResolvedValue({ items: [], truncated: false });
});

describe('blocks.listVersionHistory — moderator gate', () => {
  it('a NON-MODERATOR is rejected; the service is never reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(tester) as never);
    await expect(caller.listVersionHistory({ slug: SLUG })).rejects.toBeInstanceOf(TRPCError);
    expect(mockListVersionHistory).not.toHaveBeenCalled();
  });

  it('an ANONYMOUS caller is rejected; the service is never reached', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(undefined) as never);
    await expect(caller.listVersionHistory({ slug: SLUG })).rejects.toBeInstanceOf(TRPCError);
    expect(mockListVersionHistory).not.toHaveBeenCalled();
  });

  it('a user who merely CLAIMS elevation in the payload is still rejected', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(tester) as never);
    await expect(
      caller.listVersionHistory({ slug: SLUG, isModerator: true } as never)
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockListVersionHistory).not.toHaveBeenCalled();
  });

  it('a MODERATOR passes and the service runs', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.listVersionHistory({ slug: SLUG })).resolves.toMatchObject({
      items: [],
      truncated: false,
    });
    expect(mockListVersionHistory).toHaveBeenCalledTimes(1);
  });

  it('🔴 the APP-BLOCKS FLAG does NOT gate this read — the MOD GATE is the only one', async () => {
    /**
     * 🔴 MEASURED, NOT ASSUMED, AND THE OPPOSITE OF WHAT THE PROC'S SHAPE SUGGESTS.
     * `enforceAppBlocksFlag` throws only for a MUTATION; for a `query` it falls through
     * with `_appBlocksDisabled: true` so slot-rendering callers get an empty result
     * instead of an error (`blocks.router.ts`'s middleware, the `type === 'query'` arm).
     * This proc does not read that marker, so with the flag off a moderator still gets
     * the history — which is fine, because the audience is identical, but it means
     * `moderatorProcedure` + the inner `isModerator` belt are carrying the whole gate.
     * Pinned so nobody adds a second mod-only read here believing the flag is a second
     * line of defence.
     */
    mockIsAppBlocksEnabled.mockResolvedValue(false);
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await expect(caller.listVersionHistory({ slug: SLUG })).resolves.toBeDefined();
    // …and it STILL refuses a non-moderator with the flag off, which is the half that
    // would matter if the fall-through above ever changed.
    const nonMod = blocksRouter.createCaller(fakeCtx(tester) as never);
    await expect(nonMod.listVersionHistory({ slug: SLUG })).rejects.toBeInstanceOf(TRPCError);
  });
});

describe('blocks.listVersionHistory — input surface', () => {
  it('forwards ONLY the slug — the proc projects it explicitly, asserted by exact equality', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    await caller.listVersionHistory({
      slug: SLUG,
      limit: 9999,
      appBlockId: 'apb_other',
    } as never);
    // What drops the extras is the proc's own `{ slug: input.slug }` projection, not schema
    // strictness — `listVersionHistorySchema` is a plain `z.object`, which STRIPS unknown
    // keys silently rather than rejecting them.
    expect(mockListVersionHistory).toHaveBeenCalledWith({ slug: SLUG });
  });

  it('rejects a missing, short, over-long or pattern-shaped slug at the schema', async () => {
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    for (const input of [
      {},
      { slug: '' },
      { slug: 'ab' },
      { slug: 'a'.repeat(41) },
      { slug: 'has space' },
      { slug: '%' },
      { slug: 'UPPER' },
      { slug: 1 },
    ]) {
      await expect(
        caller.listVersionHistory(input as never),
        `${JSON.stringify(input)} must be rejected`
      ).rejects.toBeInstanceOf(TRPCError);
    }
    expect(mockListVersionHistory).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — a legal slug at each bound IS accepted', async () => {
    // Without this the arm above is satisfied by a schema that rejects everything.
    const caller = blocksRouter.createCaller(fakeCtx(mod) as never);
    for (const slug of ['abc', 'a'.repeat(40), 'my-app-2']) {
      mockListVersionHistory.mockClear();
      await expect(caller.listVersionHistory({ slug })).resolves.toBeDefined();
      expect(mockListVersionHistory).toHaveBeenCalledWith({ slug });
    }
  });
});

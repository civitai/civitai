import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `blocks.persistGenerationSource` — the server half of `PERSIST_GENERATION_SOURCE`. These cases
 * pin the procedure's own chain: the publish preamble (scope, viewer, session = subject, flag),
 * the identity it hands the service (from the TOKEN, never the body), that the per-user 60/h
 * `rateLimit` middleware is applied to THIS procedure and no bridge bucket is charged, and that
 * no orchestrator token is minted before the service asks for the workflow.
 *
 * The service is a mock here; what it does with the workflow is driven against real SQL and the
 * real generation gate in `block-generation-source.behavior.test.ts`.
 */

const {
  mockAuthorizeBlockBridgeToken,
  mockParseSubjectUserId,
  mockIsAppBlocksEnabled,
  mockGetSessionUser,
  mockCheckPublishRate,
  mockCheckCatalogRate,
  mockCheckUploadAppRate,
  mockCheckGenSourceUserRate,
  mockPersistSource,
  mockGetOrchestratorToken,
  mockGetWorkflow,
  rateLimitApplied,
} = vi.hoisted(() => ({
  mockAuthorizeBlockBridgeToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockCheckPublishRate: vi.fn(),
  mockCheckCatalogRate: vi.fn(),
  mockCheckUploadAppRate: vi.fn(),
  mockCheckGenSourceUserRate: vi.fn(),
  mockPersistSource: vi.fn(),
  mockGetOrchestratorToken: vi.fn(),
  mockGetWorkflow: vi.fn(),
  rateLimitApplied: [] as unknown[],
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => mockAuthorizeBlockBridgeToken(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a) };
});
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => mockIsAppBlocksEnabled(...a),
  isAppBlocksAuthorEnabled: vi.fn(),
  isAppBlocksPostCreationEnabled: vi.fn(),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: (...a: unknown[]) => mockCheckCatalogRate(...a),
  checkBlockPostRateLimit: vi.fn(),
  checkBlockPostAppRateLimit: vi.fn(),
  checkBlockPublishRateLimit: (...a: unknown[]) => mockCheckPublishRate(...a),
  checkBlockUploadAppRateLimit: (...a: unknown[]) => mockCheckUploadAppRate(...a),
  checkBlockGenerationSourceUserRateLimit: (...a: unknown[]) => mockCheckGenSourceUserRate(...a),
}));
// The in-flight pool runs for real; `poolFull` makes its slot store answer "full" so the real
// `withInFlightLimit` refuses, which is the only way its refusal path (and its counter) runs.
const pool = vi.hoisted(() => ({ full: false }));
vi.mock('~/server/utils/concurrency-slots', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('~/server/utils/concurrency-slots');
  return {
    ...actual,
    acquireConcurrencySlot: (...a: Parameters<typeof actual.acquireConcurrencySlot>) =>
      pool.full
        ? Promise.resolve({ acquired: false as const, reason: 'full' as const })
        : actual.acquireConcurrencySlot(...a),
  };
});
vi.mock('~/server/services/blocks/block-generation-source.service', () => ({
  persistBlockGenerationSource: (...a: unknown[]) => mockPersistSource(...a),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: (...a: unknown[]) => mockGetOrchestratorToken(...a),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getWorkflow: (...a: unknown[]) => mockGetWorkflow(...a) };
});
// `rateLimit` transitively evaluates a top-level `Prisma.validator(...)`, which cannot run here,
// so it is replaced — by one that RECORDS the options of every limiter a called procedure ran,
// which is what makes "the 60/h limit is applied to THIS procedure" observable.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return {
    rateLimit: (opts: unknown) =>
      middleware(({ next }) => {
        rateLimitApplied.push(opts);
        return next();
      }),
  };
});

import promClient from 'prom-client';
import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const VIEWER_ID = 42;
const OTHER_USER_ID = 7;

function claims(over: Record<string, unknown> = {}) {
  return {
    sub: `user:${VIEWER_ID}`,
    scopes: ['ai:write:budgeted'],
    appId: 'appblk-alpha',
    appBlockId: 'apb_alpha',
    blockInstanceId: 'page_apb_alpha',
    blockId: 'my-app',
    maxBrowsingLevel: 1,
    ctx: { slotId: 'page', entityType: 'none' },
    ...over,
  };
}

function ctx(user: { id: number } = { id: VIEWER_ID }) {
  return {
    acceptableOrigin: true,
    user,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    ip: '203.0.113.9',
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: { post: vi.fn(async () => undefined) },
  };
}

const call = (input: Record<string, unknown> = {}, c = ctx()) =>
  blocksRouter.createCaller(c as never).persistGenerationSource({
    blockToken: 'tok',
    workflowId: 'wf_1',
    imageIndex: 3,
    ...input,
  } as never);

const RESULT = {
  url: 'https://image.civitai.com/x/k/original=true/k.jpeg',
  width: 512,
  height: 768,
  imageId: 9001,
  ready: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  pool.full = false;
  rateLimitApplied.length = 0;
  mockAuthorizeBlockBridgeToken.mockResolvedValue(claims());
  mockParseSubjectUserId.mockImplementation((sub: string) =>
    sub === 'anon' ? null : Number(sub.slice('user:'.length))
  );
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockGetSessionUser.mockResolvedValue({ id: VIEWER_ID });
  mockCheckPublishRate.mockResolvedValue({ allowed: true });
  mockCheckCatalogRate.mockResolvedValue({ allowed: true });
  mockCheckUploadAppRate.mockResolvedValue({ allowed: true });
  mockCheckGenSourceUserRate.mockResolvedValue({ allowed: true });
  mockPersistSource.mockResolvedValue(RESULT);
  mockGetOrchestratorToken.mockResolvedValue('orch-token');
  mockGetWorkflow.mockResolvedValue({ id: 'wf_1' });
});

describe('blocks.persistGenerationSource', () => {
  it('hands the service the TOKEN’s viewer and app, and returns its result unchanged', async () => {
    await expect(call()).resolves.toEqual(RESULT);
    expect(mockPersistSource).toHaveBeenCalledTimes(1);
    const arg = mockPersistSource.mock.calls[0][0];
    expect({
      userId: arg.userId,
      appId: arg.appId,
      appBlockId: arg.appBlockId,
      workflowId: arg.workflowId,
      imageIndex: arg.imageIndex,
    }).toEqual({
      userId: VIEWER_ID,
      appId: 'appblk-alpha',
      appBlockId: 'apb_alpha',
      workflowId: 'wf_1',
      imageIndex: 3,
    });
  });

  it('never takes the app or viewer from the request body', async () => {
    await call({ appId: 'appblk-evil', appBlockId: 'apb_evil', userId: 1 });
    const arg = mockPersistSource.mock.calls[0][0];
    expect([arg.appId, arg.appBlockId, arg.userId]).toEqual(['appblk-alpha', 'apb_alpha', 42]);
  });

  it('🔴 applies the per-user 60-per-hour rateLimit to THIS procedure, and charges no bridge bucket', async () => {
    await call();
    expect(rateLimitApplied).toHaveLength(1);
    expect(rateLimitApplied[0]).toMatchObject({ limit: 60, period: 3600 });
    // The per-install publish bucket is shared by every viewer of a page app.
    expect(mockCheckPublishRate).not.toHaveBeenCalled();
    expect(mockCheckCatalogRate).not.toHaveBeenCalled();
    expect(mockCheckUploadAppRate).not.toHaveBeenCalled();
  });

  it('🔴 charges the per-user generation-source bucket once, keyed on the token subject', async () => {
    await call();
    expect(mockCheckGenSourceUserRate.mock.calls).toEqual([[VIEWER_ID]]);
  });

  it('a refusal by that bucket is TOO_MANY_REQUESTS and never reaches the service', async () => {
    mockCheckGenSourceUserRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    await expect(call()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many generation sources saved — slow down.',
    });
    expect(mockPersistSource).not.toHaveBeenCalled();
  });

  it('mints the orchestrator token only when the service asks for the workflow', async () => {
    mockPersistSource.mockImplementation(async () => RESULT);
    await call();
    expect(mockGetOrchestratorToken).not.toHaveBeenCalled();

    mockPersistSource.mockImplementation(
      async (input: { getWorkflow: (id: string) => Promise<unknown> }) => {
        await input.getWorkflow('wf_1');
        return RESULT;
      }
    );
    await call();
    expect(mockGetOrchestratorToken).toHaveBeenCalledTimes(1);
    expect(mockGetOrchestratorToken.mock.calls[0][0]).toBe(VIEWER_ID);
    expect(mockGetWorkflow).toHaveBeenCalledWith({
      token: 'orch-token',
      path: { workflowId: 'wf_1' },
    });
  });

  it.each([
    [
      'an app without ai:write:budgeted',
      () =>
        mockAuthorizeBlockBridgeToken.mockResolvedValue(claims({ scopes: ['posts:write:self'] })),
      { code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' },
    ],
    [
      'an anonymous token subject',
      () => mockAuthorizeBlockBridgeToken.mockResolvedValue(claims({ sub: 'anon' })),
      {
        code: 'UNAUTHORIZED',
        message: 'saving a generation source requires an authenticated viewer',
      },
    ],
    [
      'the runtime flag off for the token subject',
      () => mockIsAppBlocksEnabled.mockResolvedValue(false),
      { code: 'UNAUTHORIZED', message: 'Apps are not enabled' },
    ],
  ])('refuses %s, and never reaches the service', async (_label, arrange, expected) => {
    arrange();
    await expect(call()).rejects.toMatchObject(expected);
    expect(mockPersistSource).not.toHaveBeenCalled();
  });

  it('refuses a session that is not the token subject, and never reaches the service', async () => {
    await expect(call({}, ctx({ id: OTHER_USER_ID }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'this app session belongs to a different account; reload the page to continue',
    });
    expect(mockPersistSource).not.toHaveBeenCalled();
  });

  it.each([
    ['a negative index', { imageIndex: -1 }],
    ['a fractional index', { imageIndex: 1.5 }],
    ['an empty workflow id', { workflowId: '' }],
  ])('rejects %s at the schema', async (_label, input) => {
    await expect(call(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockPersistSource).not.toHaveBeenCalled();
  });
});

describe('persistGenerationSource refusals are counted per app', () => {
  async function refusals(bucket: string): Promise<number> {
    const metric = promClient.register.getSingleMetric(
      'civitai_app_block_rate_limit_refusals_total'
    ) as
      | { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }
      | undefined;
    if (!metric) return 0;
    const { values } = await metric.get();
    return (
      values.find(
        (v) =>
          v.labels.app_block_id === 'apb_alpha' &&
          v.labels.surface === 'bridge' &&
          v.labels.bucket === bucket
      )?.value ?? 0
    );
  }

  // Pins: a full pool is recorded through withInFlightLimit's onFull, before the hourly bucket.
  it('a FULL in-flight pool is one {apb_alpha, bridge, in-flight}, and spends no bucket', async () => {
    pool.full = true;
    const before = await refusals('in-flight');
    await expect(call()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect((await refusals('in-flight')) - before).toBe(1);
    expect(mockCheckGenSourceUserRate).not.toHaveBeenCalled();
    expect(mockPersistSource).not.toHaveBeenCalled();
  });

  it('a bucket refusal is one {apb_alpha, bridge, gen-source-user}, not in-flight', async () => {
    mockCheckGenSourceUserRate.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    const before = { bucket: await refusals('gen-source-user'), pool: await refusals('in-flight') };
    await expect(call()).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect((await refusals('gen-source-user')) - before.bucket).toBe(1);
    expect((await refusals('in-flight')) - before.pool).toBe(0);
  });

  it('a served call counts nothing', async () => {
    const before = await refusals('in-flight');
    await call();
    expect((await refusals('in-flight')) - before).toBe(0);
  });
});

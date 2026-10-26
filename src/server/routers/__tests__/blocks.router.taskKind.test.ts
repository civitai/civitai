import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JWK } from 'jose';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import vectors from '~/server/services/blocks/__tests__/fixtures/task-router-tickets.json';
import type * as BridgeAuthModule from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccessModule from '~/server/services/blocks/block-token-access.service';
import type * as FlagModule from '~/server/services/app-blocks-flag';
import type * as AttributionModule from '~/server/services/blocks/buzz-attribution.service';
import type * as RateLimitModule from '~/server/utils/block-catalog-rate-limit';
import type * as SettleModule from '~/server/services/blocks/custom-comfy-settle.service';
import type * as AppSpendModule from '~/server/services/blocks/app-spend-cap.service';
import type * as DevTunnelModule from '~/server/services/blocks/dev-tunnel.service';
import type * as BlockWorkflowsModule from '~/server/services/blocks/block-workflows.service';
import type * as SurfaceModule from '~/server/services/blocks/user-app-surface.service';
import type * as WorkflowsModule from '~/server/services/orchestrator/workflows';
import type * as TaskRouterModule from '~/server/services/blocks/task-router.service';
import type * as UserModule from '~/server/services/user.service';
import type * as SubscriptionsModule from '~/server/services/subscriptions.service';

/**
 * `kind:'task'` through `blocksRouter.submitWorkflow`. Tickets are verified for real (the
 * router repo's vectors, plus tickets signed here); the match and the orchestrator are
 * stubbed, and the pass-through spend path runs over an in-memory Redis.
 */

const VECTOR_TIME = new Date('2026-10-26T20:01:00Z');
const TASK_ID = 'tsk_01JVECTOR00000000000000000';
const WORKFLOW_ID = '42-20261026';

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  taskFlag: vi.fn(async () => true),
  submitWorkflow: vi.fn(),
  matchTask: vi.fn(),
  reportTaskStarted: vi.fn(async () => undefined),
  jwks: { current: undefined as unknown },
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BridgeAuthModule>()),
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
}));
vi.mock('~/server/services/blocks/block-token-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenAccessModule>()),
  assertAppBlocksEnabledForTokenUser: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagModule>()),
  isAppBlocksTaskKindEnabled: (...a: unknown[]) => h.taskFlag(...(a as [])),
  isAppBlocksAuthorFeeEnabled: async () => false,
}));
vi.mock('~/server/services/blocks/task-router.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TaskRouterModule>()),
  matchTask: (...a: unknown[]) => h.matchTask(...a),
  reportTaskStarted: (...a: unknown[]) => h.reportTaskStarted(...(a as [])),
  taskRouterJwks: () => h.jwks.current,
  // The vectors were signed for this user ref.
  taskRouterUserRef: () => vectors.user,
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: async () => 'orch-token',
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowsModule>()),
  submitWorkflow: (...a: unknown[]) => h.submitWorkflow(...a),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserModule>()),
  getUserById: vi.fn(async () => ({ id: 42, isModerator: false })),
}));
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionsModule>()),
  getHighestTierSubscription: vi.fn(async () => null),
}));
vi.mock('~/server/services/blocks/app-spend-cap.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppSpendModule>()),
  reserveAppSpend: vi.fn(async () => ({ allowed: true, dailyKey: 'app-daily' })),
  refundAppSpend: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/dev-tunnel.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DevTunnelModule>()),
  getActiveDevTunnel: vi.fn(async () => null),
}));
vi.mock('~/server/services/blocks/block-workflows.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockWorkflowsModule>()),
  upsertBlockWorkflowOnSubmit: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/custom-comfy-settle.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SettleModule>()),
  persistCustomComfySettle: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AttributionModule>()),
  recordSpendAttribution: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/user-app-surface.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SurfaceModule>()),
  recordScopeInvocation: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  checkBlockCatalogRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import '~/server/services/blocks/task-router.service';
import '~/server/services/blocks/user-app-surface.service';
import '~/server/services/blocks/buzz-attribution.service';
import '~/server/services/blocks/block-workflows.service';
import '~/server/services/blocks/app-spend-cap.service';
import '~/server/services/blocks/dev-tunnel.service';
import '~/server/services/app-blocks-flag';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const store = new Map<string, string>();
function installRedis() {
  const r = redisMock.sysRedis;
  r.get.mockImplementation(async (k: string) => store.get(k) ?? null);
  r.set.mockImplementation(async (k: string, v: string, opts?: { NX?: boolean }) => {
    if (opts?.NX && store.has(k)) return null;
    store.set(k, String(v));
    return 'OK';
  });
  r.del.mockImplementation(async (k: string) => (store.delete(k) ? 1 : 0));
  r.incrBy.mockImplementation(async (k: string, n: number) => {
    const v = Number(store.get(k) ?? 0) + n;
    store.set(k, String(v));
    return v;
  });
  r.decrBy.mockImplementation(async (k: string, n: number) => {
    const v = Number(store.get(k) ?? 0) - n;
    store.set(k, String(v));
    return v;
  });
  r.expire.mockImplementation(async () => true);
  r.ttl.mockImplementation(async () => 3600);
}

function claims() {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: 'user:42',
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'page_apb_test',
    ctx: { slotId: 'app.page', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 37,
    maxBrowsingLevel: 1,
  };
}

const vectorTicket = (name: string) => vectors.cases.find((c) => c.name === name)!.ticket;
function matchReturning(ticket: string, taskId = TASK_ID, steps = ['s0'], event = 'kept') {
  h.matchTask.mockImplementation(async () => ({
    ok: true,
    match: {
      status: 'matched',
      taskId,
      resolvedAs: steps.map((step) => ({
        step,
        goal: 'image.edit@1',
        tier: 'standard',
        ability: 'orch.image.edit.nano-banana-2-lite',
        provider: 'civitai-orchestrator',
        via: 'sticky',
        assignment: { event },
      })),
      quote: { amount: 8, currency: 'buzz' },
      ticket,
    },
  }));
}

type SubmitArgs = {
  body: {
    steps: Array<Record<string, unknown>>;
    tags: string[];
    metadata?: Record<string, unknown>;
    callbacks?: unknown[];
    externalId?: string;
  };
  query?: { whatif?: boolean };
};
const orchestratorCalls = () => h.submitWorkflow.mock.calls.map((c) => c[0] as SubmitArgs);
const realSubmits = () => orchestratorCalls().filter((a) => a.query?.whatif !== true);

const TASK_BODY = {
  kind: 'task',
  task: 'image.edit@1',
  input: { prompt: 'make it night', images: ['https://img.example/a.png'] },
  maxBuzz: 20,
};
const caller = () =>
  blocksRouter.createCaller({
    acceptableOrigin: true,
    user: undefined,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: {},
    track: undefined,
  } as never);
type Snap = {
  workflowId: string;
  status: string;
  error?: string;
  errorCode?: string;
  task?: Record<string, unknown>;
};
const submit = async (body: Record<string, unknown> = TASK_BODY) =>
  (await caller().submitWorkflow({ blockToken: 't', body: body as never })) as { snapshot: Snap };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(VECTOR_TIME);
  store.clear();
  installRedis();
  for (const fn of [h.authorize, h.taskFlag, h.submitWorkflow, h.matchTask, h.reportTaskStarted]) {
    fn.mockClear();
  }
  h.authorize.mockImplementation(async () => claims());
  h.taskFlag.mockImplementation(async () => true);
  h.jwks.current = createLocalJWKSet(vectors.jwks as { keys: JWK[] });
  h.submitWorkflow.mockImplementation(async (args: SubmitArgs) =>
    args.query?.whatif
      ? { id: 'whatif-id', status: 'scheduled', cost: { total: 8, base: 8 } }
      : {
          id: WORKFLOW_ID,
          status: 'scheduled',
          cost: { total: 8, base: 8 },
          transactions: { list: [] },
          steps: args.body.steps.map((s) => ({ ...s, status: 'scheduled' })),
        }
  );
  matchReturning(vectorTicket('valid'));
  envMock.set({
    TASK_ROUTER_URL: 'https://router.internal.example.invalid',
    TASK_ROUTER_PARTY_KEY: 'party-key',
    TASK_ROUTER_CALLBACK_ORIGIN: vectors.callbackOrigin,
    TASK_ROUTER_APP_ALLOWLIST: ['app_test'],
  });
});
afterEach(() => {
  vi.useRealTimers();
  envMock.reset();
});

describe("kind:'task' submit", () => {
  it("runs the ticket's step once on the pass-through path, with the router's fields merged", async () => {
    const { snapshot } = await submit();

    expect(h.matchTask.mock.calls[0][1]).toMatchObject({
      task: 'image.edit@1',
      budget: { amount: 20, currency: 'buzz' },
      requester: { app: 'app_test', user: vectors.user },
    });
    expect(realSubmits()).toHaveLength(1);
    const sent = realSubmits()[0].body;
    expect(sent.steps).toHaveLength(1);
    expect(sent.steps[0]).toMatchObject({
      $type: 'imageGen',
      input: { engine: 'google', model: 'nano-banana-2-lite' },
    });
    expect(sent.tags).toHaveLength(10);
    expect(sent.tags).toEqual(
      expect.arrayContaining(['app-block:app_test', 'task:image.edit@1', `tr:${TASK_ID}`])
    );
    expect(sent.metadata).toMatchObject({ taskRouter: { taskId: TASK_ID } });
    expect(sent.callbacks).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/^https:\/\/task-router\.example\.invalid\//),
      }),
    ]);
    expect(sent.externalId).toContain(TASK_ID);

    expect(snapshot.workflowId).toBe(WORKFLOW_ID);
    expect(snapshot.task).toMatchObject({
      status: 'matched',
      taskId: TASK_ID,
      resolvedAs: [{ step: 's0', ability: 'orch.image.edit.nano-banana-2-lite' }],
      moved: false,
    });
    expect(h.reportTaskStarted).toHaveBeenCalledWith(expect.anything(), TASK_ID, WORKFLOW_ID);
  });

  it('runs a chain ticket as one kind:workflow job, references intact', async () => {
    const chain = vectors.cases.find((c) => c.name === 'valid_chain')!;
    matchReturning(chain.ticket, chain.sub, ['gen', 'cut'], 'moved');
    const { snapshot } = await submit({
      kind: 'task',
      steps: [
        { name: 'gen', task: 'image.generate@1', input: { prompt: 'a red fox sticker' } },
        {
          name: 'cut',
          task: 'image.removeBackground@1',
          input: { image: { $ref: 'gen', output: 'image' } },
        },
      ],
      maxBuzz: 20,
    });

    expect(realSubmits()).toHaveLength(1);
    const sent = realSubmits()[0].body;
    expect(sent.steps.map((step) => step.$type)).toEqual(['imageGen', 'imageBackgroundRemoval']);
    expect(sent.steps[1].input).toEqual({ image: { $ref: 'gen', path: 'output.images[0].url' } });
    expect(sent.tags).toHaveLength(10);
    expect(sent.tags).toEqual(expect.arrayContaining(['task:chain', `tr:${chain.sub}`]));
    expect(sent.metadata).toMatchObject({ taskRouter: { taskId: chain.sub } });
    expect(Object.keys(sent.metadata ?? {})).toHaveLength(2);
    expect(sent.callbacks).toHaveLength(1);
    expect(sent.externalId).toContain(chain.sub);
    expect(snapshot.task).toMatchObject({ status: 'matched', taskId: chain.sub, moved: true });
  });

  it('submits a replayed ticket to the orchestrator once', async () => {
    await submit();
    const replay = await submit();
    expect(realSubmits()).toHaveLength(1);
    expect(replay.snapshot.workflowId).toBe(WORKFLOW_ID);
  });

  it.each(['tampered_quote', 'expired', 'wrong_audience'])(
    'refuses the %s ticket before any orchestrator call',
    async (name) => {
      const vector = vectors.cases.find((c) => c.name === name)!;
      vi.setSystemTime(new Date(vector.verifyAt));
      matchReturning(vector.ticket);
      const { snapshot } = await submit();
      expect(snapshot.errorCode).toBe('task-ticket-invalid');
      expect(orchestratorCalls()).toHaveLength(0);
    }
  );

  it("passes the router's refusal through without spending", async () => {
    h.matchTask.mockImplementation(async () => ({
      ok: false,
      code: 'tier_unavailable',
      message: 'no best tier',
    }));
    const { snapshot } = await submit();
    expect(snapshot).toMatchObject({ status: 'failed', errorCode: 'tier_unavailable' });
    expect(orchestratorCalls()).toHaveLength(0);
  });

  it('returns an off-menu ask as not_yet, with its demand id, without spending', async () => {
    h.matchTask.mockImplementation(async () => ({
      ok: true,
      notYet: { status: 'not_yet', demandId: 'dem_1', closest: [] },
    }));
    const { snapshot } = await submit({
      kind: 'task',
      description: 'vectorize this image as an SVG',
      input: { image: 'https://img.example/a.png', extra: true },
      maxBuzz: 20,
    });
    expect(h.matchTask.mock.calls[0][1]).toMatchObject({
      description: 'vectorize this image as an SVG',
      input: { extra: true },
    });
    expect(snapshot).toMatchObject({
      errorCode: 'not_yet',
      task: { status: 'not_yet', demandId: 'dem_1', closest: [] },
    });
    expect(orchestratorCalls()).toHaveLength(0);
  });

  it('refuses an app off the allowlist, or a viewer without the flag, before calling the router', async () => {
    envMock.set({ TASK_ROUTER_APP_ALLOWLIST: ['app_other'] });
    await expect(submit()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    envMock.set({ TASK_ROUTER_APP_ALLOWLIST: ['app_test'] });
    h.taskFlag.mockImplementation(async () => false);
    await expect(submit()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.matchTask).not.toHaveBeenCalled();
  });

  it('refuses when the router is not configured', async () => {
    envMock.set({ TASK_ROUTER_URL: undefined });
    await expect(submit()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(h.matchTask).not.toHaveBeenCalled();
  });

  it('clamps the budget it asks for to the per-call budget', async () => {
    h.authorize.mockImplementation(async () => ({ ...claims(), buzzBudget: 12 }));
    await submit();
    expect(h.matchTask.mock.calls[0][1]).toMatchObject({ budget: { amount: 12 } });
  });

  describe('on tickets signed here', () => {
    async function useLocalTicket(workflow: Record<string, unknown>) {
      const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
      h.jwks.current = createLocalJWKSet({
        keys: [{ ...(await exportJWK(publicKey)), kid: 'local', alg: 'EdDSA' }],
      });
      const now = Math.floor(VECTOR_TIME.getTime() / 1000);
      const ticket = await new SignJWT({
        v: 2,
        provider: 'civitai-orchestrator',
        steps: [{ name: 's0', goal: 'image.edit@1', ability: 'orch.x', via: 'rank' }],
        budget: vectors.budget,
        quote: { amount: 8, currency: 'buzz' },
        user: vectors.user,
        request: {
          kind: 'orchestrator.workflow',
          workflow: {
            steps: [{ $type: 'imageGen', input: { prompt: 'p' } }],
            tags: ['task:image.edit@1', 'tr:tsk_local'],
            metadata: { taskRouter: { v: 1 } },
            callbacks: [],
            ...workflow,
          },
        },
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'local' })
        .setIssuer('task-router')
        .setAudience(vectors.audience)
        .setSubject('tsk_local')
        .setJti('tsk_local')
        .setIssuedAt(now)
        .setExpirationTime(now + 120)
        .sign(privateKey);
      matchReturning(ticket, 'tsk_local');
    }

    it('refuses a platform-internal step type before any orchestrator call', async () => {
      await useLocalTicket({ steps: [{ $type: 'modelClamScan', input: {} }] });
      await expect(submit()).rejects.toThrow(/modelClamScan/);
      expect(orchestratorCalls()).toHaveLength(0);
    });

    it('refuses a ticket whose tags would exceed the orchestrator cap, before any call', async () => {
      await useLocalTicket({ tags: ['task:image.edit@1', 'tr:tsk_local', 'tr:extra'] });
      await expect(submit()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
      expect(orchestratorCalls()).toHaveLength(0);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as FliptClient from '~/server/flipt/client';
import type * as OrchestrationClient from '@civitai/orchestration-client';

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

// An app with offline access whose Buzz cap is spent can still read, list and cancel its work, but
// cannot boost or unlock work that is already running: the orchestrator does not hold those spends
// to the cap. Everything from the router to the orchestrator client is real; the boundaries are
// the client package, Flipt, the databases and the orchestrator's spend snapshot over fetch.

const USER = 4242;
const TOKEN = 'civitai_app-token';

vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationClient>()),
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(async () => ({ data: { id: 'w1', steps: [] } })),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(async () => ({ data: { items: [], next: undefined } })),
  removeWorkflowTag: vi.fn(),
  submitWorkflow: vi.fn(),
  updateWorkflow: vi.fn(async () => ({
    data: { id: 'w1', steps: [], cost: { fixed: { yellow: 10 } } },
    response: { ok: true, status: 200 },
  })),
  refreshBlob: vi.fn(),
  getConsumerBlobUploadUrl: vi.fn(),
  handleError: vi.fn((error) => (error as { detail?: string })?.detail ?? 'orchestrator error'),
  createCivitaiClient: vi.fn().mockReturnValue({
    getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
  }),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    // Both own-key flags on: a personal key is sent as itself too, and is still never checked here.
    isFlipt: vi.fn(async (key: string) =>
      [
        actual.FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT,
        actual.FLIPT_FEATURE_FLAGS.USER_KEY_BUZZ_LIMIT_PROXY,
      ].includes(key as FliptClient.FLIPT_FEATURE_FLAGS)
    ),
  };
});
vi.mock('~/server/db/kyselyDb', () => {
  const qb = {
    select: () => qb,
    where: () => qb,
    executeTakeFirst: async () => ({ mintOrigin: 'refresh' }),
  };
  return { kyselyWrite: { selectFrom: () => qb } };
});

const { updateWorkflow: clientUpdateWorkflow, getWorkflow: clientGetWorkflow } = await import(
  '@civitai/orchestration-client'
);
const { OnboardingSteps } = await import('~/server/common/enums');
const { OFFLINE_BUZZ_CAP_REACHED } = await import(
  '~/server/orchestrator/api-key-buzz-limit-refusal'
);
const { orchestratorRouter } = await import('~/server/routers/orchestrator.router');
const { TokenScope } = await import('~/shared/constants/token-scope.constants');

const LIMIT = [{ type: 'sliding', limit: 500, window: 'day', unit: 1 }];
const credentials = {
  oauth: { apiKeyId: 9, apiKeyType: 'Access', subject: { type: 'oauth', id: 'offline-app' } },
  personal: { apiKeyId: 7, apiKeyType: 'User', subject: { type: 'apiKey', id: 7 } },
};

const caller = (credential: keyof typeof credentials = 'oauth') => {
  const req = {
    url: '/api/trpc/orchestrator.boostWorkflow',
    headers: { authorization: `Bearer ${TOKEN}` },
    context: {
      session: { user: { id: USER, meta: {} } },
      tokenScope: TokenScope.Full,
      buzzLimit: LIMIT,
      ...credentials[credential],
    },
  };
  return orchestratorRouter.createCaller({
    user: {
      id: USER,
      isModerator: false,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw: false,
    },
    req,
    res: {},
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    ...credentials[credential],
  } as never);
};

/** The orchestrator's spend snapshot for the app, with `remaining` Buzz left of 500. */
const snapshot = (remaining: number) =>
  Response.json({
    rules: [
      { type: 'Sliding', limit: 500, spend: 500 - remaining, remaining, window: 'Day', unit: 1 },
    ],
  });
let fetchSpy: ReturnType<typeof vi.fn>;
const answerWith = (response: () => Response) => {
  fetchSpy = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchSpy);
};
/** The bodies the orchestrator client was asked to write. */
const writes = () =>
  vi
    .mocked(clientUpdateWorkflow)
    .mock.calls.map((c) => ((c as unknown[])[0] as { body?: object }).body ?? {});
const boostWrites = () => writes().filter((body) => 'downloadPriority' in body);
const unlockWrites = () => writes().filter((body) => 'allowMatureContent' in body);
const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e
  );

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({
    ORCHESTRATOR_MODE: 'prod',
    ORCHESTRATOR_ENDPOINT: 'https://orchestration.test',
    ORCHESTRATOR_ACCESS_TOKEN: 't',
  });
  redisMock.redis.packed.get.mockResolvedValue({
    data: { muted: false, banned: false, exists: true },
    cachedAt: Date.now(),
  } as never);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({
    muted: false,
    bannedAt: null,
    deletedAt: null,
    meta: {},
  } as never);
});
afterEach(() => vi.unstubAllGlobals());

const boost = (c = caller(), expectedCost = 10) =>
  c.boostWorkflow({ workflowId: 'w1', expectedCost });
const unlock = (c = caller()) => c.updateWorkflow({ workflowId: 'w1', allowMatureContent: true });

describe('an offline app whose cap is spent', () => {
  beforeEach(() => answerWith(() => snapshot(0)));

  it('cannot boost work already running', async () => {
    expect(await caught(boost())).toMatchObject({
      code: 'FORBIDDEN',
      message: OFFLINE_BUZZ_CAP_REACHED,
    });
    expect(boostWrites()).toEqual([]);
  });

  it('cannot unlock work already running', async () => {
    expect(await caught(unlock())).toMatchObject({
      code: 'FORBIDDEN',
      message: OFFLINE_BUZZ_CAP_REACHED,
    });
    expect(unlockWrites()).toEqual([]);
  });

  it('can still read, list and cancel its work, without reading the spend', async () => {
    const c = caller();
    await c.getWorkflow({ workflowId: 'w1' });
    await c.queryWorkflowsByTags({ tags: [] } as never);
    await c.cancelWorkflow({ workflowId: 'w1' });
    expect(clientGetWorkflow).toHaveBeenCalled();
    expect(writes()).toEqual([{ status: 'canceled' }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('an offline app with Buzz left under its cap', () => {
  beforeEach(() => answerWith(() => snapshot(120)));

  it('can boost', async () => {
    await caught(boost());
    expect(boostWrites().length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('can unlock', async () => {
    await caught(unlock());
    // The unlock goes on to the orchestrator: it reads the workflow it would release.
    expect(clientGetWorkflow).toHaveBeenCalled();
  });
});

describe('an offline app with 50 Buzz left under its cap', () => {
  beforeEach(() => answerWith(() => snapshot(50)));

  it('cannot boost for more than it has left', async () => {
    expect(await caught(boost(caller(), 300))).toMatchObject({
      code: 'FORBIDDEN',
      message: OFFLINE_BUZZ_CAP_REACHED,
    });
    expect(boostWrites()).toEqual([]);
  });

  it('can boost for less than it has left', async () => {
    await caught(boost(caller(), 40));
    expect(boostWrites().length).toBeGreaterThan(0);
  });
});

it('an offline app cannot boost when its spend cannot be read', async () => {
  answerWith(() => new Response('upstream error', { status: 500 }));
  expect(await caught(boost())).toMatchObject({ code: 'FORBIDDEN' });
  expect(boostWrites()).toEqual([]);
});

it('a personal key with a spent limit still boosts, reading no spend', async () => {
  answerWith(() => snapshot(0));
  await caught(boost(caller('personal')));
  expect(boostWrites().length).toBeGreaterThan(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

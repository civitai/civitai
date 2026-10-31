import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The graph entry points (generateFromGraph, whatIfFromGraph and the App Blocks
 * createWorkflowStepsFromGraphInput) check every url of the validated input
 * before anything reads or forwards it. The module preamble mirrors
 * `orchestration-new.raw-air.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  assertInputs: vi.fn(),
  resolveSourceImageIds: vi.fn(async () => [] as number[]),
}));

vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertGenerationInputsUsable: mocks.assertInputs,
}));
vi.mock('~/server/services/orchestrator/remix-provenance', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSourceImageIds: mocks.resolveSourceImageIds,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  auditPromptServer: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(async () => ({ id: 'sub' })),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/db/datapacketDb', () => ({ datapacketDbRead: {}, datapacketDbWrite: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveTestingAccess: vi.fn(async () => false),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import type { GenerationCtx } from '~/shared/generation/context';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  createWorkflowStepsFromGraphInput,
  generateFromGraph,
  whatIfFromGraph,
} from '~/server/services/orchestrator/orchestration-new.service';

const USER_ID = 5;
const SOURCE = 'https://image.civitai.com/x/ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d/original=true';
const STYLE_URL = 'https://example.com/style.png';
const refused = new TRPCError({ code: 'BAD_REQUEST', message: 'unavailable' });

const externalCtx = (): GenerationCtx => ({
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: true, tier: 'bronze' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
});

const graphInput = () => ({
  workflow: 'img2img',
  ecosystem: 'SDXL',
  model: { id: 128078 },
  resources: [],
  prompt: `a cat in the style of ${STYLE_URL} please`,
  images: [{ url: SOURCE, width: 512, height: 512 }],
  sampler: 'Euler',
  steps: 25,
  quantity: 1,
  priority: 'low',
});

beforeEach(() => {
  vi.clearAllMocks();
  resetHybridNodes();
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
  mocks.assertInputs.mockRejectedValue(refused);
});

/** One check, for the caller, naming the source url and not the url inside the prompt. */
const expectChecked = (entry: string, isApiCaller: boolean) => {
  expect(mocks.assertInputs).toHaveBeenCalledTimes(1);
  const [{ urls, userId, ...gate }] = mocks.assertInputs.mock.calls[0] as [
    { urls: string[]; userId: number; entry: string; isApiCaller: boolean }
  ];
  expect(userId).toBe(USER_ID);
  expect(gate).toEqual({ entry, isApiCaller });
  expect(urls).toEqual([SOURCE]);
  expect(mocks.resolveSourceImageIds).not.toHaveBeenCalled();
};

describe('graph entry points check their input urls', () => {
  it('generateFromGraph refuses before provenance or submission', async () => {
    await expect(
      generateFromGraph({
        input: graphInput(),
        externalCtx: externalCtx(),
        token: 'token',
        userId: USER_ID,
        isModerator: false,
        inputGate: { entry: 'generateFromGraph', isApiCaller: true },
      })
    ).rejects.toBe(refused);
    expectChecked('generateFromGraph', true);
  });

  it('whatIfFromGraph refuses with the same error', async () => {
    await expect(
      whatIfFromGraph({
        input: graphInput(),
        externalCtx: externalCtx(),
        token: 'token',
        userId: USER_ID,
        isModerator: false,
        inputGate: { entry: 'whatIfFromGraph', isApiCaller: false },
      })
    ).rejects.toBe(refused);
    expectChecked('whatIfFromGraph', false);
  });

  it('createWorkflowStepsFromGraphInput (App Blocks) refuses before provenance', async () => {
    await expect(
      createWorkflowStepsFromGraphInput({
        input: graphInput(),
        externalCtx: externalCtx(),
        user: { id: USER_ID, isModerator: false },
        inputGate: { entry: 'appBlocks', isApiCaller: false },
      })
    ).rejects.toBe(refused);
    expectChecked('appBlocks', false);
  });

  it('skips the check only for input its caller already checked', async () => {
    mocks.assertInputs.mockResolvedValue(undefined);
    await whatIfFromGraph({
      input: graphInput(),
      externalCtx: externalCtx(),
      token: 'token',
      userId: USER_ID,
      inputGate: 'checked-by-caller',
    }).catch(() => undefined);
    expect(mocks.assertInputs).not.toHaveBeenCalled();
  });
});

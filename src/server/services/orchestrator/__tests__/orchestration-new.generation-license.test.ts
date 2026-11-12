import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every submit path checks the generation licence the selected ecosystem requires; whatIf does
 * not. The module preamble mirrors `orchestration-new.generation-input-gate.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  assertInputs: vi.fn(async () => undefined),
  assertLicense: vi.fn(),
  resolveSourceImageIds: vi.fn(async () => [] as number[]),
}));

vi.mock('~/server/services/generation-license.service', () => ({
  assertGenerationLicenseAccepted: mocks.assertLicense,
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
const notAccepted = new TRPCError({ code: 'FORBIDDEN', message: 'accept the licence' });

const externalCtx = (): GenerationCtx => ({
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: true, tier: 'bronze' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
});

const graphInput = () => ({
  workflow: 'txt2img',
  ecosystem: 'SDXL',
  model: { id: 128078 },
  resources: [],
  prompt: 'a cat',
  sampler: 'Euler',
  steps: 25,
  quantity: 1,
  priority: 'low',
});

beforeEach(() => {
  vi.clearAllMocks();
  resetHybridNodes();
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
  mocks.assertLicense.mockRejectedValue(notAccepted);
});

const expectAskedFor = () =>
  expect(mocks.assertLicense).toHaveBeenCalledWith({ ecosystem: 'SDXL', userId: USER_ID });

describe('submit paths check the generation licence', () => {
  it('generateFromGraph refuses before submitting', async () => {
    await expect(
      generateFromGraph({
        input: graphInput(),
        externalCtx: externalCtx(),
        token: 'token',
        userId: USER_ID,
        isModerator: false,
        inputGate: { entry: 'generateFromGraph', isApiCaller: false },
      })
    ).rejects.toBe(notAccepted);
    expectAskedFor();
  });

  it('the App Blocks submit refuses too', async () => {
    await expect(
      createWorkflowStepsFromGraphInput({
        input: graphInput(),
        externalCtx: externalCtx(),
        user: { id: USER_ID, isModerator: false },
        isWhatIf: false,
        inputGate: { entry: 'appBlocks', isApiCaller: false },
      })
    ).rejects.toBe(notAccepted);
    expectAskedFor();
  });

  it('pricing a request asks nothing', async () => {
    await whatIfFromGraph({
      input: graphInput(),
      externalCtx: externalCtx(),
      token: 'token',
      userId: USER_ID,
      isModerator: false,
      inputGate: { entry: 'whatIfFromGraph', isApiCaller: false },
    }).catch(() => undefined);
    await createWorkflowStepsFromGraphInput({
      input: graphInput(),
      externalCtx: externalCtx(),
      user: { id: USER_ID, isModerator: false },
      isWhatIf: true,
      inputGate: { entry: 'appBlocks', isApiCaller: false },
    }).catch(() => undefined);
    // Both calls got past the input-url check, which runs right before where the licence check
    // would, so a failure earlier on cannot make the assertion below pass vacuously.
    expect(mocks.assertInputs).toHaveBeenCalledTimes(2);
    expect(mocks.assertLicense).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Remove Background sends the orchestrator's imageBackgroundRemoval step for both
 * models: BiRefNet by default, RMBG 3.0 when the user picks it. The module preamble mirrors `orchestration-new.generation-input-gate.test.ts`.
 */

vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertGenerationInputsUsable: vi.fn(async () => undefined),
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
import { createWorkflowStepsFromGraphInput } from '~/server/services/orchestrator/orchestration-new.service';

const SOURCE = 'https://image.civitai.com/x/ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d/original=true';

const externalCtx = (): GenerationCtx => ({
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: true, tier: 'bronze' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
});

async function stepFor(extra: Record<string, unknown>) {
  const { steps } = await createWorkflowStepsFromGraphInput({
    input: {
      workflow: 'img2img:remove-background',
      images: [{ url: SOURCE, width: 512, height: 512 }],
      priority: 'low',
      ...extra,
    },
    externalCtx: externalCtx(),
    user: { id: 5, isModerator: false },
    isWhatIf: true,
    inputGate: { entry: 'whatIfFromGraph', isApiCaller: false },
  });
  expect(steps).toHaveLength(1);
  return steps[0] as { $type: string; input: Record<string, unknown> };
}

beforeEach(() => {
  resetHybridNodes();
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true);
});

describe('remove background model choice', () => {
  it('runs BiRefNet when no model is picked', async () => {
    const step = await stepFor({});

    expect(step.$type).toBe('imageBackgroundRemoval');
    expect(step.input).toMatchObject({ image: SOURCE, model: 'birefnet' });
  });

  it('sends RMBG 3.0 to the orchestrator when picked', async () => {
    const step = await stepFor({ backgroundRemovalModel: 'rmbg3' });

    expect(step.$type).toBe('imageBackgroundRemoval');
    expect(step.input).toMatchObject({ image: SOURCE, model: 'rmbg3' });
  });
});

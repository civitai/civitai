import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every generateFromGraph submission that reaches `submitWorkflow` has passed the prompt audit, and
 * the generation input url check refuses before either runs. The harness mirrors
 * `orchestration-new.submit-reply-coverage.test.ts`, which reaches `submitWorkflow` for real; the
 * pass case here is the control that the submit assertion can fail.
 */

vi.mock('@civitai/orchestration-client', async () =>
  (await import('./civitai-client.stub')).civitaiClientStub()
);

const mocks = vi.hoisted(() => ({
  assertInputs: vi.fn(),
  auditPromptServer: vi.fn(async (): Promise<void> => undefined),
  submitWorkflow: vi.fn(async ({ body }: { body: Record<string, unknown> }) => ({
    // `<userId>-<timestamp>`: `assertWorkflowOwner` checks the prefix against the submitter.
    id: '1-20260101000000000',
    status: 'succeeded',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    steps: [],
    cost: { total: 60 },
    transactions: { list: [] },
    metadata: body.metadata,
  })),
}));

vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertGenerationInputsUsable: mocks.assertInputs,
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: mocks.submitWorkflow,
  deleteWorkflow: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: mocks.auditPromptServer,
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: vi.fn(async () => undefined),
}));
vi.mock('~/server/orchestrator/orchestrator-identity-metrics', () => ({
  observeConsumerMismatch: vi.fn(),
  observeConsumerUnverifiable: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: vi.fn(async () => false),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  resolveTestingAccess: vi.fn(async () => false),
  getGateRules: vi.fn(async () => []),
  getSelfHostedDisabledEcosystems: vi.fn(() => [] as string[]),
  getResourceData: vi.fn(async (refs: { id: number }[]) =>
    refs.map(({ id }) => ({
      id,
      name: 'Checkpoint',
      baseModel: 'Qwen',
      air: `urn:air:qwen:checkpoint:civitai:1@${id}`,
      model: { id: 1, name: 'Checkpoint', type: 'Checkpoint', poi: false },
      availability: 'Public',
      covered: true,
      canGenerate: true,
    }))
  ),
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
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
  imagesForModelVersionsCache: {},
}));

import { generateFromGraph } from '~/server/services/orchestrator/orchestration-new.service';
import { getWorkflowCapability } from '~/shared/generation/workflow-capability';

const CHECKPOINT_ID = getWorkflowCapability('Qwen', 'txt2img')?.defaultModelId as number;
const refused = new TRPCError({ code: 'BAD_REQUEST', message: 'unavailable' });

const submit = () =>
  generateFromGraph({
    input: {
      workflow: 'txt2img',
      ecosystem: 'Qwen',
      model: { id: CHECKPOINT_ID },
      resources: [],
      prompt: 'a cat',
      sampler: 'Euler',
      steps: 25,
      quantity: 1,
      priority: 'low',
    },
    externalCtx: {
      limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
      user: { isMember: true, tier: 'bronze' },
      flags: {},
      selfHostedDisabledEcosystems: [],
      selfHostedMode: 'enabled',
      gateRules: [],
    },
    userId: 1,
    isModerator: false,
    token: 't',
    experimental: false,
    inputGate: { entry: 'generateFromGraph', isApiCaller: false },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateFromGraph — input url check, prompt audit and submit', () => {
  it('a submission whose urls pass is audited once, then submitted once', async () => {
    mocks.assertInputs.mockResolvedValue(undefined);
    await submit();
    expect(mocks.assertInputs).toHaveBeenCalledTimes(1);
    expect(mocks.auditPromptServer).toHaveBeenCalledTimes(1);
    expect(mocks.submitWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.auditPromptServer.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.submitWorkflow.mock.invocationCallOrder[0]
    );
  });

  it('a refused submission is neither audited nor submitted', async () => {
    mocks.assertInputs.mockRejectedValue(refused);
    await expect(submit()).rejects.toBe(refused);
    expect(mocks.auditPromptServer).not.toHaveBeenCalled();
    expect(mocks.submitWorkflow).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetWorkflow, mockGetHighestTierSubscription } = vi.hoisted(() => ({
  mockGetWorkflow: vi.fn(),
  mockGetHighestTierSubscription: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowsMod>()),
  getWorkflow: mockGetWorkflow,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptAuditingMod>()),
  auditPromptServer: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: (...args: unknown[]) => mockGetHighestTierSubscription(...args),
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

import type * as WorkflowsMod from '~/server/services/orchestrator/workflows';
import type * as PromptAuditingMod from '~/server/services/orchestrator/promptAuditing';
import {
  formatGenerationResponse2,
  getWorkflowStatusUpdate,
} from '~/server/services/orchestrator/orchestration-new.service';

const MARKER = 'PLANTED-EPOCH-HANDLE';
const planted = { url: `https://example.invalid/${MARKER}.safetensors`, id: MARKER };
const workflow = () =>
  ({
    id: 'wf-1',
    status: 'succeeded',
    createdAt: new Date().toISOString(),
    metadata: { params: { prompt: 'x' } },
    steps: [
      {
        $type: 'training',
        name: 't',
        status: 'succeeded',
        metadata: { modelFileId: 11, output: [planted], images: [planted], params: { e: planted } },
        input: { continueFrom: `urn:air:flux1:lora:blob:${MARKER}` },
        output: {
          epochs: [{ epochNumber: 1, model: { type: 'model', available: true, ...planted } }],
        },
      },
      {
        $type: 'merge',
        name: 'm',
        status: 'succeeded',
        metadata: { params: { e: planted } },
        input: { fields: { e: { $ref: 't', path: 'output.epochs[*].model' } } },
        output: { fields: { e: [planted] } },
      },
    ],
  } as never);

const workflowWithPreparation = () => {
  const base = workflow() as unknown as { steps: Record<string, unknown>[] };
  // A continued run waits on its source epoch, a supplied LoRA blob the summary keeps.
  base.steps[0].preparation = [
    { resource: `urn:air:flux1:lora:orchestrator:blob@${MARKER}`, sizeBytes: 1, lane: 'normal' },
  ];
  return base as never;
};

describe('formatGenerationResponse2 — a training run’s weights', () => {
  beforeEach(() => mockGetHighestTierSubscription.mockResolvedValue(null));

  it('names none of them to a non-moderator, even copies planted in step metadata', async () => {
    const formatted = await formatGenerationResponse2([workflow()], { id: 5, isModerator: false });
    expect(JSON.stringify(formatted)).not.toContain(MARKER);
  });

  it('formats them for a moderator', async () => {
    const formatted = await formatGenerationResponse2([workflow()], { id: 1, isModerator: true });
    expect(JSON.stringify(formatted)).toContain(MARKER);
  });
});

describe('getWorkflowStatusUpdate — a training run’s weights', () => {
  beforeEach(() => mockGetWorkflow.mockReset().mockResolvedValue(workflowWithPreparation()));

  it('names none of them to a non-moderator', async () => {
    const update = await getWorkflowStatusUpdate({
      token: 't',
      workflowId: 'wf-1',
      isModerator: false,
    });
    expect(JSON.stringify(update)).not.toContain(MARKER);
  });

  it('names them to a moderator', async () => {
    const update = await getWorkflowStatusUpdate({
      token: 't',
      workflowId: 'wf-1',
      isModerator: true,
    });
    expect(JSON.stringify(update)).toContain(MARKER);
  });
});

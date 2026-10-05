import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModelService from '~/server/services/model.service';
import type * as Workflows from '~/server/services/orchestrator/workflows';
import type * as Caches from '~/server/redis/caches';

/**
 * Publishing a model that was materialized from a training workflow re-checks that run's
 * training-data moderation status. Only the orchestrator read and the publish write are faked;
 * the gate itself (`assertWorkflowPublishable` → `assertTrainingModerationApproved`) runs for real.
 */

const { mockPublishModelById, mockGetToken, mockGetWorkflow, mockUpdateWorkflow } = vi.hoisted(
  () => ({
    mockPublishModelById: vi.fn(),
    mockGetToken: vi.fn(),
    mockGetWorkflow: vi.fn(),
    mockUpdateWorkflow: vi.fn(),
  })
);

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  publishModelById: mockPublishModelById,
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: mockGetToken,
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof Workflows>()),
  getWorkflow: mockGetWorkflow,
  updateWorkflow: mockUpdateWorkflow,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: { refresh: vi.fn() },
}));
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn() },
}));

import type { Workflow } from '@civitai/client';
import { TRPCError } from '@trpc/server';
import { publishModelHandler } from '~/server/controllers/model.controller';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_ID = 42;
const OWNER_ID = 7;

function trainingRun(moderationStatus: string | undefined): Workflow {
  return {
    id: 'wf-1',
    steps: [
      {
        $type: 'training',
        output: {
          ...(moderationStatus !== undefined && { moderationStatus }),
          epochs: [{ epochNumber: 1, model: { url: 'https://blobs/epoch-1', available: true } }],
        },
      },
    ],
  } as unknown as Workflow;
}

const publish = () =>
  publishModelHandler({
    input: { id: MODEL_ID, versionIds: [] },
    ctx: {
      user: { id: OWNER_ID, isModerator: false },
      track: { modelEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.model.findUnique.mockResolvedValue({
    status: 'Draft',
    meta: { trainingStudioWorkflowId: 'wf-1' },
    nsfw: false,
    userId: OWNER_ID,
  } as never);
  mockPublishModelById.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    status: 'Published',
    modelVersions: [{ id: 43 }],
  });
  mockGetToken.mockResolvedValue('owner-token');
  mockUpdateWorkflow.mockResolvedValue({});
});

describe('publishModelHandler — training moderation gate', () => {
  it('publishes a model whose training run is approved', async () => {
    mockGetWorkflow.mockResolvedValue(trainingRun('approved'));
    await expect(publish()).resolves.toMatchObject({ id: MODEL_ID });
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });

  it.each(['evaluating', 'underReview', 'rejected', undefined])(
    'refuses, without publishing, a model whose training run status is %s',
    async (status) => {
      mockGetWorkflow.mockResolvedValue(trainingRun(status));
      await expect(publish()).rejects.toThrow(/dataset has not been approved/);
      expect(mockPublishModelById).not.toHaveBeenCalled();
    }
  );

  it('publishes when the run is past the orchestrator retention window (NOT_FOUND)', async () => {
    mockGetWorkflow.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND', message: 'gone' }));
    await expect(publish()).resolves.toMatchObject({ id: MODEL_ID });
    expect(mockPublishModelById).toHaveBeenCalledTimes(1);
  });

  it('does not read any workflow for a model with no source workflow', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      status: 'Draft',
      meta: null,
      nsfw: false,
      userId: OWNER_ID,
    } as never);
    await expect(publish()).resolves.toMatchObject({ id: MODEL_ID });
    expect(mockGetWorkflow).not.toHaveBeenCalled();
  });
});

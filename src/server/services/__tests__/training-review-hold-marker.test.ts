import { beforeEach, describe, expect, it, vi } from 'vitest';

// Trivial stubs so training.service imports in node. The @aws-sdk stub needs `default` for CJS
// interop; without it the file collects zero tests instead of failing
// (training-status.sysredis-soft.test.ts).
vi.mock('@civitai/orchestration-client', () => ({ handleError: vi.fn() }));
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {};
  return { Upload, default: { Upload } };
});
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/schema/training.schema', () => ({ trainingServiceStatusSchema: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: vi.fn(),
  getB2S3Client: vi.fn(),
  getGetUrl: vi.fn(),
  getPutUrl: vi.fn(),
  getS3Client: vi.fn(),
  isB2Url: vi.fn(),
  parseKey: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: vi.fn(),
}));
// The legacy v1 webhook's imports.
vi.mock('~/env/server', () => ({ env: {} }));
vi.mock('~/server/email/templates', () => ({
  trainingCompleteEmail: { send: vi.fn() },
  trainingFailEmail: { send: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', () => ({ refundTransaction: vi.fn() }));
vi.mock('~/server/signals/wrapper', () => ({ withSignals: vi.fn() }));
vi.mock('~/server/utils/endpoint-helpers', () => ({ WebhookEndpoint: (fn: unknown) => fn }));
vi.mock('~/server/webhooks/training-moderation.webhooks', () => ({
  queueNewTrainingModerationWebhook: vi.fn(),
}));

import { updateTrainingWorkflowRecords } from '~/server/services/training.service';
import { updateRecords } from '~/pages/api/webhooks/resource-training';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { TrainingStatus } from '~/shared/utils/prisma/enums';

/**
 * A moderator can also set Paused by hand, so the stored `heldForReview` marker is the only thing
 * the classic trainer has to tell a review hold from a manual pause when it reads the stored copy.
 */

const MODEL_FILE_ID = 4243;

const workflow = (status: string, moderationStatus?: string) =>
  ({
    id: 'wf-review',
    status,
    createdAt: '2026-11-07T00:00:00.000Z',
    steps: [
      {
        $type: 'training',
        metadata: { modelFileId: MODEL_FILE_ID },
        startedAt: '2026-11-07T00:01:00.000Z',
        input: { samples: { prompts: [] } },
        output: { epochs: [], ...(moderationStatus ? { moderationStatus } : {}) },
      },
    ],
  } as never);

const givenStored = (trainingResults: Record<string, unknown>) =>
  dbMock.dbWrite.modelFile.findFirst.mockResolvedValue({
    id: MODEL_FILE_ID,
    metadata: { trainingResults },
    modelVersion: {
      id: 98,
      name: 'V1',
      model: { id: 6, name: 'Test LoRA', user: { id: 1, email: 'a@b.c', username: 'someone' } },
    },
  });

const writtenResults = () =>
  (
    dbMock.dbWrite.modelFile.update.mock.calls.at(-1)?.[0] as {
      data: { metadata: { trainingResults: { heldForReview?: true } } };
    }
  ).data.metadata.trainingResults;

describe('updateTrainingWorkflowRecords review hold marker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
  });

  it('stores the marker when the workflow holds the run for review', async () => {
    givenStored({ version: 2, epochs: [], history: [] });

    const result = await updateTrainingWorkflowRecords(
      workflow('processing', 'underReview'),
      'processing' as never
    );

    expect(result.trainingStatus).toBe(TrainingStatus.Paused);
    expect(writtenResults().heldForReview).toBe(true);
  });

  it('clears the marker once the hold ends', async () => {
    givenStored({ version: 2, epochs: [], history: [], heldForReview: true });

    await updateTrainingWorkflowRecords(workflow('processing', 'approved'), 'processing' as never);

    expect(writtenResults().heldForReview).toBeUndefined();
  });
});

describe('legacy v1 webhook updateRecords review hold marker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({ id: 98, modelId: 6, name: 'V1' });
    dbMock.dbWrite.model.findFirst.mockResolvedValue(null);
  });

  const update = (status: TrainingStatus, needsReview?: boolean) =>
    updateRecords(
      { modelFileId: MODEL_FILE_ID, needsReview } as never,
      status,
      'Processing',
      'job-1'
    );

  it('stores the marker when the run is paused for review', async () => {
    givenStored({ epochs: [], history: [] });

    await update(TrainingStatus.Paused, true);

    expect(writtenResults().heldForReview).toBe(true);
  });

  it('clears the marker on a later update that is not a pause', async () => {
    givenStored({ epochs: [], history: [], heldForReview: true });

    await update(TrainingStatus.Processing);

    expect(writtenResults().heldForReview).toBeUndefined();
  });
});

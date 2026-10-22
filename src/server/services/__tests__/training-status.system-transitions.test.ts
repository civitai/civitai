import { beforeEach, describe, expect, it, vi } from 'vitest';

// The orchestrator callback and the owner's recheck (both call updateTrainingWorkflowRecords) write
// the run's status without the owner's status rules. Stubs mirror
// training-continued-epoch-numbering.test.ts.
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

import { updateTrainingWorkflowRecords } from '~/server/services/training.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const MODEL_FILE_ID = 4242;
const VERSION_ID = 99;

const workflow = (status: string, moderationStatus?: string) =>
  ({
    id: 'wf-1',
    status,
    createdAt: '2026-10-20T00:00:00.000Z',
    steps: [
      {
        $type: 'training',
        metadata: { modelFileId: MODEL_FILE_ID },
        startedAt: '2026-10-20T00:01:00.000Z',
        input: { samples: { prompts: [] } },
        output: { epochs: [], ...(moderationStatus && { moderationStatus }) },
      },
    ],
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  // The version as stored: its run is processing. Any reader of the stored status sees this.
  const stored = { id: VERSION_ID, trainingStatus: 'Processing', status: 'Draft' };
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue(stored as never);
  dbMock.dbWrite.modelVersion.findFirst.mockResolvedValue(stored as never);
  dbMock.dbWrite.modelFile.findFirst.mockResolvedValue({
    id: MODEL_FILE_ID,
    metadata: {
      trainingResults: { version: 2, epochs: [], history: [{ status: 'Processing' }] },
    },
    modelVersion: {
      id: VERSION_ID,
      name: 'V1',
      model: { id: 7, name: 'Test LoRA', user: { id: 1, email: 'a@b.c', username: 'someone' } },
    },
  });
  dbMock.dbWrite.modelFile.update.mockResolvedValue({});
  dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
});

describe('updateTrainingWorkflowRecords — a started run moves where the run says', () => {
  it.each([
    ['failed', undefined, 'Failed'],
    ['canceled', undefined, 'Failed'],
    ['expired', undefined, 'Expired'],
    ['processing', 'underReview', 'Paused'],
  ])('writes a %s workflow (moderation %s) as %s', async (status, moderationStatus, expected) => {
    const result = await updateTrainingWorkflowRecords(
      workflow(status, moderationStatus),
      status as never
    );

    expect(result.trainingStatus).toBe(expected);
    expect(dbMock.dbWrite.modelVersion.update).toHaveBeenCalledWith({
      where: { id: VERSION_ID },
      data: { trainingStatus: expected },
    });
  });
});

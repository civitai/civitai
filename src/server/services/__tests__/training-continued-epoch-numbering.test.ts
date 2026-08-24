import { beforeEach, describe, expect, it, vi } from 'vitest';

// Trivial stubs so training.service imports in node. The @aws-sdk stub needs `default` for CJS
// interop; without it the file collects zero tests instead of failing
// (training-status.sysredis-soft.test.ts).
vi.mock('@civitai/client', () => ({ handleError: vi.fn() }));
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

const workflowWithEpochs = (epochNumbers: number[]) =>
  ({
    id: 'wf-continued',
    status: 'succeeded',
    createdAt: '2026-08-20T00:00:00.000Z',
    steps: [
      {
        $type: 'training',
        metadata: { modelFileId: MODEL_FILE_ID },
        startedAt: '2026-08-20T00:01:00.000Z',
        completedAt: '2026-08-20T01:00:00.000Z',
        input: { samples: { prompts: [] } },
        output: {
          epochs: epochNumbers.map((n) => ({
            epochNumber: n,
            model: { url: `https://blob/epoch-${n}` },
            samples: [],
          })),
        },
      },
    ],
  } as never);

const givenModelFile = (storedTrainingResults?: Record<string, unknown>) => {
  dbMock.dbWrite.modelFile.findFirst.mockResolvedValue({
    id: MODEL_FILE_ID,
    metadata: storedTrainingResults ? { trainingResults: storedTrainingResults } : {},
    modelVersion: {
      id: 99,
      name: 'V1 (from epoch 10)',
      model: {
        id: 7,
        name: 'Test LoRA',
        user: { id: 1, email: 'a@b.c', username: 'someone' },
      },
    },
  });
};

const resultsFrom = (result: { fileMetadata: { trainingResults?: unknown } }) =>
  result.fileMetadata.trainingResults as {
    epochs: Array<{ epochNumber: number }>;
    epochOffset?: number;
  };

const epochNumbersFrom = (result: Parameters<typeof resultsFrom>[0]) =>
  resultsFrom(result).epochs.map((e) => e.epochNumber);

const ingest = (epochNumbers: number[]) =>
  updateTrainingWorkflowRecords(workflowWithEpochs(epochNumbers), 'succeeded' as never);

describe('updateTrainingWorkflowRecords epoch numbering', () => {
  beforeEach(() => {
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
  });

  it('shifts a continuation by the offset stamped at submit', async () => {
    givenModelFile({ version: 2, epochOffset: 10, epochs: [] });

    expect(epochNumbersFrom(await ingest([1, 2, 3]))).toEqual([11, 12, 13]);
  });

  it('leaves a non-continuation numbered as the orchestrator reported it', async () => {
    givenModelFile({ version: 2, epochOffset: 0, epochs: [] });

    expect(epochNumbersFrom(await ingest([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it('leaves a run with no stored offset unshifted, without marking it', async () => {
    givenModelFile({
      version: 2,
      epochs: [
        { epochNumber: 1, modelUrl: 'https://blob/epoch-1', modelSize: 0, sampleImages: [] },
      ],
    });

    const result = await ingest([1, 2, 3]);

    expect(epochNumbersFrom(result)).toEqual([1, 2, 3]);
    // Writing 0 would read as "deliberately unshifted" and stop a resubmit from stamping one.
    expect(resultsFrom(result).epochOffset).toBeUndefined();
  });

  it('carries the offset forward so repeated ingests are stable', async () => {
    givenModelFile({ version: 2, epochOffset: 10, epochs: [] });

    const first = await ingest([1, 2]);
    expect(resultsFrom(first).epochOffset).toBe(10);

    givenModelFile(resultsFrom(first) as unknown as Record<string, unknown>);
    const second = await ingest([1, 2, 3]);

    expect(resultsFrom(second).epochOffset).toBe(10);
    expect(epochNumbersFrom(second)).toEqual([11, 12, 13]);
  });

  it('keeps the -1 unknown-epoch sentinel unshifted', async () => {
    givenModelFile({ version: 2, epochOffset: 10, epochs: [] });

    expect(epochNumbersFrom(await ingest([-1]))).toEqual([-1]);
  });
});

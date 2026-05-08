import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbWrite,
  mockIsFlipt,
  mockCreateModelFileScanRequest,
  mockModelFileScanSubmissionError,
  mockLogToAxiom,
  mockLimitConcurrency,
} = vi.hoisted(() => {
  // Test-local copy of the real error class so we can construct one in mock
  // rejections without importing the real orchestrator module (which would
  // pull in env validation). The shape only needs to match what scan-files.ts
  // branches on: `instanceof ModelFileScanSubmissionError && code`.
  class MockModelFileScanSubmissionError extends Error {
    constructor(
      message: string,
      public readonly code: 'not-found' | 'transient',
      public readonly status?: number,
      public readonly orchestratorMessages?: string[]
    ) {
      super(message);
      this.name = 'ModelFileScanSubmissionError';
    }
  }
  return {
    mockDbWrite: {
      modelFile: {
        findMany: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      modelFileHash: {
        create: vi.fn(),
      },
    },
    mockIsFlipt: vi.fn(),
    mockCreateModelFileScanRequest: vi.fn(),
    mockModelFileScanSubmissionError: MockModelFileScanSubmissionError,
    mockLogToAxiom: vi.fn(),
    // Run all tasks sequentially so we can assert on their effects deterministically.
    mockLimitConcurrency: vi.fn(async (tasks: Array<() => Promise<unknown>>) => {
      for (const t of tasks) await t();
    }),
  };
});

vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: { MODEL_FILE_SCAN_ORCHESTRATOR: 'model-file-scan-orchestrator' },
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createModelFileScanRequest: mockCreateModelFileScanRequest,
  ModelFileScanSubmissionError: mockModelFileScanSubmissionError,
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: mockLimitConcurrency,
}));

vi.mock('~/utils/delivery-worker', () => ({
  getDownloadUrl: vi.fn().mockResolvedValue({ url: 'https://cdn.example/file' }),
  getDownloadUrlByFileId: vi.fn().mockResolvedValue({ url: 'https://cdn.example/file' }),
  isStorageResolverEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('~/env/server', () => ({
  env: {
    SCANNING_ENDPOINT: 'https://scanner.example',
    SCANNING_TOKEN: 'scan-token',
    NEXTAUTH_URL: 'https://civitai.test',
    WEBHOOK_TOKEN: 'wh-token',
  },
}));

import { scanFilesJob, scanFilesFallbackJob } from '~/server/jobs/scan-files';

const ctx = {} as Parameters<typeof scanFilesJob.run>[0];

// createJob wraps the function so .run() returns { result, cancel }.
// Await `.result` to get the actual return value of the inner async fn.
async function runJob<T extends { run: (ctx: any) => { result: Promise<unknown> } }>(
  job: T
): Promise<unknown> {
  return await job.run(ctx).result;
}

beforeEach(() => {
  // Reset call records but keep mockResolvedValue defaults set above.
  mockDbWrite.modelFile.findMany.mockReset().mockResolvedValue([]);
  mockDbWrite.modelFile.updateMany.mockReset().mockResolvedValue({ count: 0 });
  mockDbWrite.modelFile.update.mockReset().mockResolvedValue({});
  mockDbWrite.modelFileHash.create.mockReset().mockResolvedValue(undefined);
  mockIsFlipt.mockReset();
  mockCreateModelFileScanRequest.mockReset();
  mockLogToAxiom.mockReset().mockResolvedValue(undefined);
  // limitConcurrency stays as our sequential runner — never reset
});

describe('scanFilesJob (legacy gate)', () => {
  it('early-returns without DB calls when MODEL_FILE_SCAN_ORCHESTRATOR is ON', async () => {
    mockIsFlipt.mockResolvedValue(true);

    await runJob(scanFilesJob);

    expect(mockDbWrite.modelFile.findMany).not.toHaveBeenCalled();
    expect(mockDbWrite.modelFile.updateMany).not.toHaveBeenCalled();
  });

  it('runs the legacy poll when flag is OFF', async () => {
    mockIsFlipt.mockResolvedValue(false);
    mockDbWrite.modelFile.findMany.mockResolvedValue([]);

    await runJob(scanFilesJob);

    expect(mockDbWrite.modelFile.findMany).toHaveBeenCalledTimes(1);
  });

  it('queries by virusScanResult=Pending with the 24h-stale cutoff', async () => {
    mockIsFlipt.mockResolvedValue(false);
    mockDbWrite.modelFile.findMany.mockResolvedValue([]);

    await runJob(scanFilesJob);

    const where = mockDbWrite.modelFile.findMany.mock.calls[0][0].where;
    expect(where.virusScanResult).toBe('Pending');
    expect(where.AND).toBeDefined();
  });
});

describe('scanFilesFallbackJob (orchestrator path)', () => {
  it('early-returns when flag is OFF', async () => {
    mockIsFlipt.mockResolvedValue(false);

    const result = await runJob(scanFilesFallbackJob);

    expect(result).toBeUndefined();
    expect(mockDbWrite.modelFile.findMany).not.toHaveBeenCalled();
  });

  it('returns submitted=0 with no DB writes when no pending files', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.modelFile.findMany.mockResolvedValue([]);

    const result = await runJob(scanFilesFallbackJob);

    expect(result).toEqual({ submitted: 0 });
    expect(mockDbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    expect(mockCreateModelFileScanRequest).not.toHaveBeenCalled();
  });

  it('marks the batch as scanRequestedAt=now upfront before per-file submission', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      {
        id: 1,
        modelVersion: { id: 10, baseModel: 'SD 1.5', model: { id: 100, type: 'Checkpoint' } },
      },
      {
        id: 2,
        modelVersion: { id: 20, baseModel: 'SDXL', model: { id: 200, type: 'LORA' } },
      },
    ]);
    mockCreateModelFileScanRequest.mockResolvedValue(undefined);

    await runJob(scanFilesFallbackJob);

    expect(mockDbWrite.modelFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] } },
      data: { scanRequestedAt: expect.any(Date) },
    });
  });

  it('calls createModelFileScanRequest per file with low priority and counts submitted', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      {
        id: 1,
        modelVersion: { id: 10, baseModel: 'SD 1.5', model: { id: 100, type: 'Checkpoint' } },
      },
    ]);
    mockCreateModelFileScanRequest.mockResolvedValue(undefined);

    const result = await runJob(scanFilesFallbackJob);

    expect(mockCreateModelFileScanRequest).toHaveBeenCalledWith({
      fileId: 1,
      modelVersionId: 10,
      modelId: 100,
      modelType: 'Checkpoint',
      baseModel: 'SD 1.5',
      priority: 'low',
    });
    expect(result).toEqual({ submitted: 1, failed: 0 });
  });

  it('skips files with a null modelVersion (soft-deleted) and resets scanRequestedAt', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.modelFile.findMany.mockResolvedValue([{ id: 99, modelVersion: null }]);

    const result = await runJob(scanFilesFallbackJob);

    expect(mockCreateModelFileScanRequest).not.toHaveBeenCalled();
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { scanRequestedAt: null },
    });
    expect(result).toEqual({ submitted: 0, failed: 1 });
  });

  it('on submission failure, resets scanRequestedAt and logs to Axiom', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      {
        id: 5,
        modelVersion: { id: 50, baseModel: 'SD 1.5', model: { id: 500, type: 'Checkpoint' } },
      },
    ]);
    mockCreateModelFileScanRequest.mockRejectedValue(new Error('orchestrator down'));

    const result = await runJob(scanFilesFallbackJob);

    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { scanRequestedAt: null },
    });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'scan-files-fallback',
        error: 'orchestrator down',
      }),
      'webhooks'
    );
    expect(result).toEqual({ submitted: 0, failed: 1 });
  });

  it('on ModelFileScanSubmissionError code=not-found, tombstones via exists=false (no scanRequestedAt reset)', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      {
        id: 7,
        modelVersion: { id: 70, baseModel: 'SD 1.5', model: { id: 700, type: 'Checkpoint' } },
      },
    ]);
    mockCreateModelFileScanRequest.mockRejectedValue(
      new mockModelFileScanSubmissionError(
        'Failed to submit model file scan workflow for file 7 (status 400)',
        'not-found',
        400,
        ['Resource urn:air:... does not exist or is not valid.']
      )
    );

    const result = await runJob(scanFilesFallbackJob);

    // Tombstone fires.
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: { exists: false },
    });
    // And the scanRequestedAt-reset path does NOT fire — the file exits the
    // scan poll permanently via the WHERE-clause `exists` filter.
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalledWith({
      where: { id: 7 },
      data: { scanRequestedAt: null },
    });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionErrorCode: 'not-found',
        tombstoned: true,
      }),
      'webhooks'
    );
    expect(result).toEqual({ submitted: 0, failed: 1 });
  });

  it('on ModelFileScanSubmissionError code=transient, resets scanRequestedAt (no tombstone)', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      {
        id: 8,
        modelVersion: { id: 80, baseModel: 'SDXL', model: { id: 800, type: 'LORA' } },
      },
    ]);
    mockCreateModelFileScanRequest.mockRejectedValue(
      new mockModelFileScanSubmissionError(
        'Failed to submit model file scan workflow for file 8 (status 503)',
        'transient',
        503
      )
    );

    const result = await runJob(scanFilesFallbackJob);

    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { scanRequestedAt: null },
    });
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalledWith({
      where: { id: 8 },
      data: { exists: false },
    });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionErrorCode: 'transient',
        tombstoned: false,
      }),
      'webhooks'
    );
    expect(result).toEqual({ submitted: 0, failed: 1 });
  });

  it('processes mixed batches: counts per-file successes and failures correctly', async () => {
    mockIsFlipt.mockResolvedValue(true);
    mockDbWrite.modelFile.findMany.mockResolvedValue([
      {
        id: 1,
        modelVersion: { id: 10, baseModel: 'SD 1.5', model: { id: 100, type: 'Checkpoint' } },
      },
      { id: 2, modelVersion: null }, // soft-deleted
      {
        id: 3,
        modelVersion: { id: 30, baseModel: 'SDXL', model: { id: 300, type: 'LORA' } },
      },
    ]);
    mockCreateModelFileScanRequest
      .mockResolvedValueOnce(undefined) // file 1 ok
      .mockRejectedValueOnce(new Error('orchestrator')); // file 3 fail

    const result = await runJob(scanFilesFallbackJob);

    expect(result).toEqual({ submitted: 1, failed: 2 });
  });
});

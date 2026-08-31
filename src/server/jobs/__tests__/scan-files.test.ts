import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockCreateModelFileScanRequest, mockModelFileScanSubmissionError, mockLimitConcurrency } =
  vi.hoisted(() => {
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
      mockCreateModelFileScanRequest: vi.fn(),
      mockModelFileScanSubmissionError: MockModelFileScanSubmissionError,
      // Run all tasks sequentially so we can assert on their effects deterministically.
      mockLimitConcurrency: vi.fn(async (tasks: Array<() => Promise<unknown>>) => {
        for (const t of tasks) await t();
      }),
    };
  });

vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createModelFileScanRequest: mockCreateModelFileScanRequest,
  ModelFileScanSubmissionError: mockModelFileScanSubmissionError,
}));

vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: mockLimitConcurrency,
}));

import { scanFilesFallbackJob } from '~/server/jobs/scan-files';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbWrite = dbMock.dbWrite;
const mockLogToAxiom = loggingMock.logToAxiom;

const ctx = {} as Parameters<typeof scanFilesFallbackJob.run>[0];

// Fixed clock so the backoff timestamp can be pinned as a LITERAL rather than
// recomputed with the same dayjs expression the implementation uses.
// Deliberately not on a round minute/second: the expected backoff instant must
// not coincide with `now`, with `now - 1 day`, or with any round value a
// hardcoding mutant might produce.
const FIXED_NOW = new Date('2026-03-05T12:07:13.000Z');

// FIXED_NOW - 1 day + 30 min. Written out literally, NOT derived from dayjs.
const EXPECTED_BACKOFF_AT = new Date('2026-03-04T12:37:13.000Z');

// Distinct from the 180s budget and from the 300s job lock, and strictly
// between them: a mutant that confuses the budget with `lockExpiration` fails
// to skip at this elapsed time, so it dies rather than surviving.
const PAST_BUDGET_MS = 240_000;

// createJob wraps the function so .run() returns { result, cancel }.
// Await `.result` to get the actual return value of the inner async fn.
async function runJob<T extends { run: (ctx: any) => { result: Promise<unknown> } }>(
  job: T
): Promise<unknown> {
  return await job.run(ctx).result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  // Reset call records but keep mockResolvedValue defaults set above.
  mockDbWrite.modelFile.findMany.mockReset().mockResolvedValue([]);
  mockDbWrite.modelFile.updateMany.mockReset().mockResolvedValue({ count: 0 });
  mockDbWrite.modelFile.update.mockReset().mockResolvedValue({});
  mockDbWrite.modelFileHash.create.mockReset().mockResolvedValue(undefined);
  mockCreateModelFileScanRequest.mockReset();
  mockLogToAxiom.mockReset().mockResolvedValue(undefined);
  // limitConcurrency stays as our sequential runner — never reset
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scanFilesFallbackJob', () => {
  it('returns submitted=0 with no DB writes when no pending files', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue([]);

    const result = await runJob(scanFilesFallbackJob);

    expect(result).toEqual({ submitted: 0 });
    expect(mockDbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    expect(mockCreateModelFileScanRequest).not.toHaveBeenCalled();
  });

  it('marks the batch as scanRequestedAt=now upfront before per-file submission', async () => {
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
    expect(result).toEqual({ submitted: 1, failed: 0, skipped: 0 });
  });

  it('backs off files with a null modelVersion (soft-deleted) instead of resetting them', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue([{ id: 99, modelVersion: null }]);

    const result = await runJob(scanFilesFallbackJob);

    expect(mockCreateModelFileScanRequest).not.toHaveBeenCalled();
    // A soft-deleted ModelVersion never starts resolving again, so a null reset
    // would re-pick this file every 5 minutes forever.
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { scanRequestedAt: EXPECTED_BACKOFF_AT },
    });
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalledWith({
      where: { id: 99 },
      data: { scanRequestedAt: null },
    });
    expect(result).toEqual({ submitted: 0, failed: 1, skipped: 0 });
  });

  it('on submission failure, backs off scanRequestedAt and logs to Axiom', async () => {
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
      data: { scanRequestedAt: EXPECTED_BACKOFF_AT },
    });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'scan-files-fallback',
        error: 'orchestrator down',
      }),
      'webhooks'
    );
    expect(result).toEqual({ submitted: 0, failed: 1, skipped: 0 });
  });

  it('on ModelFileScanSubmissionError code=not-found, tombstones via exists=false (no scanRequestedAt reset)', async () => {
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
    // And neither retry path fires — the file exits the scan poll permanently
    // via the WHERE-clause `exists` filter.
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalledWith({
      where: { id: 7 },
      data: { scanRequestedAt: null },
    });
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalledWith({
      where: { id: 7 },
      data: { scanRequestedAt: EXPECTED_BACKOFF_AT },
    });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        submissionErrorCode: 'not-found',
        tombstoned: true,
      }),
      'webhooks'
    );
    expect(result).toEqual({ submitted: 0, failed: 1, skipped: 0 });
  });

  it('on ModelFileScanSubmissionError code=transient, backs off scanRequestedAt (no tombstone)', async () => {
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
      data: { scanRequestedAt: EXPECTED_BACKOFF_AT },
    });
    // Not `null` (retried every 5 min) and not `now` (hidden for 24h).
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalledWith({
      where: { id: 8 },
      data: { scanRequestedAt: null },
    });
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalledWith({
      where: { id: 8 },
      data: { scanRequestedAt: FIXED_NOW },
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
    expect(result).toEqual({ submitted: 0, failed: 1, skipped: 0 });
  });

  it('processes mixed batches: counts per-file successes and failures correctly', async () => {
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

    expect(result).toEqual({ submitted: 1, failed: 2, skipped: 0 });
  });
});

describe('scanFilesFallbackJob fairness ordering', () => {
  it('sorts unattempted files first, then oldest id, as one total order', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue([]);

    await runJob(scanFilesFallbackJob);

    // ONE assertion deliberately, on the whole array literal. Array deep
    // equality pins length, element order and element identity at once, so this
    // single expectation covers every way the sort can be wrong:
    //
    //  - `nulls: 'first'` replaced or dropped. Load-bearing: Postgres orders ASC
    //    with NULLS LAST by default, so the bare `'asc'` string sorts
    //    unattempted files LAST — the exact inverse of what fairness needs.
    //  - `sort` flipped to 'desc'.
    //  - the `{ id: 'asc' }` tiebreaker removed, reversed, or moved to another
    //    column. It is what makes the order TOTAL: sorting on the nullable
    //    column alone leaves big ties (every NULL ties with every other NULL,
    //    and the upfront updateMany stamps one identical timestamp across the
    //    whole batch) that Postgres may break arbitrarily and differently on
    //    each run.
    //  - the array collapsed to a bare object.
    //
    // 🔴 Earlier revisions of this file split those into extra tests that
    // re-checked pieces of this same literal. They contributed no unique kill,
    // and adding the tiebreaker silently made one of them VACUOUS: it asserted
    // `orderBy` was not the one-element bare form, which a two-element array can
    // never equal regardless of what is inside it. A test that reads as coverage
    // while providing none is worse than no test, so they are gone rather than
    // left to reassure the next reader.
    expect(mockDbWrite.modelFile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ scanRequestedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      })
    );
  });
});

describe('scanFilesFallbackJob per-run budget', () => {
  // Two files; the first submission burns PAST_BUDGET_MS of wall clock, so the
  // second must be refused admission rather than started.
  const twoFiles = [
    {
      id: 1,
      modelVersion: { id: 10, baseModel: 'SD 1.5', model: { id: 100, type: 'Checkpoint' } },
    },
    {
      id: 2,
      modelVersion: { id: 20, baseModel: 'SDXL', model: { id: 200, type: 'LORA' } },
    },
  ];

  it('stops starting new submissions once the run budget is spent', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue(twoFiles);
    mockCreateModelFileScanRequest.mockImplementation(async () => {
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + PAST_BUDGET_MS));
    });

    const result = await runJob(scanFilesFallbackJob);

    // File 1 was admitted; file 2 was not even attempted.
    expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateModelFileScanRequest).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 1 })
    );
    expect(mockCreateModelFileScanRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 2 })
    );
    expect(result).toEqual({ submitted: 1, failed: 0, skipped: 1 });
  });

  it('releases a budget-skipped file with scanRequestedAt=null, not the retry backoff', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue(twoFiles);
    mockCreateModelFileScanRequest.mockImplementation(async () => {
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + PAST_BUDGET_MS));
    });

    await runJob(scanFilesFallbackJob);

    // It was never attempted, so it must be immediately eligible again — the
    // backoff is for files that were tried and failed. The upfront updateMany
    // already stamped it, so without this reset it hides for the 24h window.
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { scanRequestedAt: null },
    });
    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalledWith({
      where: { id: 2 },
      data: { scanRequestedAt: EXPECTED_BACKOFF_AT },
    });
  });

  // 🔴 Boundary pair. These two are what pin the budget's VALUE behaviourally.
  // Without them the constant is only pinned by the `runBudgetMs` field in the
  // Axiom payload — an observability field, and itself hardcodable — so the
  // budget could be anything under the test's overshoot and still run green.
  // The literals are written out rather than derived from the constant, so
  // moving the constant in either direction fails one of these.
  it('still submits at one millisecond under the budget', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue(twoFiles);
    mockCreateModelFileScanRequest.mockImplementation(async () => {
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 179_999));
    });

    const result = await runJob(scanFilesFallbackJob);

    expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ submitted: 2, failed: 0, skipped: 0 });
  });

  it('still submits at exactly the budget (the bound is exclusive)', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue(twoFiles);
    mockCreateModelFileScanRequest.mockImplementation(async () => {
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 180_000));
    });

    const result = await runJob(scanFilesFallbackJob);

    // Pins `>` rather than `>=`. Without this the two differ only at this exact
    // millisecond, which no other test visits, so flipping the operator is
    // otherwise invisible.
    expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ submitted: 2, failed: 0, skipped: 0 });
  });

  it('skips at one millisecond over the budget', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue(twoFiles);
    mockCreateModelFileScanRequest.mockImplementation(async () => {
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 180_001));
    });

    const result = await runJob(scanFilesFallbackJob);

    expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ submitted: 1, failed: 0, skipped: 1 });
  });

  it('counts time spent in the batch query against the budget', async () => {
    // 🔴 This pins WHERE the run clock starts, which is the whole point of
    // moving `runStartedAt` above the batch query. The job lock is already
    // running during the select and the upfront stamp, so that time has to
    // count; if the clock started afterwards, two DB round-trips would fall
    // outside the bound and quietly overspend it.
    //
    // Observable precisely because the query is a mock: advancing the clock
    // INSIDE it makes the query itself consume the entire budget. With the
    // clock started before the query, nothing may be admitted; with it started
    // after, elapsed time reads as 0 and everything is admitted.
    mockDbWrite.modelFile.findMany.mockImplementation(async () => {
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 180_001));
      return twoFiles;
    });

    const result = await runJob(scanFilesFallbackJob);

    expect(mockCreateModelFileScanRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ submitted: 0, failed: 0, skipped: 2 });
  });

  it('does not skip when the run stays inside the budget', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue(twoFiles);
    // Well inside 180s, and a different magnitude from PAST_BUDGET_MS.
    mockCreateModelFileScanRequest.mockImplementation(async () => {
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 1_000));
    });

    const result = await runJob(scanFilesFallbackJob);

    expect(mockCreateModelFileScanRequest).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ submitted: 2, failed: 0, skipped: 0 });
  });

  // 🔴 Run TWO cases in which EVERY asserted count differs. One case is not
  // enough: with a single fixture the asserted `batchSize` equals that fixture's
  // own length, so a mutant hardcoding the literal survives — and simply picking
  // a bigger single fixture just relocates the coincidence instead of removing
  // it. But varying only the SIZE is also not enough: it pins `batchSize` and
  // `skipped` while leaving `submitted` and `failed` identical across cases, so
  // hardcoding either of those still survives. (Measured — both did.) So the
  // second case also fails its one attempted submission, which moves
  // submitted 1→0 and failed 0→1. Across the pair every field takes two
  // different values, so no constant satisfies both, and within each case all
  // four counts are mutually distinct so no field can be satisfied by another
  // field's value.
  //
  // This payload is the only signal that the queue is oversubscribed — the whole
  // motivation for the bound — so a lie in it is not cosmetic.
  it.each([
    { size: 5, firstAttemptFails: false, submitted: 1, failed: 0, skipped: 4 },
    { size: 3, firstAttemptFails: true, submitted: 0, failed: 1, skipped: 2 },
  ])(
    'reports the truncated run to Axiom so the bound is observable (batch $size, failing=$firstAttemptFails)',
    async ({ size, firstAttemptFails, submitted, failed, skipped }) => {
      mockDbWrite.modelFile.findMany.mockResolvedValue(
        Array.from({ length: size }, (_, i) => ({
          id: i + 1,
          modelVersion: {
            id: (i + 1) * 10,
            baseModel: 'SD 1.5',
            model: { id: (i + 1) * 100, type: 'Checkpoint' },
          },
        }))
      );
      // Burn the budget on the first attempt either way; only its OUTCOME
      // differs between the two cases.
      mockCreateModelFileScanRequest.mockImplementation(async () => {
        vi.setSystemTime(new Date(FIXED_NOW.getTime() + PAST_BUDGET_MS));
        if (firstAttemptFails) throw new Error('orchestrator down');
      });

      await runJob(scanFilesFallbackJob);

      expect(mockLogToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'warning',
          name: 'scan-files-fallback',
          submitted,
          failed,
          skipped,
          batchSize: size,
          runBudgetMs: 180_000,
        }),
        'webhooks'
      );
    }
  );

  it('emits no budget warning on a run that skips nothing', async () => {
    mockDbWrite.modelFile.findMany.mockResolvedValue(twoFiles);
    mockCreateModelFileScanRequest.mockResolvedValue(undefined);

    await runJob(scanFilesFallbackJob);

    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite, mockDeregisterBatch, mockLogToAxiom, calls } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
  mockDeregisterBatch: vi.fn(() => Promise.resolve({ deleted: 0 })),
  // Tracked so we can assert the per-batch error path fired (the job's internal
  // errorCount has no external surface other than this Axiom error log).
  mockLogToAxiom: vi.fn(),
  // Ordered log of the side effects we care about, so we can assert the
  // versionId collection happens BEFORE the delete and deregister happens AFTER.
  calls: [] as string[],
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: mockDeregisterBatch }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { removeOldDrafts } from '~/server/jobs/remove-old-drafts';

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
});

describe('removeOldDrafts', () => {
  it('collects version ids pre-delete then deregisters them post-delete', async () => {
    // Replica lookup: one old draft model (id 42).
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 42 }]);
    // dbWrite.$queryRaw = the pre-delete version-id lookup.
    mockDbWrite.$queryRaw.mockImplementation(async () => {
      calls.push('collect-versions');
      return [{ id: 100 }, { id: 101 }];
    });
    // dbWrite.$executeRaw = the cascade delete.
    mockDbWrite.$executeRaw.mockImplementation(async () => {
      calls.push('delete');
      return 1;
    });
    mockDeregisterBatch.mockImplementation(async () => {
      calls.push('deregister');
      return { deleted: 2 };
    });

    await (removeOldDrafts as unknown as () => Promise<void>)();

    // versionIds gathered before the delete, deregister runs after it.
    expect(calls).toEqual(['collect-versions', 'delete', 'deregister']);
    expect(mockDeregisterBatch).toHaveBeenCalledWith([100, 101]);
  });

  it('does not call deregister when a batch has no versions', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([{ id: 42 }]);
    mockDbWrite.$queryRaw.mockResolvedValue([]); // no versions on the model
    mockDbWrite.$executeRaw.mockResolvedValue(1);

    await (removeOldDrafts as unknown as () => Promise<void>)();

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockDeregisterBatch).not.toHaveBeenCalled();
  });

  it('does nothing when there are no old drafts to remove', async () => {
    mockDbRead.$queryRaw.mockResolvedValue([]);

    await (removeOldDrafts as unknown as () => Promise<void>)();

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(mockDeregisterBatch).not.toHaveBeenCalled();
  });

  it('does not deregister a batch whose delete fails, counts the error, and continues', async () => {
    // 11 models → two batches (BATCH_SIZE=10): [1..10] then [11].
    const modelIds = Array.from({ length: 11 }, (_, i) => i + 1);
    mockDbRead.$queryRaw.mockResolvedValue(modelIds.map((id) => ({ id })));

    // Per-batch version lookup — return ids keyed off which batch is asked for.
    mockDbWrite.$queryRaw.mockImplementation(async (_strings: unknown, batch: number[]) =>
      batch.includes(1) ? [{ id: 100 }, { id: 101 }] : [{ id: 200 }]
    );
    // The DELETE FROM "Model" rejects for the FIRST batch only; the second succeeds.
    mockDbWrite.$executeRaw.mockImplementation(async (_strings: unknown, batch: number[]) => {
      if (batch.includes(1)) throw new Error('deadlock detected');
      return 1;
    });

    // Job must not throw out — a failed batch is caught and the loop continues.
    await expect(
      (removeOldDrafts as unknown as () => Promise<void>)()
    ).resolves.toBeUndefined();

    // The failed batch's versions ([100, 101]) are NEVER deregistered — the delete
    // never committed, so there are no orphaned file_locations to reap.
    expect(mockDeregisterBatch).toHaveBeenCalledTimes(1);
    expect(mockDeregisterBatch).toHaveBeenCalledWith([200]);
    expect(mockDeregisterBatch).not.toHaveBeenCalledWith([100, 101]);

    // errorCount increments → surfaced as the batch-failure Axiom error log.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'remove-old-drafts',
        message: 'Failed to remove batch of old draft models',
      })
    );
  });

  it('scopes each batch to its own version ids with no cross-batch bleed', async () => {
    // 11 models → two batches (BATCH_SIZE=10): [1..10] then [11].
    const modelIds = Array.from({ length: 11 }, (_, i) => i + 1);
    mockDbRead.$queryRaw.mockResolvedValue(modelIds.map((id) => ({ id })));

    // Each batch's ModelVersion SELECT returns a disjoint set of version ids.
    mockDbWrite.$queryRaw.mockImplementation(async (_strings: unknown, batch: number[]) =>
      batch.includes(1) ? [{ id: 1000 }, { id: 1001 }] : [{ id: 2000 }]
    );
    mockDbWrite.$executeRaw.mockResolvedValue(1);

    await (removeOldDrafts as unknown as () => Promise<void>)();

    // The version SELECT is scoped to exactly one batch of model ids per call.
    const selectBatches = mockDbWrite.$queryRaw.mock.calls.map((c) => c[1] as number[]);
    expect(selectBatches).toEqual([
      Array.from({ length: 10 }, (_, i) => i + 1),
      [11],
    ]);

    // Deregister runs once per batch, each with only that batch's version ids —
    // no cross-batch bleed (batch 1's [1000,1001] and batch 2's [2000] never mix).
    expect(mockDeregisterBatch).toHaveBeenCalledTimes(2);
    expect(mockDeregisterBatch).toHaveBeenNthCalledWith(1, [1000, 1001]);
    expect(mockDeregisterBatch).toHaveBeenNthCalledWith(2, [2000]);
  });
});

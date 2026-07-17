import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite, mockDeregisterBatch, calls } = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
  mockDeregisterBatch: vi.fn(() => Promise.resolve({ deleted: 0 })),
  // Ordered log of the side effects we care about, so we can assert the
  // versionId collection happens BEFORE the delete and deregister happens AFTER.
  calls: [] as string[],
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: mockDeregisterBatch }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: () => undefined }));
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
});

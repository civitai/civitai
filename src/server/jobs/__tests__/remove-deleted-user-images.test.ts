import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite, mockDeleteImages, mockLogToAxiom, mockSysRedis } = vi.hoisted(
  () => ({
    mockDbRead: { $queryRaw: vi.fn() },
    mockDbWrite: { $executeRaw: vi.fn() },
    mockDeleteImages: vi.fn(),
    mockLogToAxiom: vi.fn(),
    mockSysRedis: { get: vi.fn() },
  })
);

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({ deleteImages: mockDeleteImages }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { SYSTEM: { DELETED_USER_IMAGE_PURGE_LIMIT: 'k' } },
}));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { removeDeletedUserImages } from '~/server/jobs/remove-deleted-user-images';

const run = () =>
  (removeDeletedUserImages as unknown as (ctx: { checkIfCanceled: () => void }) => Promise<any>)({
    checkIfCanceled: () => undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockSysRedis.get.mockResolvedValue(null);
  mockDbWrite.$executeRaw.mockResolvedValue(1);
});

describe('removeDeletedUserImages', () => {
  it('deletes a deleted user images in batches of 100 and then removes their posts', async () => {
    // First $queryRaw = user worklist. Second = that user's image ids (150 of them).
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce(Array.from({ length: 150 }, (_, i) => ({ id: i + 1 })));
    mockDeleteImages.mockImplementation(async (ids: number[]) => ids.map((id) => ({ id })));

    const result = await run();

    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(mockDeleteImages.mock.calls[0][0]).toHaveLength(100);
    expect(mockDeleteImages.mock.calls[1][0]).toHaveLength(50);
    // Fewer rows returned than the requested budget => user is drained => posts go.
    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(result.deletedImages).toBe(150);
    expect(result.deletedUsers).toBe(1);
  });

  it('does not delete posts when the user still has images left', async () => {
    // Image lookup returns exactly the budget => more may remain => posts must stay.
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce(Array.from({ length: 25000 }, (_, i) => ({ id: i + 1 })));
    mockDeleteImages.mockImplementation(async (ids: number[]) => ids.map((id) => ({ id })));

    await run();

    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('does nothing when no deleted users own images', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([]);

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(result.deletedImages).toBe(0);
  });

  it('keeps going when one user fails, and logs the failure', async () => {
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ id: 7 }, { id: 8 }])
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 2 }]);
    mockDeleteImages
      .mockRejectedValueOnce(new Error('s3 exploded'))
      .mockResolvedValueOnce([{ id: 2 }]);

    const result = await run();

    // User 8 still processed after user 7 threw.
    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(result.deletedImages).toBe(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'remove-deleted-user-images' })
    );
  });
});

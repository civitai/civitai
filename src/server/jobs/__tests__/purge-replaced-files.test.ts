import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbWrite, mockDeleteObj } = vi.hoisted(() => ({
  mockDbWrite: { modelFile: { update: vi.fn() } },
  mockDeleteObj: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: mockDeleteObj }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: () => ({ catch: () => {} }) }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { processReplacedFiles } from '~/server/jobs/purge-replaced-files';

beforeEach(() => vi.clearAllMocks());

describe('processReplacedFiles', () => {
  it('purges S3 (refcount-guarded) then marks dataPurged for each row', async () => {
    const res = await processReplacedFiles([{ id: 1, url: 'https://bucket/a' }]);
    expect(mockDeleteObj).toHaveBeenCalledWith('https://bucket/a', 1);
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { dataPurged: true },
    });
    expect(res).toEqual({ purged: 1, failed: 0 });
  });

  it('counts a failure and continues to the next row', async () => {
    mockDeleteObj.mockRejectedValueOnce(new Error('boom'));
    const res = await processReplacedFiles([
      { id: 1, url: 'u1' },
      { id: 2, url: 'u2' },
    ]);
    expect(res).toEqual({ purged: 1, failed: 1 });
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledTimes(1);
  });
});

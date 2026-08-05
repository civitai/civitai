import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbWrite, mockDeleteObj } = vi.hoisted(() => ({
  mockDbWrite: { modelFile: { update: vi.fn() } },
  mockDeleteObj: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({ dbWrite: mockDbWrite }));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: mockDeleteObj }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: () => ({ catch: () => {} }) }));
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { buildReplacedFilesQuery, processReplacedFiles } from '~/server/jobs/purge-replaced-files';

beforeEach(() => vi.clearAllMocks());

describe('buildReplacedFilesQuery', () => {
  // Bound as a parameter the day count arrives as int8 and make_interval only takes
  // int4, so the query fails to resolve the function (42883) on every run.
  it('inlines the grace period rather than binding it', () => {
    const query = buildReplacedFilesQuery();
    expect(query.sql).toContain('make_interval(days => 30)');
    expect(query.values).toEqual([]);
  });

  it('skips rows already purged', () => {
    expect(buildReplacedFilesQuery().sql).toContain('"dataPurged" IS NOT TRUE');
  });
});

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

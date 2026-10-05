import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDeleteObj } = vi.hoisted(() => ({
  mockDeleteObj: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: mockDeleteObj }));
// 🔴 THE DEFAULT MUST BE AN EXPLICIT OUTCOME, AND THE REASON IS THE DEFECT THIS FILE NOW COVERS.
// `deleteModelFileObject` used to return nothing, so a bare `vi.fn()` was a faithful stand-in.
// Now a missing return reads as `deleted: undefined` — a SKIP — which would silently turn the
// success cases below into skip cases and pass a green suite over a job that purges nothing.
// Every case states the outcome it means.
const DELETED = { deleted: true } as const;
vi.mock('~/server/jobs/job', () => ({ createJob: (_n: string, _c: string, fn: unknown) => fn }));

import { buildReplacedFilesQuery, processReplacedFiles } from '~/server/jobs/purge-replaced-files';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
loggingMock.logToAxiom.mockImplementation(() => ({ catch: () => {} }));
const mockDbWrite = dbMock.dbWrite;

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
  beforeEach(() => mockDeleteObj.mockResolvedValue(DELETED));

  it('purges S3 (refcount-guarded) then marks dataPurged for each row', async () => {
    const res = await processReplacedFiles([{ id: 1, url: 'https://bucket/a' }]);
    expect(mockDeleteObj).toHaveBeenCalledWith('https://bucket/a', 1);
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { dataPurged: true },
    });
    expect(res).toEqual({ purged: 1, failed: 0, skipped: 0 });
  });

  it('counts a failure and continues to the next row', async () => {
    mockDeleteObj.mockRejectedValueOnce(new Error('boom'));
    const res = await processReplacedFiles([
      { id: 1, url: 'u1' },
      { id: 2, url: 'u2' },
    ]);
    expect(res).toEqual({ purged: 1, failed: 1, skipped: 0 });
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledTimes(1);
  });

  it('🔴 does NOT mark dataPurged when the helper reports a SKIP', async () => {
    // The defect this closes: a skip and a success were indistinguishable to this caller, because
    // both merely "did not throw". Marking a skipped row purged drops it out of the query
    // permanently while the object is still in the bucket — a durable lie, and strictly worse
    // than the thrown error it replaces, which at least leaves the row to be retried.
    mockDeleteObj.mockResolvedValueOnce({ deleted: false, reason: 'still-referenced' });

    const res = await processReplacedFiles([{ id: 7, url: 'u7' }]);

    expect(mockDbWrite.modelFile.update).not.toHaveBeenCalled();
    // A skip is not a failure either — the refcount guard declining is it working as designed.
    expect(res).toEqual({ purged: 0, failed: 0, skipped: 1 });
  });

  it('counts a skip separately from a delete across a mixed batch', async () => {
    mockDeleteObj
      .mockResolvedValueOnce({ deleted: false, reason: 'bucket-not-allowed' })
      .mockResolvedValueOnce(DELETED);

    const res = await processReplacedFiles([
      { id: 1, url: 'u1' },
      { id: 2, url: 'u2' },
    ]);

    expect(res).toEqual({ purged: 1, failed: 0, skipped: 1 });
    // Only the deleted row is marked — the identity matters, not just the count.
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledTimes(1);
    expect(mockDbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { dataPurged: true },
    });
  });
});

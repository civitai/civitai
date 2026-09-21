import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What `delete-old-training-data` does with each row it selects.
 *
 * THE DEFECT THIS PINS. The loop called a bare `deleteObject(bucket, key)` built from
 * `parseKey(url)`. `parseKey` resolves a path-style url's bucket correctly, but the bare call
 * then sends it to the DEFAULT S3 client — so for every file living on the other backend the
 * delete went to a client where that bucket does not exist and threw. Measured in production
 * before the fix: one distinct error across the sampled failures, `The specified bucket does not
 * exist.`, naming a bucket that is real on the other backend. Nothing was ever purged from it,
 * and because a failed row never gets `dataPurged`, every run re-attempted the same set forever.
 *
 * THE SECOND DEFECT, which the fix for the first would otherwise have introduced.
 * `deleteModelFileObject` declines in several cases — the refcount guard, a non-allowlisted
 * bucket, an unparseable url — and it declines WITHOUT THROWING. This loop marks `dataPurged`
 * on anything that does not throw, so swapping the call in naively would have recorded a
 * deletion that never happened, dropping the row out of the query permanently while the object
 * remained. That is strictly worse than the error it replaces: an error leaves the row to be
 * retried, a false `dataPurged` does not.
 *
 * So the cases below pin both directions — that a delete is routed through the helper WITH the
 * exclude-id, and that only a reported delete marks the row.
 */

const { mockDeleteModelFileObject } = vi.hoisted(() => ({
  mockDeleteModelFileObject: vi.fn(),
}));

vi.mock('~/utils/s3-utils', () => ({
  deleteModelFileObject: mockDeleteModelFileObject,
}));

import { deleteOldTrainingData } from '~/server/jobs/delete-old-training-data';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const dbWrite = dbMock.dbWrite;

/** Shaped like the job's own `OldTrainingRow`. Ids and urls are invented. */
const row = (mf_id: number, url = `https://example.invalid/bucket/key-${mf_id}`) => ({
  mf_id,
  job_id: `job-${mf_id}`,
  url,
});

const DELETED = { deleted: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  loggingMock.logToAxiom.mockImplementation(() => ({ catch: () => undefined }));
  // 🔴 An explicit default, because a bare `vi.fn()` resolves to `undefined` and
  // `undefined.deleted` is falsy — i.e. every case would silently become a SKIP case and a
  // green suite would say nothing about the purge path.
  mockDeleteModelFileObject.mockResolvedValue(DELETED);
});

describe('delete-old-training-data routes its deletes through the ModelFile helper', () => {
  it('🔴 calls deleteModelFileObject with the url AND the row id as excludeId', async () => {
    dbWrite.$queryRaw.mockResolvedValueOnce([row(101)]);

    await deleteOldTrainingData.run({}).result;

    // The url alone is not enough. This job KEEPS its row and only sets `dataPurged`, so
    // without its own id excluded the refcount guard inside the helper finds the row as a live
    // reference to its own url and vetoes the delete — forever, and without an error. Passing
    // one argument satisfies the call but reinstates that, which is why the id is asserted.
    expect(mockDeleteModelFileObject).toHaveBeenCalledWith(
      'https://example.invalid/bucket/key-101',
      101
    );
  });

  it('marks dataPurged only after the helper reports an actual delete', async () => {
    dbWrite.$queryRaw.mockResolvedValueOnce([row(102)]);

    await deleteOldTrainingData.run({}).result;

    expect(dbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 102 },
      data: { dataPurged: true },
    });
  });
});

describe('a SKIP must not be recorded as a purge', () => {
  it.each([['still-referenced'], ['bucket-not-allowed'], ['unparseable'], ['empty-url']] as const)(
    '%s leaves the row unmarked',
    async (reason) => {
      // Every one of these means the object is STILL THERE. Marking the row purged would remove
      // it from this job's query permanently while the bytes remain.
      mockDeleteModelFileObject.mockResolvedValueOnce({ deleted: false, reason });
      dbWrite.$queryRaw.mockResolvedValueOnce([row(103)]);

      await deleteOldTrainingData.run({}).result;

      expect(dbWrite.modelFile.update).not.toHaveBeenCalled();
    }
  );

  it('a skip does not stop the batch, and the next row is still deleted', async () => {
    mockDeleteModelFileObject
      .mockResolvedValueOnce({ deleted: false, reason: 'still-referenced' })
      .mockResolvedValueOnce(DELETED);
    dbWrite.$queryRaw.mockResolvedValueOnce([row(201), row(202)]);

    await deleteOldTrainingData.run({}).result;

    // Identity, not just count — a batch that marked the WRONG row would pass a count check.
    expect(dbWrite.modelFile.update).toHaveBeenCalledTimes(1);
    expect(dbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 202 },
      data: { dataPurged: true },
    });
  });

  it('a skip is logged as info, NOT as an error', async () => {
    // `still-referenced` is the refcount guard working as designed. Logging it at error level
    // would train an operator to ignore the one signal that says the backlog is not draining.
    mockDeleteModelFileObject.mockResolvedValueOnce({
      deleted: false,
      reason: 'still-referenced',
    });
    dbWrite.$queryRaw.mockResolvedValueOnce([row(104)]);

    await deleteOldTrainingData.run({}).result;

    const skipLog = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { type?: string; message?: string; data?: { reason?: string } })
      .find((arg) => arg?.message === 'Skipped, object left in place');
    expect(skipLog).toBeDefined();
    expect(skipLog?.type).toBe('info');
    expect(skipLog?.data?.reason).toBe('still-referenced');
  });
});

describe('a thrown delete is still a failure, and still does not mark the row', () => {
  it('does not mark dataPurged and continues to the next row', async () => {
    mockDeleteModelFileObject
      .mockRejectedValueOnce(new Error('The specified bucket does not exist.'))
      .mockResolvedValueOnce(DELETED);
    dbWrite.$queryRaw.mockResolvedValueOnce([row(301), row(302)]);

    await deleteOldTrainingData.run({}).result;

    expect(dbWrite.modelFile.update).toHaveBeenCalledTimes(1);
    expect(dbWrite.modelFile.update).toHaveBeenCalledWith({
      where: { id: 302 },
      data: { dataPurged: true },
    });
  });

  it('POSITIVE CONTROL: an empty selection does no work at all', async () => {
    // Without this, every assertion above is also satisfied by a job that selects nothing and
    // silently returns — the shape the whole suite would take if `$queryRaw` stopped resolving.
    dbWrite.$queryRaw.mockResolvedValueOnce([]);

    await deleteOldTrainingData.run({}).result;

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    expect(dbWrite.modelFile.update).not.toHaveBeenCalled();
  });
});

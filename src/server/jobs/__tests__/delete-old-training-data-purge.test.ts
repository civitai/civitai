import { readFileSync } from 'fs';
import path from 'path';
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

const { mockDeleteModelFileObject, mockIsFlipt, mockResolveTarget } = vi.hoisted(() => ({
  mockDeleteModelFileObject: vi.fn(),
  mockIsFlipt: vi.fn(),
  mockResolveTarget: vi.fn(),
}));

vi.mock('~/utils/s3-utils', () => ({
  deleteModelFileObject: mockDeleteModelFileObject,
  resolveModelFileDeleteTarget: mockResolveTarget,
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
  FLIPT_FEATURE_FLAGS: {
    TRAINING_DATA_PURGE: 'training-data-purge',
    TRAINING_DATA_PURGE_DRY_RUN: 'training-data-purge-dry-run',
  },
}));

import {
  DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS,
  deleteOldTrainingData,
} from '~/server/jobs/delete-old-training-data';
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

/**
 * The job issues TWO reads: an uncapped `count(*)` and then the capped slice. A bare
 * `mockResolvedValueOnce(rows)` would satisfy the COUNT and leave the slice empty, which reads as
 * a job that found nothing — green, and about nothing. Every case sets both through here.
 */
const selects = (rows: ReturnType<typeof row>[], total = rows.length) => {
  dbWrite.$queryRaw.mockResolvedValueOnce([{ total: BigInt(total) }]).mockResolvedValueOnce(rows);
};

beforeEach(() => {
  vi.clearAllMocks();
  loggingMock.logToAxiom.mockImplementation(() => ({ catch: () => undefined }));
  // 🔴 An explicit default, because a bare `vi.fn()` resolves to `undefined` and
  // `undefined.deleted` is falsy — i.e. every case would silently become a SKIP case and a
  // green suite would say nothing about the purge path.
  mockDeleteModelFileObject.mockResolvedValue(DELETED);
  // The switch is ON for every case below except the ones that are ABOUT the switch. Stated
  // rather than defaulted, because `isFlipt` resolving to undefined would read as OFF and every
  // case would pass vacuously over a job that did nothing.
  // Purge ON, dry-run OFF, for every case except the ones that are about those switches.
  mockIsFlipt.mockImplementation(async (flag: string) => flag === 'training-data-purge');
  // Deletable by default; the would-skip arm says so explicitly.
  mockResolveTarget.mockReturnValue({ ok: true, backend: 'b2', bucket: 'b', key: 'k' });
});

describe('delete-old-training-data routes its deletes through the ModelFile helper', () => {
  it('🔴 calls deleteModelFileObject with the url AND the row id as excludeId', async () => {
    selects([row(101)]);

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
    selects([row(102)]);

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
      selects([row(103)]);

      await deleteOldTrainingData.run({}).result;

      expect(dbWrite.modelFile.update).not.toHaveBeenCalled();
    }
  );

  it('a skip does not stop the batch, and the next row is still deleted', async () => {
    mockDeleteModelFileObject
      .mockResolvedValueOnce({ deleted: false, reason: 'still-referenced' })
      .mockResolvedValueOnce(DELETED);
    selects([row(201), row(202)]);

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
    selects([row(104)]);

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
    selects([row(301), row(302)]);

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
    selects([]);

    await deleteOldTrainingData.run({}).result;

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    expect(dbWrite.modelFile.update).not.toHaveBeenCalled();
  });
});

describe('the purge is OFF unless someone turns it on', () => {
  it('🔴 does nothing at all when the flag is off — not even the SELECT', async () => {
    // Default-off is the whole rollout plan: the first release carrying this change must not
    // start deleting on its own. Asserting the QUERY never runs, not merely that no delete
    // happened, is what makes this a real gate rather than an empty-batch coincidence.
    mockIsFlipt.mockResolvedValueOnce(false);

    await deleteOldTrainingData.run({}).result;

    expect(dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    expect(dbWrite.modelFile.update).not.toHaveBeenCalled();
  });

  it('CONTROL: with the flag on, the same setup DOES delete', async () => {
    // Without this arm the case above is satisfied by a job that is broken in any other way.
    selects([row(401)]);

    await deleteOldTrainingData.run({}).result;

    expect(dbWrite.$queryRaw).toHaveBeenCalled();
    expect(mockDeleteModelFileObject).toHaveBeenCalledTimes(1);
  });

  it('gates on the training-data purge flag specifically', async () => {
    selects([]);
    await deleteOldTrainingData.run({}).result;
    expect(mockIsFlipt).toHaveBeenCalledWith('training-data-purge');
  });
});

describe('a pass is capped', () => {
  it('binds the cap into the query rather than selecting the whole backlog', async () => {
    selects([]);

    await deleteOldTrainingData.run({}).result;

    // The tagged template passes interpolated values as trailing arguments, so the cap is
    // asserted where it actually lands — bound, not spliced into the SQL text.
    //
    // 🔴 calls[1], NOT calls[0]. The first read is the uncapped `count(*)`; the capped slice is
    // the second. This assertion pointed at calls[0] until the count query was added and went
    // red immediately, which is the behaviour I want from it — an index that silently drifts
    // onto the wrong query would assert the cap against a statement that has none.
    expect(dbWrite.$queryRaw).toHaveBeenCalledTimes(2);
    const args = dbWrite.$queryRaw.mock.calls[1];
    expect(args).toContain(DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS);
    // ...and the COUNT query must NOT carry it, or the "uncapped total" is capped too.
    expect(dbWrite.$queryRaw.mock.calls[0]).not.toContain(
      DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS
    );
  });

  it('🔴 the cap is a real bound, not a number larger than any backlog', () => {
    // A "cap" set above the population it caps is indistinguishable from no cap, and reads in
    // review as though the hazard were addressed. Pinned to its literal so raising it has to be
    // argued in the docblock, which says the value is a choice rather than a derivation.
    expect(DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS).toBe(2000);
  });
});

describe('the dry run stops short of the delete', () => {
  it('🔴 resolves the rows and deletes NOTHING', async () => {
    mockIsFlipt.mockImplementation(async () => true); // purge on AND dry-run on
    selects([row(501), row(502)]);

    await deleteOldTrainingData.run({}).result;

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    expect(dbWrite.modelFile.update).not.toHaveBeenCalled();
  });

  it('names each row it WOULD have deleted, which is the whole point of the mode', async () => {
    // A dry run that reports only a count tells an operator nothing they could check. The
    // identifying fields are what make the output auditable before anything is destroyed.
    mockIsFlipt.mockImplementation(async () => true);
    selects([row(503)]);

    await deleteOldTrainingData.run({}).result;

    const line = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { message?: string; data?: { modelFileId?: number; url?: string } })
      .find((arg) => arg?.message === 'Dry run, would delete');
    expect(line?.data?.modelFileId).toBe(503);
    expect(line?.data?.url).toBe('https://example.invalid/bucket/key-503');
  });

  it('🔴 says would SKIP for a row the real pass would not delete', async () => {
    // The defect this closes: the dry run labelled EVERY row "would delete", including ones
    // several outcomes leave undeleted by design. An operator reading a night of that would
    // project a drain rate the real pass cannot reach. The classification comes from the same
    // function the real path uses, so the preview cannot drift from the behaviour it previews.
    mockIsFlipt.mockImplementation(async () => true);
    mockResolveTarget.mockReturnValueOnce({ ok: false, reason: 'bucket-not-allowed' });
    selects([row(505)]);

    await deleteOldTrainingData.run({}).result;

    const messages = loggingMock.logToAxiom.mock.calls.map(
      ([arg]) => (arg as { message?: string })?.message
    );
    expect(messages).toContain('Dry run, would skip');
    expect(messages).not.toContain('Dry run, would delete');
    const skip = loggingMock.logToAxiom.mock.calls
      .map(([arg]) => arg as { message?: string; data?: { reason?: string } })
      .find((arg) => arg?.message === 'Dry run, would skip');
    expect(skip?.data?.reason).toBe('bucket-not-allowed');
  });

  it('🔴 the SUMMARY separates would-delete from would-skip, not just the per-row lines', async () => {
    // The same misreading one level up: an earlier version split the per-row lines correctly and
    // then reported ONE dry-run total, so an operator dividing the eligible total by it projects
    // a drain rate the real pass cannot hit. This file's own argument for reporting an uncapped
    // total is that an aggregate must carry the quantity actually draining.
    mockIsFlipt.mockImplementation(async () => true);
    mockResolveTarget
      .mockReturnValueOnce({ ok: false, reason: 'bucket-not-allowed', backend: 'b2', bucket: 'x' })
      .mockReturnValueOnce({ ok: true, backend: 'b2', bucket: 'b', key: 'k' });
    selects([row(601), row(602)], 5000);

    await deleteOldTrainingData.run({}).result;

    const fin = loggingMock.logToAxiom.mock.calls
      .map(
        ([arg]) =>
          arg as {
            message?: string;
            data?: { dryRunWouldDelete?: number; dryRunWouldSkip?: number };
          }
      )
      .find((arg) => arg?.message === 'Finished');
    // Different numbers on purpose: one counter reported twice satisfies any check that only
    // asserts both fields exist.
    expect(fin?.data?.dryRunWouldDelete).toBe(1);
    expect(fin?.data?.dryRunWouldSkip).toBe(1);
  });

  it('asks the SAME resolver the real delete path uses', async () => {
    // One authority, not two: a preview that re-implements backend selection and the allowlist
    // drifts from the original the first time either changes.
    mockIsFlipt.mockImplementation(async () => true);
    selects([row(506)]);

    await deleteOldTrainingData.run({}).result;

    expect(mockResolveTarget).toHaveBeenCalledWith('https://example.invalid/bucket/key-506');
  });

  it('CONTROL: with dry-run OFF the same setup really deletes', async () => {
    // Without this arm, a job broken in any other way also passes the two cases above.
    selects([row(504)]);

    await deleteOldTrainingData.run({}).result;

    expect(mockDeleteModelFileObject).toHaveBeenCalledTimes(1);
    expect(dbWrite.modelFile.update).toHaveBeenCalledTimes(1);
  });

  it('gates the dry run on its OWN flag, not the purge flag', async () => {
    // Both default off, and reading the wrong one would silently make the dry run unreachable.
    selects([]);
    await deleteOldTrainingData.run({}).result;
    expect(mockIsFlipt).toHaveBeenCalledWith('training-data-purge-dry-run');
  });
});

describe('the uncapped backlog total is reported', () => {
  it('🔴 reports the FULL eligible count beside the capped slice', async () => {
    // Without this the cap makes the backlog invisible: a pass reports the cap and nothing else,
    // identically whether the set is a little over it or vastly over it, and identically whether
    // it is shrinking or growing — the opposite of the readability the cap is justified by.
    selects([row(601), row(602)], 987654);

    await deleteOldTrainingData.run({}).result;

    const found = loggingMock.logToAxiom.mock.calls
      .map(
        ([arg]) => arg as { message?: string; data?: { eligibleTotal?: number; count?: number } }
      )
      .find((arg) => arg?.message === 'Found jobs');
    expect(found?.data?.eligibleTotal).toBe(987654);
    // The slice and the total are DIFFERENT numbers here on purpose: reporting the slice twice
    // would satisfy any assertion that only checked the field exists.
    expect(found?.data?.count).toBe(2);
  });
});

describe('a capped pass cannot starve the rest of the backlog', () => {
  it('🔴 orders randomly, so a permanently-skipping head cannot hold the slice forever', () => {
    // Several outcomes leave a row eligible for ever by design (non-allowlisted bucket,
    // unparseable url, still-referenced). Under ANY stable order those rows occupy the first
    // LIMIT slots every night and the pass never reaches the rest — a starvation the uncapped
    // loop could not have. This is a source read because the ordering lives in raw SQL; it
    // cannot tell you the plan, only that the clause was not dropped.
    const sql = readFileSync(path.resolve(__dirname, '../delete-old-training-data.ts'), 'utf8');
    expect(sql).toMatch(/ORDER BY random\(\)\s*\n\s*LIMIT/);
  });
});

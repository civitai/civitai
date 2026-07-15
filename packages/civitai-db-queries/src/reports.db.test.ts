import { beforeEach, describe, expect, it } from 'vitest';
import { setReportStatus, setReportStatusMany } from './reports.db';
import { connectCompileOnly } from './test/harness';

const harness = connectCompileOnly();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('setReportStatus', () => {
  it('updates one report, guarded by status change, returning the reporters', async () => {
    await setReportStatus({ id: 7, status: 'Unactioned', userId: 99 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Report" set "status" = $1, "statusSetAt" = $2, "statusSetBy" = $3 ' +
        'where "id" = $4 and "status" != $5 returning "userId", "alsoReportedBy"'
    );
    expect(parameters[0]).toBe('Unactioned'); // set status
    expect(parameters[1]).toBeInstanceOf(Date); // statusSetAt is stamped, not left to a trigger
    expect(parameters[2]).toBe(99); // statusSetBy
    expect(parameters[3]).toBe(7); // id
    expect(parameters[4]).toBe('Unactioned'); // status != guard
  });

  it('stamps previouslyReviewedCount only when actioning', async () => {
    await setReportStatus({ id: 7, status: 'Actioned', userId: 99 });
    const { sql } = harness.lastQuery();

    expect(sql).toBe(
      'update "Report" set "status" = $1, "statusSetAt" = $2, "statusSetBy" = $3, ' +
        '"previouslyReviewedCount" = coalesce(array_length("alsoReportedBy", 1), 0) + 1 ' +
        'where "id" = $4 and "status" != $5 returning "userId", "alsoReportedBy"'
    );
  });
});

describe('setReportStatusMany', () => {
  it('short-circuits on an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await setReportStatusMany({ ids: [], status: 'Actioned', userId: 99 });

    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0); // never touched the DB — the guard the README requires
  });

  it('bulk-updates the given ids in one statement, returning changed rows', async () => {
    await setReportStatusMany({ ids: [1, 2, 3], status: 'Actioned', userId: 99 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Report" set "status" = $1, "statusSetAt" = $2, "statusSetBy" = $3, ' +
        '"previouslyReviewedCount" = coalesce(array_length("alsoReportedBy", 1), 0) + 1 ' +
        'where "id" in ($4, $5, $6) and "status" != $7 returning "id", "userId", "alsoReportedBy"'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual(['Actioned', expect.any(Date), 99, 1, 2, 3, 'Actioned']);
  });

  it('omits previouslyReviewedCount for a non-Actioned transition', async () => {
    await setReportStatusMany({ ids: [1, 2], status: 'Pending', userId: 99 });
    const { sql } = harness.lastQuery();

    expect(sql).not.toContain('previouslyReviewedCount');
    expect(sql).toBe(
      'update "Report" set "status" = $1, "statusSetAt" = $2, "statusSetBy" = $3 ' +
        'where "id" in ($4, $5) and "status" != $6 returning "id", "userId", "alsoReportedBy"'
    );
  });
});

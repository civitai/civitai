import { beforeEach, describe, expect, it } from 'vitest';
import { getReports, setReportStatus, setReportStatusMany, updateReportNotes } from './reports.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('setReportStatus', () => {
  it('updates one report, guarded by status change, returning the reporters', async () => {
    await setReportStatus(h.db, { id: 7, status: 'Unactioned', userId: 99 });
    const { sql, parameters } = h.lastQuery();

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
    await setReportStatus(h.db, { id: 7, status: 'Actioned', userId: 99 });
    const { sql } = h.lastQuery();

    expect(sql).toBe(
      'update "Report" set "status" = $1, "statusSetAt" = $2, "statusSetBy" = $3, ' +
        '"previouslyReviewedCount" = coalesce(array_length("alsoReportedBy", 1), 0) + 1 ' +
        'where "id" = $4 and "status" != $5 returning "userId", "alsoReportedBy"'
    );
  });
});

describe('setReportStatusMany', () => {
  it('short-circuits on an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await setReportStatusMany(h.db, { ids: [], status: 'Actioned', userId: 99 });

    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0); // never touched the DB — the guard the README requires
  });

  it('bulk-updates the given ids in one statement, returning changed rows', async () => {
    await setReportStatusMany(h.db, { ids: [1, 2, 3], status: 'Actioned', userId: 99 });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "Report" set "status" = $1, "statusSetAt" = $2, "statusSetBy" = $3, ' +
        '"previouslyReviewedCount" = coalesce(array_length("alsoReportedBy", 1), 0) + 1 ' +
        'where "id" in ($4, $5, $6) and "status" != $7 returning "id", "userId", "alsoReportedBy"'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual(['Actioned', expect.any(Date), 99, 1, 2, 3, 'Actioned']);
  });

  it('omits previouslyReviewedCount for a non-Actioned transition', async () => {
    await setReportStatusMany(h.db, { ids: [1, 2], status: 'Pending', userId: 99 });
    const { sql } = h.lastQuery();

    expect(sql).not.toContain('previouslyReviewedCount');
    expect(sql).toBe(
      'update "Report" set "status" = $1, "statusSetAt" = $2, "statusSetBy" = $3 ' +
        'where "id" in ($4, $5) and "status" != $6 returning "id", "userId", "alsoReportedBy"'
    );
  });
});

describe('updateReportNotes', () => {
  it('updates internalNotes for one report', async () => {
    await updateReportNotes(h.db, { id: 7, internalNotes: 'looks fine' });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe('update "Report" set "internalNotes" = $1 where "id" = $2');
    expect(parameters).toEqual(['looks fine', 7]);
  });
});

describe('getReports', () => {
  it('builds the paged items query: entity-join exists, filters, newest-first, limit/offset', async () => {
    await getReports(h.db, {
      type: 'image',
      page: 2,
      limit: 20,
      statuses: ['Pending'],
      reasons: ['NSFW'],
      reportedBy: 'alice',
    });
    // getReports runs a count then the items query; the items query is last.
    const { sql, parameters } = h.lastQuery();

    expect(sql).toContain('from "Report"');
    expect(sql).toContain('left join "User" on "User"."id" = "Report"."userId"');
    expect(sql).toContain(
      'exists (select 1 from "ImageReport" er where er."reportId" = "Report"."id")'
    );
    expect(sql).toContain('"Report"."status" in ($1)');
    expect(sql).toContain('"Report"."reason" in ($2)');
    expect(sql).toContain('"User"."username" ilike $3');
    expect(sql).toContain('order by "Report"."id" desc');
    expect(sql).toContain('limit $4');
    expect(sql).toContain('offset $5');
    // status, reason, reportedBy prefix, limit, offset=(page-1)*limit
    expect(parameters).toEqual(['Pending', 'NSFW', 'alice%', 20, 20]);
  });

  it('omits the status/reason/reportedBy predicates when those filters are absent', async () => {
    await getReports(h.db, { type: 'model' });
    const { sql } = h.lastQuery();

    expect(sql).not.toContain('ilike');
    expect(sql).not.toContain('"Report"."status" in');
    expect(sql).toContain(
      'exists (select 1 from "ModelReport" er where er."reportId" = "Report"."id")'
    );
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createReport,
  getReportById,
  getReportByIds,
  getReports,
  insertReport,
  insertReportEntity,
  setReportStatus,
  setReportStatusMany,
  updateImageReportStatusByReason,
  updateReport,
  upsertImageRatingRequest,
} from './report.db';
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

describe('getReportById / getReportByIds', () => {
  it('selects the whole row for one id', async () => {
    await getReportById(h.db, 7);
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe('select * from "Report" where "id" = $1');
    expect(parameters).toEqual([7]);
  });

  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await getReportByIds(h.db, []);

    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('selects the whole rows for a list of ids', async () => {
    await getReportByIds(h.db, [1, 2, 3]);
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe('select * from "Report" where "id" in ($1, $2, $3)');
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([1, 2, 3]);
  });
});

describe('updateReport', () => {
  it('applies a generic update by id and returns the row (no updatedAt bump — Report has none)', async () => {
    await updateReport(h.db, { id: 7, status: 'Actioned', internalNotes: 'x' });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "Report" set "status" = $1, "internalNotes" = $2 where "id" = $3 returning *'
    );
    expect(sql).not.toContain('updatedAt');
    expect(parameters).toEqual(['Actioned', 'x', 7]);
  });
});

describe('updateImageReportStatusByReason', () => {
  it('updates Report FROM ImageReport, scoped to image + reason, returning id + reporter', async () => {
    await updateImageReportStatusByReason(h.db, {
      id: 42,
      reason: 'CSAM',
      status: 'Actioned',
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "Report" as "r" set "status" = $1 from "ImageReport" as "i" ' +
        'where "i"."reportId" = "r"."id" and "i"."imageId" = $2 and "r"."reason" = $3 ' +
        'returning "r"."id", "r"."userId"'
    );
    expect(parameters).toEqual(['Actioned', 42, 'CSAM']);
  });
});

describe('insertReport', () => {
  it('inserts the report core, binding details as jsonb', async () => {
    // executeTakeFirstOrThrow rejects on the empty DummyDriver result, but the query is logged first.
    await expect(
      insertReport(h.db, {
        userId: 5,
        reason: 'NSFW',
        status: 'Actioned',
        details: { tags: ['a'] },
        internalNotes: 'note',
      })
    ).rejects.toThrow();
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'insert into "Report" ("userId", "reason", "status", "details", "internalNotes") ' +
        'values ($1, $2, $3, $4::jsonb, $5) returning *'
    );
    expect(parameters).toEqual([5, 'NSFW', 'Actioned', '{"tags":["a"]}', 'note']);
  });

  it('omits details (column default {} applies) when undefined', async () => {
    await expect(
      insertReport(h.db, { userId: 5, reason: 'NSFW', status: 'Pending' })
    ).rejects.toThrow();
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'insert into "Report" ("userId", "reason", "status") values ($1, $2, $3) returning *'
    );
    expect(parameters).toEqual([5, 'NSFW', 'Pending']);
  });
});

describe('insertReportEntity', () => {
  it('inserts the per-type join row (dynamic table/column) via raw sql', async () => {
    await insertReportEntity(h.db, { type: 'image', reportId: 10, entityId: 99 });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe('insert into "ImageReport" ("reportId", "imageId") values ($1, $2)');
    expect(parameters).toEqual([10, 99]);
  });

  it('resolves a different join table/column per type', async () => {
    await insertReportEntity(h.db, { type: 'model', reportId: 10, entityId: 99 });
    const { sql } = h.lastQuery();

    expect(sql).toBe('insert into "ModelReport" ("reportId", "modelId") values ($1, $2)');
  });
});

describe('upsertImageRatingRequest', () => {
  it('upserts the (imageId,userId) request, bumping nsfwLevel on conflict, weight default 3', async () => {
    await upsertImageRatingRequest(h.db, { imageId: 1, userId: 2, nsfwLevel: 8 });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'insert into "ImageRatingRequest" ("imageId", "userId", "nsfwLevel", "weight") ' +
        'values ($1, $2, $3, $4) ' +
        'on conflict ("imageId", "userId") do update set "nsfwLevel" = $5'
    );
    expect(parameters).toEqual([1, 2, 8, 3, 8]);
  });
});

describe('createReport', () => {
  it('runs inside a transaction and inserts the report core first', async () => {
    // The nested insert throws on the empty DummyDriver result (executeTakeFirstOrThrow), rolling the tx back;
    // the Report insert is compiled + captured first, which is what we assert. (DummyDriver does not log the
    // begin/rollback control statements through the query hook.)
    await expect(
      createReport(h.db, {
        userId: 5,
        type: 'image',
        entityId: 99,
        reason: 'NSFW',
        status: 'Actioned',
        details: { tags: ['a'] },
      })
    ).rejects.toThrow();

    expect(h.queries[0].sql).toContain('insert into "Report"');
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

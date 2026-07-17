import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCsamReport,
  createExternalCsamReport,
  getCsamReportStats,
  getCsamReportsPaged,
  getCsamsToArchive,
  getCsamsToRemoveContent,
  getCsamsToReport,
  setCsamReportSent,
  updateCsamReport,
} from './csam.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('createCsamReport', () => {
  it('inserts a report, mapping imageIds to objects and writing jsonb columns', async () => {
    await createCsamReport(h.db, {
      reportedById: 5,
      userId: 42,
      type: 'Image',
      imageIds: [1, 2],
      details: { minorDepiction: 'real' },
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'insert into "CsamReport" ("userId", "reportedById", "type", "images", "details") ' +
        'values ($1, $2, $3, $4::jsonb, $5::jsonb) returning *'
    );
    expect(parameters[0]).toBe(42); // reported user
    expect(parameters[1]).toBe(5); // reportedById
    expect(parameters[2]).toBe('Image');
    expect(parameters[3]).toBe(JSON.stringify([{ id: 1 }, { id: 2 }]));
    expect(parameters[4]).toBe(JSON.stringify({ minorDepiction: 'real' }));
  });

  it('stores a null reported user for an internal report (userId === -1)', async () => {
    await createCsamReport(h.db, { reportedById: 5, userId: -1, type: 'Image' });
    const { parameters } = h.lastQuery();

    expect(parameters[0]).toBe(null); // internal report -> no reported user
  });

  it('omits details (DB default applies) and empty images when neither is provided', async () => {
    await createCsamReport(h.db, { reportedById: 5, userId: 42, type: 'TrainingData' });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'insert into "CsamReport" ("userId", "reportedById", "type", "images") ' +
        'values ($1, $2, $3, $4::jsonb) returning *'
    );
    expect(sql).not.toContain('"details"');
    expect(parameters[3]).toBe(JSON.stringify([])); // images defaults to []
  });
});

describe('createExternalCsamReport', () => {
  it('inserts an ExternalLink report, stripping empty details and empty images', async () => {
    await createExternalCsamReport(h.db, {
      reportedById: 5,
      userId: 42,
      details: {
        email: 'a@b.com',
        reportedName: undefined,
        externalUrls: [],
        profileUrls: ['x'],
      },
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'insert into "CsamReport" ("userId", "reportedById", "type", "details", "images") ' +
        'values ($1, $2, $3, $4::jsonb, $5::jsonb) returning *'
    );
    expect(parameters[0]).toBe(42);
    expect(parameters[1]).toBe(5);
    expect(parameters[2]).toBe('ExternalLink');
    // removeEmpty drops the undefined `reportedName` and the empty `externalUrls`.
    expect(parameters[3]).toBe(JSON.stringify({ email: 'a@b.com', profileUrls: ['x'] }));
    expect(parameters[4]).toBe(JSON.stringify([]));
  });
});

describe('getCsamReportsPaged', () => {
  it('reads a page newest-first with limit/offset, then hydrates users', async () => {
    // With the DummyDriver the report read resolves empty, so the user read short-circuits (no `in ()`) and
    // the last query is the count. Assert the paged read explicitly from the captured queries.
    await getCsamReportsPaged(h.db, { limit: 20, page: 2 });

    const paged = h.queries[0];
    expect(paged.sql).toBe(
      'select * from "CsamReport" order by "createdAt" desc limit $1 offset $2'
    );
    expect(paged.parameters).toEqual([20, 20]); // offset = (page-1)*limit

    const count = h.lastQuery();
    expect(count.sql).toBe('select count(*) as "count" from "CsamReport"');
  });

  it('omits limit/offset when limit is not positive', async () => {
    await getCsamReportsPaged(h.db, { limit: 0, page: 1 });
    const paged = h.queries[0];
    expect(paged.sql).toBe('select * from "CsamReport" order by "createdAt" desc');
  });
});

describe('getCsamReportStats', () => {
  it('runs the three queue counts with the right predicates', async () => {
    await getCsamReportStats(h.db);
    const [unreported, unarchived, unremoved] = h.queries;

    expect(unreported.sql).toBe(
      'select count(*) as "count" from "CsamReport" where "reportSentAt" is null'
    );
    expect(unarchived.sql).toBe(
      'select count(*) as "count" from "CsamReport" ' +
        'where "reportSentAt" is not null and "archivedAt" is null'
    );
    expect(unremoved.sql).toBe(
      'select count(*) as "count" from "CsamReport" ' +
        'where "reportSentAt" is not null and "archivedAt" is not null ' +
        'and "userId" is not null and "contentRemovedAt" is null'
    );
  });
});

describe('queue reads', () => {
  it('getCsamsToReport selects unsent reports', async () => {
    await getCsamsToReport(h.db);
    expect(h.lastQuery().sql).toBe('select * from "CsamReport" where "reportSentAt" is null');
  });

  it('getCsamsToArchive selects sent-but-unarchived reports', async () => {
    await getCsamsToArchive(h.db);
    expect(h.lastQuery().sql).toBe(
      'select * from "CsamReport" where "reportSentAt" is not null and "archivedAt" is null'
    );
  });

  it('getCsamsToRemoveContent selects archived reports with content still present', async () => {
    await getCsamsToRemoveContent(h.db);
    expect(h.lastQuery().sql).toBe(
      'select * from "CsamReport" ' +
        'where "reportSentAt" is not null and "archivedAt" is not null ' +
        'and "userId" is not null and "contentRemovedAt" is null'
    );
  });
});

describe('setCsamReportSent', () => {
  it('stamps reportId and reportSentAt for one report', async () => {
    await setCsamReportSent(h.db, { id: 7, reportId: 123 });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "CsamReport" set "reportId" = $1, "reportSentAt" = $2 where "id" = $3'
    );
    expect(parameters[0]).toBe(123);
    expect(parameters[1]).toBeInstanceOf(Date); // stamped, not left to a trigger
    expect(parameters[2]).toBe(7);
  });
});

describe('updateCsamReport', () => {
  it('applies a generic update by id and returns the row (no updatedAt bump — CsamReport has none)', async () => {
    await updateCsamReport(h.db, { id: 7, reportId: 123, contentRemovedAt: new Date() });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "CsamReport" set "reportId" = $1, "contentRemovedAt" = $2 where "id" = $3 returning *'
    );
    expect(sql).not.toContain('updatedAt');
    expect(parameters[0]).toBe(123);
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters[2]).toBe(7);
  });

  it('marks a report archived via the generic (the collapsed setCsamReportArchived)', async () => {
    await updateCsamReport(h.db, { id: 7, archivedAt: new Date() });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe('update "CsamReport" set "archivedAt" = $1 where "id" = $2 returning *');
    expect(parameters[0]).toBeInstanceOf(Date);
    expect(parameters[1]).toBe(7);
  });
});

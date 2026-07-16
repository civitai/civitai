import { beforeEach, describe, expect, it } from 'vitest';
import {
  countImageAppeals,
  countPendingImageTagReviews,
  countReportsPending,
} from './sidebar-counts.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('countPendingImageTagReviews', () => {
  it('counts distinct tagged images with the bit-9-set / bit-10-clear bitmask predicates verbatim', async () => {
    await countPendingImageTagReviews(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select count(distinct "imageId") as "count" from "TagsOnImageNew" ' +
        'where ((attributes >> 9)::integer & 1) = 1 and ((attributes >> 10)::integer & 1) <> 1'
    );
    expect(parameters).toEqual([]);
  });
});

describe('countImageAppeals', () => {
  it('counts images whose needsReview is appeal', async () => {
    await countImageAppeals(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select count(*) as "count" from "Image" where "needsReview" = $1');
    expect(parameters).toEqual(['appeal']);
  });
});

describe('countReportsPending', () => {
  it('counts distinct images joined to a pending report', async () => {
    await countReportsPending(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select count(distinct "ir"."imageId") as "count" from "Report" as "r" ' +
        'inner join "ImageReport" as "ir" on "ir"."reportId" = "r"."id" where "r"."status" = $1'
    );
    expect(parameters).toEqual(['Pending']);
  });
});

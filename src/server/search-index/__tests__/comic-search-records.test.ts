import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  comicSearchEligibleWhere,
  getComicSearchRecords,
} from '~/server/search-index/comics.search-index';

/** The query the semantic comic search hydrates through, as Postgres would receive it. */
async function recordsQuery(ids: number[]) {
  const queryRaw = vi.fn(async () => []);
  await getComicSearchRecords({ $queryRaw: queryRaw } as never, ids);
  if (!queryRaw.mock.calls.length) return undefined;
  const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
  return Prisma.sql(strings, ...values);
}

describe('getComicSearchRecords', () => {
  it("reads only through the index's eligibility rule, for the ids asked", async () => {
    const query = await recordsQuery([3, 4]);
    // Every clause, joined with AND (with OR any one clause would let a comic through).
    expect(query?.sql).toContain(Prisma.join(comicSearchEligibleWhere, ' AND ').sql);
    expect(query?.sql).toContain('cp.id IN (');
    expect(query?.values).toEqual(expect.arrayContaining([3, 4]));
  });

  it('asks nothing for no ids', async () => {
    expect(await recordsQuery([])).toBeUndefined();
  });
});

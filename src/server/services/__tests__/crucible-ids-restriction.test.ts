import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { CrucibleSort } from '~/server/common/enums';

const { getCrucibles } = await import('~/server/services/crucible.service');

/**
 * The semantic search hydrates its candidates through getCrucibles with `ids`. That restriction
 * must reach the query: without it, a page of search results would be the whole feed.
 */
const wheres: Record<string, unknown>[] = [];
beforeEach(() => {
  wheres.length = 0;
  dbMock.dbRead.crucible.findMany.mockImplementation((async ({ where }: { where: object }) => {
    wheres.push(where as Record<string, unknown>);
    return [];
  }) as never);
});

const hydrate = (ids: number[]) =>
  getCrucibles({
    input: { limit: ids.length || 1, sort: CrucibleSort.Newest, browsingLevel: 1 },
    select: { id: true },
    ids,
  });

describe('getCrucibles with ids', () => {
  it('reads only those crucibles, in every query it runs', async () => {
    await hydrate([3, 1, 2]);
    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) expect(where).toMatchObject({ id: { in: [3, 1, 2] } });
  });

  it('with no ids, returns nothing and reads nothing', async () => {
    expect(await hydrate([])).toEqual({ items: [], nextCursor: undefined });
    expect(wheres).toHaveLength(0);
  });
});

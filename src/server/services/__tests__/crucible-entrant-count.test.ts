import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks';
import { competeWinsSource } from '~/server/services/creator-milestone-detectors';

const queryRaw = dbMock.dbRead.$queryRaw;

const { getCrucibleDetail, getEntrantCounts, withEntryCounts } = await import(
  '~/server/services/crucible.service'
);

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();
// Joining with '?' is safe: no needle below spans a placeholder. Values are asserted separately.
const sqlOf = (call: unknown[]) => squash((call[0] as string[]).join('?'));
const valuesOf = (call: unknown[]) => call.slice(1);

const stripComments = (sql: string) =>
  sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// Each side scopes to its crucible its own way; everything else in the predicate must be identical.
const entrantPredicate = (sql: string, end: RegExp) => {
  const clean = squash(stripComments(sql));
  const select = clean.match(/count\(DISTINCT e\."userId"\)/)?.[0];
  const from = clean.indexOf('WHERE', clean.indexOf('FROM "CrucibleEntry" e'));
  const rest = clean.slice(from + 'WHERE'.length).split(end)[0];
  const where = rest
    .replace(/e\."crucibleId" = ANY\(\?::int\[\]\)/, '<scope>')
    .replace(/e\."crucibleId" = c\.id/, '<scope>')
    .trim();
  return { select, where };
};

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([]);
  dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([]);
});

describe('getEntrantCounts', () => {
  it('returns a zero for crucibles nobody entered, and the grouped count for the rest', async () => {
    queryRaw.mockResolvedValue([{ crucibleId: 2, entrants: 3 }]);

    const counts = await getEntrantCounts([1, 2]);

    expect([...counts]).toEqual([
      [1, 0],
      [2, 3],
    ]);
  });

  it('counts a user who entered several times once, in one grouped query', async () => {
    await getEntrantCounts([1, 2, 3]);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(queryRaw.mock.calls[0]);
    expect(valuesOf(queryRaw.mock.calls[0])).toEqual([[1, 2, 3]]);
    expect(sql).toContain('count(DISTINCT e."userId")');
    expect(sql).toContain('GROUP BY e."crucibleId"');
  });

  it("uses the milestone's entrant definition: same expression and same filters", async () => {
    await getEntrantCounts([1]);

    const mine = entrantPredicate(sqlOf(queryRaw.mock.calls[0]), /GROUP BY/);
    const milestone = entrantPredicate(competeWinsSource, /\) >=/);

    expect(mine.where).toContain('<scope>');
    expect(mine).toEqual(milestone);
  });

  it('asks nothing for no crucibles', async () => {
    expect([...(await getEntrantCounts([]))]).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('entrant count surfaces', () => {
  it('list rows carry both the paid and the entrant count', async () => {
    dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([{ crucibleId: 2, _count: { _all: 4 } }]);
    queryRaw.mockResolvedValue([{ crucibleId: 2, entrants: 3 }]);

    const rows = await withEntryCounts([{ id: 1 }, { id: 2 }]);

    expect(valuesOf(queryRaw.mock.calls[0])).toEqual([[1, 2]]);
    expect(rows).toEqual([
      { id: 1, paidEntryCount: 0, entrantCount: 0 },
      { id: 2, paidEntryCount: 4, entrantCount: 3 },
    ]);
  });

  it('the detail page gets the entrant count', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      id: 1,
      freeEntriesPerUser: 1,
      _count: { entries: 5 },
      status: CrucibleStatus.Active,
    });
    queryRaw.mockResolvedValue([{ crucibleId: 1, entrants: 2 }]);

    const detail = await getCrucibleDetail({ id: 1 });

    expect(detail?.entrantCount).toBe(2);
    expect(valuesOf(queryRaw.mock.calls[0])).toEqual([[1]]);
  });
});

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

describe('the detail page cover and hero', () => {
  const UPLOADER = 7;
  const image = (id: number) => ({
    id,
    url: `u${id}`,
    nsfwLevel: 4,
    modelRestricted: true,
    userId: UPLOADER,
    ingestion: 'Scanned',
    needsReview: null,
    tosViolation: false,
  });

  beforeEach(() => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      id: 1,
      userId: UPLOADER,
      freeEntriesPerUser: 1,
      _count: { entries: 0 },
      status: CrucibleStatus.Active,
      ingestion: 'Scanned',
      imageId: 10,
      image: image(10),
      heroImage: image(11),
    });
    queryRaw.mockResolvedValue([]);
  });

  it('withholds a restricted image from a signed-out viewer', async () => {
    const detail = await getCrucibleDetail({ id: 1 });

    expect(detail?.image).toBeNull();
    expect(detail?.imageId).toBeNull();
    expect(detail?.heroImage).toBeNull();
    // The page itself still shows, without them.
    expect(detail?.hiddenByScan).toBe(false);
  });

  it.each([
    ['its uploader', { userId: UPLOADER }],
    ['a moderator', { userId: 99, isModerator: true }],
  ])('shows %s the images', async (_, viewer) => {
    const detail = await getCrucibleDetail({ id: 1, ...viewer });

    expect(detail?.image).toMatchObject({ id: 10, url: 'u10', nsfwLevel: 4 });
    expect(detail?.imageId).toBe(10);
    expect(detail?.heroImage).toMatchObject({ id: 11, url: 'u11', nsfwLevel: 4 });
  });

  it.each([
    ['in review', { needsReview: 'minor' }],
    ['a ToS violation', { tosViolation: true }],
  ])(
    'still hides the page from a signed-out viewer while its restricted cover is %s',
    async (_, cover) => {
      dbMock.dbRead.crucible.findUnique.mockResolvedValue({
        id: 1,
        userId: UPLOADER,
        freeEntriesPerUser: 1,
        _count: { entries: 0 },
        status: CrucibleStatus.Active,
        ingestion: 'Scanned',
        imageId: 10,
        image: { ...image(10), ...cover },
        heroImage: image(11),
      });
      expect((await getCrucibleDetail({ id: 1 }))?.hiddenByScan).toBe(true);
      expect(
        (await getCrucibleDetail({ id: 1, userId: 99, isModerator: true }))?.hiddenByScan
      ).toBe(false);
    }
  );
});

describe('the crucible page notice for a restricted cover', () => {
  const crucibleWith = (cover: Record<string, unknown>, crucible: Record<string, unknown> = {}) =>
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      id: 1,
      userId: 7,
      freeEntriesPerUser: 1,
      _count: { entries: 0 },
      status: CrucibleStatus.Active,
      ingestion: 'Scanned',
      imageId: 10,
      image: {
        id: 10,
        url: 'u10',
        nsfwLevel: 4,
        modelRestricted: true,
        userId: 7,
        ingestion: 'Scanned',
        needsReview: null,
        tosViolation: false,
        ...cover,
      },
      heroImage: null,
      ...crucible,
    });

  beforeEach(() => queryRaw.mockResolvedValue([]));

  it('tells its owner, who uploaded the cover and still sees it, and moderators, and no one else', async () => {
    crucibleWith({});
    expect((await getCrucibleDetail({ id: 1, userId: 7 }))?.coverRestricted).toBe(true);
    expect(
      (await getCrucibleDetail({ id: 1, userId: 99, isModerator: true }))?.coverRestricted
    ).toBe(true);
    expect((await getCrucibleDetail({ id: 1, userId: 8 }))?.coverRestricted).toBe(false);
    expect((await getCrucibleDetail({ id: 1 }))?.coverRestricted).toBe(false);
  });

  it('says nothing while the crucible itself awaits its scan', async () => {
    crucibleWith({}, { ingestion: 'Pending' });
    expect((await getCrucibleDetail({ id: 1, userId: 7 }))?.coverRestricted).toBe(false);
  });

  it.each([
    ['unrestricted', { modelRestricted: false }],
    ['SFW', { nsfwLevel: 1 }],
    ['in review', { needsReview: 'minor' }],
    ['a ToS violation', { tosViolation: true }],
    ['still scanning', { ingestion: 'Pending' }],
  ])('says nothing of a cover that is %s', async (_, cover) => {
    crucibleWith(cover);
    expect((await getCrucibleDetail({ id: 1, userId: 7 }))?.coverRestricted).toBe(false);
  });
});

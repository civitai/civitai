import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { NsfwLevel } from '~/server/common/enums';
import type { DomainColor } from '~/shared/utils/prisma/enums';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  HomeBlockType,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
// Module scope for the same reason as home-block-fetch-sizing.test.ts: from a test body this
// graph's transform is charged to one test's 60s budget.
import { getHomeBlockData } from '~/server/services/home-block.service';

// `~/server/db/client` is registered globally by the setup file and reset per test file.

type Row = {
  id: number;
  status: CrucibleStatus;
  eventTags: string[];
  prizePool: number;
  createdAt: Date;
  nsfwLevel: number;
  textNsfw: boolean;
  ingestion: CrucibleIngestionStatus;
  userId: number;
  image: { ingestion: ImageIngestionStatus; nsfwLevel: number };
};

const row = (id: number, overrides: Partial<Row> = {}): Row => ({
  id,
  status: CrucibleStatus.Active,
  eventTags: ['halloween'],
  prizePool: 100,
  createdAt: new Date(2026, 9, id),
  nsfwLevel: NsfwLevel.PG,
  textNsfw: false,
  ingestion: CrucibleIngestionStatus.Scanned,
  userId: 1,
  image: { ingestion: ImageIngestionStatus.Scanned, nsfwLevel: NsfwLevel.PG },
  ...overrides,
});

/**
 * Evaluates the subset of Prisma's where-input `getCrucibles` builds. It throws on any key it does
 * not know, so a new filter in that query fails this file loudly instead of being ignored here.
 */
const matches = (value: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((w) => matches(value, w));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(value, w));
    if (!(key in value)) throw new Error(`fake where: unknown field ${key}`);
    const actual = value[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const op = cond as Record<string, unknown>;
      if ('in' in op) return (op.in as unknown[]).includes(actual);
      if ('notIn' in op) return !(op.notIn as unknown[]).includes(actual);
      if ('has' in op) return (actual as unknown[]).includes(op.has);
      return matches(actual as Record<string, unknown>, op);
    }
    return actual === cond;
  });

const serve = (rows: Row[]) => {
  dbMock.dbRead.crucible.findMany.mockImplementation(
    async ({
      where,
      take,
      orderBy,
    }: {
      where: Record<string, unknown>;
      take: number;
      orderBy: Record<string, 'asc' | 'desc'>[];
    }) => {
      const [first] = orderBy;
      if (!first || !('prizePool' in first) || first.prizePool !== 'desc')
        throw new Error(
          `fake findMany: expected prizePool desc first, got ${JSON.stringify(first)}`
        );
      return rows
        .filter((r) => matches(r, where))
        .sort((a, b) => b.prizePool - a.prizePool || b.id - a.id)
        .slice(0, take)
        .map(({ id }) => ({ id }));
    }
  );
};

const crucibleBlock = (feed: Record<string, unknown>) => ({
  id: 1,
  type: HomeBlockType.Feed,
  metadata: { feed: { entity: 'crucibles', ...feed } },
});

const listedIds = async (feed: Record<string, unknown>, domain?: DomainColor) => {
  const result = await getHomeBlockData({ input: { domain }, homeBlock: crucibleBlock(feed) });
  if (result?.feedItems?.entity !== 'crucibles') return null;
  return result.feedItems.items.map(({ id }) => id);
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([]);
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
});

describe('Feed home block, crucibles entity', () => {
  it('lists only crucibles carrying the block tag, matched case-insensitively', async () => {
    serve([
      row(1),
      row(2, { eventTags: ['winter'] }),
      row(3, { eventTags: [] }),
      row(4, { eventTags: ['winter', 'halloween'] }),
    ]);

    expect(await listedIds({ eventTag: ' Halloween ' })).toEqual([4, 1]);
  });

  // An untagged block must not fall through to "every running crucible on the site".
  it.each([[{}], [{ eventTag: '' }], [{ eventTag: '   ' }]])(
    'resolves nothing when the block has no tag: %j',
    async (feed) => {
      serve([row(1)]);

      expect(await getHomeBlockData({ input: {}, homeBlock: crucibleBlock(feed) })).toBeNull();
      expect(dbMock.dbRead.crucible.findMany).not.toHaveBeenCalled();
    }
  );

  it('lists running crucibles before upcoming ones, each by prize pool', async () => {
    serve([
      row(1, { status: CrucibleStatus.Pending, prizePool: 5000 }),
      row(2, { prizePool: 10 }),
      row(3, { prizePool: 300 }),
      row(4, { status: CrucibleStatus.Pending, prizePool: 50 }),
      row(5, { status: CrucibleStatus.Completed, prizePool: 9000 }),
      row(6, { status: CrucibleStatus.Cancelled, prizePool: 9000 }),
    ]);

    expect(await listedIds({ eventTag: 'halloween' })).toEqual([3, 2, 1, 4]);
  });

  it('shows at most 8, even when the block asks for more', async () => {
    serve(Array.from({ length: 12 }, (_, i) => row(i + 1, { prizePool: i })));

    expect(await listedIds({ eventTag: 'halloween', limit: 28 })).toHaveLength(8);
    expect(await listedIds({ eventTag: 'halloween', limit: 3 })).toHaveLength(3);
  });

  // The block is shared-cached across every viewer, so it holds to the list's own visibility
  // rules at PG: nothing unscanned, nothing with an adult cover or adult text.
  it.each([
    ['an unscanned crucible', { ingestion: CrucibleIngestionStatus.Pending }],
    [
      'an unscanned cover',
      { image: { ingestion: ImageIngestionStatus.Pending, nsfwLevel: NsfwLevel.PG } },
    ],
    [
      'a PG-13 cover',
      { image: { ingestion: ImageIngestionStatus.Scanned, nsfwLevel: NsfwLevel.PG13 } },
    ],
    ['an R cover', { image: { ingestion: ImageIngestionStatus.Scanned, nsfwLevel: NsfwLevel.R } }],
    ['an R-only crucible', { nsfwLevel: NsfwLevel.R }],
    ['adult text', { textNsfw: true }],
  ] as const)('leaves out %s', async (_, overrides) => {
    serve([row(1), row(2, overrides as Partial<Row>)]);

    expect(await listedIds({ eventTag: 'halloween' })).toEqual([1]);
  });

  it("lets a block opt up to PG-13 covers with browsingLevel 'sfw', and no further", async () => {
    serve([
      row(1, { image: { ingestion: ImageIngestionStatus.Scanned, nsfwLevel: NsfwLevel.PG13 } }),
      row(2, { image: { ingestion: ImageIngestionStatus.Scanned, nsfwLevel: NsfwLevel.R } }),
      row(3, { textNsfw: true }),
    ]);

    expect(await listedIds({ eventTag: 'halloween', browsingLevel: 'sfw' })).toEqual([1]);
  });

  // On the green site the crucible list also hides crucibles open to adult entries, whatever their
  // cover; the shared entry is keyed per domain, so the block must ask for that.
  it('leaves out a crucible open to adult entries on the green site only', async () => {
    serve([row(1), row(2, { nsfwLevel: NsfwLevel.PG | NsfwLevel.R })]);

    expect(await listedIds({ eventTag: 'halloween' }, 'green')).toEqual([1]);
    expect(await listedIds({ eventTag: 'halloween' }, 'red')).toEqual([2, 1]);
  });
});

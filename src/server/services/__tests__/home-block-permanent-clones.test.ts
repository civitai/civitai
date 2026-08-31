import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

// The permanent-block list is read through a day-TTL cache. Bypassing it keeps the test
// about the dedupe rather than about Redis, which has its own canonical mock.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

const { getHomeBlocks, setHomeBlocksOrder } = await import('~/server/services/home-block.service');

const ANNOUNCEMENT = { id: 2, type: HomeBlockType.Announcement, index: -1, permanent: true };
const LEADERBOARD = { id: 4, type: HomeBlockType.Leaderboard, index: 8, permanent: false };

const row = (over: Record<string, unknown>) => ({
  metadata: {},
  userId: -1,
  sourceId: null,
  index: 0,
  ...over,
});

/**
 * Routes `homeBlock.findMany` by the shape of its `where`, because getHomeBlocks issues two
 * reads against the same model and a single mockResolvedValue would answer both.
 */
function stubHomeBlockReads({
  userRows,
  permanentRows,
}: {
  userRows: ReturnType<typeof row>[];
  permanentRows: ReturnType<typeof row>[];
}) {
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ exists: true }]);
  dbMock.dbRead.homeBlock.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.permanent === true) return permanentRows;
    return userRows;
  });
}

describe('permanent system blocks are not cloned per user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops a user clone of a permanent block instead of rendering both', async () => {
    stubHomeBlockReads({
      userRows: [
        row({ id: 900, userId: 7, sourceId: ANNOUNCEMENT.id, type: ANNOUNCEMENT.type, index: 1 }),
        row({ id: 901, userId: 7, sourceId: LEADERBOARD.id, type: LEADERBOARD.type, index: 2 }),
      ],
      permanentRows: [row({ ...ANNOUNCEMENT, index: -1 })],
    });

    const blocks = await getHomeBlocks({ userId: 7 });

    // 900 is the clone; 2 is the system block it points at. Exactly one Announcement renders.
    expect(blocks.map((b) => b.id)).toEqual([2, 901]);
  });

  it('keeps a clone whose source is not permanent', async () => {
    stubHomeBlockReads({
      userRows: [row({ id: 901, userId: 7, sourceId: LEADERBOARD.id, type: LEADERBOARD.type })],
      permanentRows: [row({ ...ANNOUNCEMENT })],
    });

    const blocks = await getHomeBlocks({ userId: 7 });

    expect(blocks.map((b) => b.id)).toContain(901);
  });

  it('keeps a user block that has no source at all', async () => {
    stubHomeBlockReads({
      userRows: [row({ id: 902, userId: 7, sourceId: null, type: HomeBlockType.Collection })],
      permanentRows: [row({ ...ANNOUNCEMENT })],
    });

    const blocks = await getHomeBlocks({ userId: 7 });

    expect(blocks.map((b) => b.id)).toContain(902);
  });

  it('keeps permanent blocks out of the editor seed, by query rather than after the fact', async () => {
    stubHomeBlockReads({ userRows: [], permanentRows: [] });

    await getHomeBlocks({ userId: 7, ownedOnly: true });

    const [args] = dbMock.dbRead.homeBlock.findMany.mock.calls.at(-1) as [any];
    // A post-filter here would leave the editor listing a row it cannot act on; the exclusion
    // has to be in the `where` so `ownedOnly` never returns one.
    expect(args.where.permanent).toBe(false);
    expect(args.where.OR).toEqual([{ sourceId: null }, { source: { permanent: false } }]);
  });

  it('does not sweep a permanent clone the editor was never shown', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ exists: true }]);
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue([]);

    await setHomeBlocksOrder({
      input: { userId: 7, homeBlocks: [{ id: 901, index: 0, userId: 7 }] },
    });

    // The removal sweep must not be able to reach a clone of a permanent block: that row can be
    // a user's last one, and no rows means "never customized", which restores every block they
    // removed.
    const removalQuery = dbMock.dbRead.homeBlock.findMany.mock.calls
      .map(([a]: [any]) => a)
      .find((a: any) => a?.where?.id?.not);
    expect(removalQuery.where.OR).toEqual([{ sourceId: null }, { source: { permanent: false } }]);
  });

  it('refuses to clone a permanent block on reorder', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ exists: false }]);
    // The clone lookup asks for the submitted system ids with `permanent: false`, so the
    // permanent block is excluded by the query rather than filtered afterwards.
    // Applies the `where` the way Postgres would rather than keying off it, so dropping the
    // `permanent` predicate surfaces as the permanent block being cloned — the actual
    // regression — instead of as nothing being cloned.
    dbMock.dbRead.homeBlock.findMany.mockImplementation(async (args: any) => {
      // The removal sweep asks a different question; answering it with source rows would queue a
      // deleteMany of the system blocks that no assertion looks at.
      if (args?.where?.id?.not) return [];
      const requested: number[] | undefined = args?.where?.id?.in;
      const wantsPermanent: boolean | undefined = args?.where?.permanent;
      return [row({ ...ANNOUNCEMENT }), row({ ...LEADERBOARD })].filter(
        (b) =>
          (requested === undefined || requested.includes(b.id)) &&
          (wantsPermanent === undefined || b.permanent === wantsPermanent)
      );
    });

    await setHomeBlocksOrder({
      input: {
        userId: 7,
        homeBlocks: [
          { id: ANNOUNCEMENT.id, index: 0, userId: -1 },
          { id: LEADERBOARD.id, index: 1, userId: -1 },
        ],
      },
    });

    const created = dbMock.dbWrite.homeBlock.createMany.mock.calls.flatMap(
      ([arg]: [{ data: { sourceId: number }[] }]) => arg.data
    );
    expect(created.map((d) => d.sourceId)).toEqual([LEADERBOARD.id]);
  });
});

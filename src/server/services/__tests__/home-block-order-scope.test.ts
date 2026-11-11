import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

const { setHomeBlocksOrder } = await import('~/server/services/home-block.service');

const USER_A = 7;
const USER_B = 8;

type StoredBlock = { id: number; userId: number; index: number };
let stored: StoredBlock[];

// Applies each write's `where` to the stored rows the way Postgres would, so a write that is not
// scoped to its owner shows up as another user's row changing.
const matches = (block: StoredBlock, where: { id?: number; userId?: number }) =>
  (where.id === undefined || block.id === where.id) &&
  (where.userId === undefined || block.userId === where.userId);

const applyIndex = (args: { where: { id?: number; userId?: number }; data: { index: number } }) => {
  const hit = stored.filter((b) => matches(b, args.where));
  for (const b of hit) b.index = args.data.index;
  return hit;
};

const reorderAs = (userId: number, homeBlocks: { id: number; index: number; userId?: number }[]) =>
  setHomeBlocksOrder({ viewer: { id: userId }, input: { userId, homeBlocks } });

const indexOf = (id: number) => stored.find((b) => b.id === id)?.index;

beforeEach(() => {
  vi.clearAllMocks();
  stored = [
    { id: 50, userId: USER_A, index: 0 },
    { id: 60, userId: USER_B, index: 0 },
  ];
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ exists: true }] as never);
  // Removal sweep and clone lookup: nothing to remove or clone in these cases.
  dbMock.dbRead.homeBlock.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.homeBlock.update.mockImplementation((async (args: never) => {
    const [hit] = applyIndex(args);
    if (!hit) throw new Error('Record to update not found.');
    return { ...hit, type: HomeBlockType.Collection };
  }) as never);
  dbMock.dbWrite.homeBlock.updateMany.mockImplementation((async (args: never) => ({
    count: applyIndex(args).length,
  })) as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (ops: unknown) =>
    Array.isArray(ops) ? Promise.all(ops) : ops) as never);
});

describe('reordering home blocks', () => {
  it("leaves another user's block where it was", async () => {
    await reorderAs(USER_A, [
      { id: 50, index: 1, userId: USER_A },
      { id: 60, index: 5, userId: USER_A },
    ]);
    expect(indexOf(60)).toBe(0);
  });

  it("moves the viewer's own block (control)", async () => {
    await reorderAs(USER_A, [{ id: 50, index: 3, userId: USER_A }]);
    expect(indexOf(50)).toBe(3);
  });
});

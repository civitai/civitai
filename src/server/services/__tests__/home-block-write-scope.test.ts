import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: async (_key: string, fetcher: () => Promise<unknown>) => fetcher(),
}));

const { deleteHomeBlockById, setHomeBlocksOrder, upsertHomeBlock } = await import(
  '~/server/services/home-block.service'
);

const USER_A = 7;
const USER_B = 8;

type StoredBlock = { id: number; userId: number; index: number };
let stored: StoredBlock[];

type Where = { id?: number | { in: number[] }; userId?: number };
// Applies each write's `where` to the stored rows the way Postgres would, so a write that is not
// scoped to its owner shows up as another user's row changing.
const matches = (block: StoredBlock, where: Where) =>
  (where.id === undefined ||
    (typeof where.id === 'number' ? block.id === where.id : where.id.in.includes(block.id))) &&
  (where.userId === undefined || block.userId === where.userId);

const notFound = () =>
  new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
    code: 'P2025',
    clientVersion: 'test',
  });

const block = (id: number) => stored.find((b) => b.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  stored = [
    { id: 50, userId: USER_A, index: 0 },
    { id: 60, userId: USER_B, index: 0 },
  ];
  dbMock.dbRead.$queryRaw.mockResolvedValue([{ exists: true }] as never);
  dbMock.dbRead.homeBlock.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.homeBlock.update.mockImplementation((async (args: {
    where: Where;
    data: { index?: number };
  }) => {
    const hit = stored.find((b) => matches(b, args.where));
    if (!hit) throw notFound();
    if (args.data.index !== undefined) hit.index = args.data.index;
    return { ...hit, type: HomeBlockType.Collection, metadata: {} };
  }) as never);
  dbMock.dbWrite.homeBlock.updateMany.mockImplementation((async (args: {
    where: Where;
    data: { index: number };
  }) => {
    const hit = stored.filter((b) => matches(b, args.where));
    for (const b of hit) b.index = args.data.index;
    return { count: hit.length };
  }) as never);
  dbMock.dbWrite.homeBlock.deleteMany.mockImplementation((async (args: { where: Where }) => {
    const before = stored.length;
    stored = stored.filter((b) => !matches(b, args.where));
    return { count: before - stored.length };
  }) as never);
  dbMock.dbWrite.homeBlock.delete.mockImplementation((async (args: { where: Where }) => {
    const hit = stored.find((b) => matches(b, args.where));
    if (!hit) throw notFound();
    stored = stored.filter((b) => b !== hit);
    return hit;
  }) as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (ops: unknown) =>
    Array.isArray(ops) ? Promise.all(ops) : ops) as never);
});

describe('saving the block order removes only the viewer’s own blocks', () => {
  // The removal sweep reads its ids already filtered by owner; the stub makes that read disagree
  // with the stored rows so the delete's own filter is what is tested.
  const sweepReturns = (ids: number[]) =>
    dbMock.dbRead.homeBlock.findMany.mockResolvedValue(
      ids.map((id) => ({
        id,
        type: HomeBlockType.Collection,
        metadata: {},
        sourceId: null,
      })) as never
    );

  it("keeps another user's block", async () => {
    sweepReturns([60]);
    await setHomeBlocksOrder({
      viewer: { id: USER_A },
      input: { userId: USER_A, homeBlocks: [{ id: 50, index: 0, userId: USER_A }] },
    });
    expect(block(60)).toBeDefined();
  });

  it("still removes the viewer's own dropped block", async () => {
    stored.push({ id: 51, userId: USER_A, index: 1 });
    sweepReturns([51]);
    await setHomeBlocksOrder({
      viewer: { id: USER_A },
      input: { userId: USER_A, homeBlocks: [{ id: 50, index: 0, userId: USER_A }] },
    });
    expect(block(51)).toBeUndefined();
    expect(block(50)).toBeDefined();
  });
});

describe('editing a home block writes only a block the editor may edit', () => {
  // The ownership check reads separately from the write; the stub makes that read disagree with
  // the stored row so the write's own filter is what is tested.
  const ownerReadReturns = (userId: number) =>
    dbMock.dbRead.homeBlock.findUnique.mockResolvedValue({ userId } as never);

  const edit = (id: number, userId: number, isModerator = false) =>
    upsertHomeBlock({
      input: {
        id,
        userId,
        isModerator,
        type: HomeBlockType.Collection,
        metadata: {},
        index: 9,
      } as never,
    });

  it("leaves another user's block unchanged", async () => {
    ownerReadReturns(USER_A);
    await expect(edit(60, USER_A)).rejects.toThrow('not authorized');
    expect(block(60)?.index).toBe(0);
  });

  it("edits the viewer's own block", async () => {
    ownerReadReturns(USER_A);
    await edit(50, USER_A);
    expect(block(50)?.index).toBe(9);
  });

  it("lets a moderator edit another user's block", async () => {
    ownerReadReturns(USER_B);
    await edit(60, USER_A, true);
    expect(block(60)?.index).toBe(9);
  });

  it('surfaces any other database error unchanged', async () => {
    ownerReadReturns(USER_A);
    const conflict = new Prisma.PrismaClientKnownRequestError('Transaction conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    dbMock.dbWrite.homeBlock.update.mockRejectedValueOnce(conflict as never);
    await expect(edit(50, USER_A)).rejects.toBe(conflict);
  });
});

describe('deleting a home block removes only a block the user may delete', () => {
  // The ownership check reads separately from the delete; the stub makes that read find the row
  // regardless of owner so the delete's own filter is what is tested.
  const ownerReadFinds = (id: number) =>
    dbMock.dbRead.homeBlock.findFirst.mockResolvedValue({ id, userId: USER_A } as never);

  const remove = (id: number, userId: number, isModerator = false) =>
    deleteHomeBlockById({ input: { id, userId, isModerator } });

  it("keeps another user's block", async () => {
    ownerReadFinds(60);
    expect(await remove(60, USER_A)).toBeNull();
    expect(block(60)).toBeDefined();
  });

  it("deletes the user's own block", async () => {
    ownerReadFinds(50);
    await remove(50, USER_A);
    expect(block(50)).toBeUndefined();
  });

  it("lets a moderator delete another user's block", async () => {
    ownerReadFinds(60);
    await remove(60, USER_A, true);
    expect(block(60)).toBeUndefined();
  });

  it('surfaces any other database error unchanged', async () => {
    ownerReadFinds(50);
    const conflict = new Prisma.PrismaClientKnownRequestError('Transaction conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    dbMock.dbWrite.homeBlock.delete.mockRejectedValueOnce(conflict as never);
    await expect(remove(50, USER_A)).rejects.toBe(conflict);
  });
});

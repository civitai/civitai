import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { addSizePreset, deleteSizePreset } from '~/server/services/generation-size-preset.service';

const read = dbMock.dbRead.generationSizePreset;
const write = dbMock.dbWrite.generationSizePreset;
const db = {
  create: write.create,
  findMany: write.findMany,
  deleteMany: write.deleteMany,
  findUniqueOrThrow: write.findUniqueOrThrow,
  findUnique: read.findUnique,
  delete: write.delete,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.findUniqueOrThrow.mockImplementation(({ where }) =>
    Promise.resolve({ id: 1, ...where.userId_width_height })
  );
});

describe('addSizePreset', () => {
  it('saves a size some model accepts as is', async () => {
    await addSizePreset({ userId: 7, width: 1216, height: 832 });
    expect(db.create).toHaveBeenCalledWith({ data: { userId: 7, width: 1216, height: 832 } });
  });

  // One list per user: a size only SD1 takes, or only the ~4 MP models, still saves.
  it.each([
    ['an SD1-only size', 384, 640],
    ['a ~4 MP size', 2048, 2048],
  ])('saves %s', async (_, width, height) => {
    await addSizePreset({ userId: 7, width, height });
    expect(db.create).toHaveBeenCalled();
  });

  // The picker only offers fitted sizes, so these are crafted requests no model takes.
  it.each([
    ['not a multiple of 32', 1000, 1000],
    ['past 2.5:1', 2048, 512],
    ['past 2048 per side', 2080, 1024],
    ['under every minimum side', 128, 128],
  ])('refuses a size %s', async (_, width, height) => {
    await expect(addSizePreset({ userId: 7, width, height })).rejects.toThrow();
    expect(db.create).not.toHaveBeenCalled();
  });

  it('treats a size already saved as saved, not an error', async () => {
    db.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })
    );
    await expect(addSizePreset({ userId: 7, width: 1216, height: 832 })).resolves.toMatchObject({
      width: 1216,
      height: 832,
    });
  });

  it('drops the oldest past twelve', async () => {
    db.findMany.mockResolvedValueOnce([{ id: 3 }, { id: 2 }]);
    await addSizePreset({ userId: 7, width: 1216, height: 832 });
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 12 }));
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [3, 2] } } });
  });
});

describe('deleteSizePreset', () => {
  it("refuses another user's saved size", async () => {
    db.findUnique.mockResolvedValueOnce({ userId: 99 });
    await expect(deleteSizePreset({ userId: 7, id: 1 })).rejects.toThrow();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('deletes your own', async () => {
    db.findUnique.mockResolvedValueOnce({ userId: 7 });
    await expect(deleteSizePreset({ userId: 7, id: 1 })).resolves.toEqual({ id: 1 });
    expect(db.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});

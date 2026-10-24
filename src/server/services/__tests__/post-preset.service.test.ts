import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { PostPresetData } from '~/server/schema/post-preset.schema';
import {
  deletePostPreset,
  getPostPresets,
  POST_PRESET_LIMIT,
  upsertPostPreset,
} from '~/server/services/post-preset.service';

const read = dbMock.dbRead.postPreset;
const write = dbMock.dbWrite.postPreset;

const data: PostPresetData = {
  resources: [],
  tools: [{ id: 3, name: 'ComfyUI' }],
  techniques: [],
  tags: ['anime'],
  titleTemplate: '{model} #{n}',
};
const row = { id: 5, name: 'Daily', data, updatedAt: new Date() };

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('db', { code, clientVersion: 'x' });

beforeEach(() => {
  vi.clearAllMocks();
  write.create.mockResolvedValue(row);
  write.update.mockResolvedValue(row);
  write.delete.mockResolvedValue({ id: 5 });
});

describe('getPostPresets', () => {
  it("reads only the caller's presets", async () => {
    read.findMany.mockResolvedValueOnce([row]);
    await expect(getPostPresets({ userId: 7 })).resolves.toEqual([row]);
    expect(read.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 7 } }));
  });
});

describe('upsertPostPreset', () => {
  it('creates under the caller', async () => {
    write.count.mockResolvedValueOnce(POST_PRESET_LIMIT - 1);
    await expect(upsertPostPreset({ userId: 7, input: { name: 'Daily', data } })).resolves.toEqual(
      row
    );
    expect(write.count).toHaveBeenCalledWith({ where: { userId: 7 } });
    expect(write.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: 7, name: 'Daily', data } })
    );
  });

  it('refuses a new preset past the cap', async () => {
    write.count.mockResolvedValueOnce(POST_PRESET_LIMIT);
    await expect(
      upsertPostPreset({ userId: 7, input: { name: 'One more', data } })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(write.create).not.toHaveBeenCalled();
  });

  it('reports a duplicate name as a conflict', async () => {
    write.create.mockRejectedValueOnce(prismaError('P2002'));
    await expect(
      upsertPostPreset({ userId: 7, input: { name: 'Daily', data } })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('updates only a preset the caller owns', async () => {
    await upsertPostPreset({ userId: 7, input: { id: 5, name: 'Renamed', data } });
    expect(write.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5, userId: 7 },
        data: { name: 'Renamed', data },
      })
    );
    expect(write.count).not.toHaveBeenCalled();
    expect(write.create).not.toHaveBeenCalled();
  });

  it("reports someone else's preset as not found", async () => {
    write.update.mockRejectedValueOnce(prismaError('P2025'));
    await expect(
      upsertPostPreset({ userId: 7, input: { id: 5, name: 'Renamed', data } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports a rename onto an existing name as a conflict', async () => {
    write.update.mockRejectedValueOnce(prismaError('P2002'));
    await expect(
      upsertPostPreset({ userId: 7, input: { id: 5, name: 'Taken', data } })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('deletePostPreset', () => {
  it('deletes only a preset the caller owns', async () => {
    await expect(deletePostPreset({ userId: 7, id: 5 })).resolves.toEqual({ id: 5 });
    expect(write.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5, userId: 7 } })
    );
  });

  it("reports someone else's preset as not found", async () => {
    write.delete.mockRejectedValueOnce(prismaError('P2025'));
    await expect(deletePostPreset({ userId: 7, id: 5 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

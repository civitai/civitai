import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { PostPresetData, UpsertPostPresetInput } from '~/server/schema/post-preset.schema';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

export const POST_PRESET_LIMIT = 20;

const presetSelect = { id: true, name: true, data: true, updatedAt: true } as const;

export type PostPreset = { id: number; name: string; data: PostPresetData; updatedAt: Date };

export async function getPostPresets({ userId }: { userId: number }): Promise<PostPreset[]> {
  const rows = await dbRead.postPreset.findMany({
    where: { userId },
    select: presetSelect,
    orderBy: { name: 'asc' },
  });
  return rows.map((row) => ({ ...row, data: row.data as PostPresetData }));
}

function isPrismaError(error: unknown, code: string) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function rethrow(error: unknown): never {
  if (isPrismaError(error, 'P2002'))
    throwConflictError('You already have a preset with this name.');
  if (isPrismaError(error, 'P2025')) throwNotFoundError('Preset not found');
  throw error;
}

export async function upsertPostPreset({
  userId,
  input,
}: {
  userId: number;
  input: UpsertPostPresetInput;
}): Promise<PostPreset> {
  const data = input.data as Prisma.InputJsonValue;
  try {
    if (input.id) {
      const row = await dbWrite.postPreset.update({
        where: { id: input.id, userId },
        data: { name: input.name, data },
        select: presetSelect,
      });
      return { ...row, data: row.data as PostPresetData };
    }
    const count = await dbWrite.postPreset.count({ where: { userId } });
    if (count >= POST_PRESET_LIMIT)
      throw throwBadRequestError(
        `You can keep up to ${POST_PRESET_LIMIT} presets. Delete or overwrite one first.`
      );
    const row = await dbWrite.postPreset.create({
      data: { userId, name: input.name, data },
      select: presetSelect,
    });
    return { ...row, data: row.data as PostPresetData };
  } catch (error) {
    return rethrow(error);
  }
}

export async function deletePostPreset({ userId, id }: { userId: number; id: number }) {
  try {
    await dbWrite.postPreset.delete({ where: { id, userId }, select: { id: true } });
  } catch (error) {
    rethrow(error);
  }
  return { id };
}

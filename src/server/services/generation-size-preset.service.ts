import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  MAX_SIZE_PRESETS,
  type AddSizePresetInput,
} from '~/server/schema/generation-size-preset.schema';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { allCustomDimensionLimits } from '~/shared/constants/generation.constants';
import { fitCustomDimensions } from '~/utils/aspect-ratio-helpers';

const presetSelect = { id: true, width: true, height: true } as const;

/**
 * Every size the user saved, newest first — one fetch per session. At most
 * twelve (`add` enforces it); the client decides which fit the current model.
 */
export function getSizePresets({ userId }: { userId: number }) {
  return dbRead.generationSizePreset.findMany({
    where: { userId },
    select: presetSelect,
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Save a size. Some model's limits must accept it unchanged — the picker only
 * offers fitted sizes, so anything else is a crafted request (and nothing past the
 * 4 MP ceiling ever is). Saving one already saved returns it; past the cap, the
 * oldest is dropped.
 */
export async function addSizePreset({
  userId,
  width,
  height,
}: AddSizePresetInput & { userId: number }) {
  const acceptedSomewhere = allCustomDimensionLimits.some((limits) => {
    const fit = fitCustomDimensions({ width, height }, limits);
    return fit?.width === width && fit.height === height;
  });
  if (!acceptedSomewhere)
    throw throwBadRequestError('That size is outside the limits for every model.');

  try {
    await dbWrite.generationSizePreset.create({ data: { userId, width, height } });
  } catch (error) {
    const duplicate =
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
    if (!duplicate) throw error;
  }

  const overflow = await dbWrite.generationSizePreset.findMany({
    where: { userId },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
    skip: MAX_SIZE_PRESETS,
  });
  if (overflow.length)
    await dbWrite.generationSizePreset.deleteMany({
      where: { id: { in: overflow.map((p) => p.id) } },
    });

  return dbWrite.generationSizePreset.findUniqueOrThrow({
    where: { userId_width_height: { userId, width, height } },
    select: presetSelect,
  });
}

export async function deleteSizePreset({ userId, id }: { userId: number; id: number }) {
  const existing = await dbRead.generationSizePreset.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!existing) throw throwNotFoundError('Saved size not found');
  if (existing.userId !== userId) throw throwAuthorizationError();

  await dbWrite.generationSizePreset.delete({ where: { id } });
  return { id };
}

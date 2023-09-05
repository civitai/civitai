import { Prisma } from '@prisma/client';
import { dbRead } from '../db/client';
import { GetFilesByEntitySchema } from '~/server/schema/file.schema';

export const getFilesByEntity = async ({ id, type }: GetFilesByEntitySchema) => {
  const files = await dbRead.file.findMany({
    where: { entityId: id, entityType: type },
    select: { id: true, name: true, url: true, sizeKB: true, metadata: true },
  });

  return files.map(({ metadata, ...file }) => ({
    ...file,
    metadata: (metadata as Prisma.JsonObject) ?? {},
  }));
};

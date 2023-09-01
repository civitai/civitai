import { dbRead } from '../db/client';
import { GetFilesByEntitySchema } from '~/server/schema/file.schema';

export const getFilesByEntity = ({ id, type }: GetFilesByEntitySchema) => {
  return dbRead.file.findMany({
    where: { entityId: id, entityType: type },
    select: { id: true, name: true, url: true, sizeKB: true, metadata: true },
  });
};

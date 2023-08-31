import { dbRead } from '../db/client';
import { FileEntityType } from '../schema/file.schema';

// TODO.file: create the file.schema.ts file with zod schema validation
export const getFilesByEntity = ({ id, type }: { id: number; type: FileEntityType }) => {
  return dbRead.file.findMany({
    where: { entityId: id, entityType: type },
    select: { id: true, name: true, url: true, sizeKB: true, metadata: true },
  });
};

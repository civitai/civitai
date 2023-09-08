import { Prisma } from '@prisma/client';
import { dbRead } from '../db/client';
import { BaseFileSchema, GetFilesByEntitySchema } from '~/server/schema/file.schema';
import { isDefined } from '~/utils/type-guards';

export const getFilesByEntity = async ({ id, ids, type }: GetFilesByEntitySchema) => {
  if (!id && (!ids || ids.lenght === 0)) {
    return [];
  }

  const files = await dbRead.file.findMany({
    where: { entityId: ids ? { in: ids } : id, entityType: type },
    select: { id: true, name: true, url: true, sizeKB: true, metadata: true, entityId: true },
  });

  return files.map(({ metadata, ...file }) => ({
    ...file,
    metadata: (metadata as Prisma.JsonObject) ?? {},
  }));
};

export const updateEntityFiles = async ({
  tx,
  entityId,
  entityType,
  files,
}: {
  tx: Prisma.TransactionClient;
  entityId: number;
  entityType: string;
  files: BaseFileSchema[];
}) => {
  const updatedFiles = files.filter((f) => f.id);

  if (updatedFiles.length > 0) {
    await Promise.all(
      updatedFiles.map((file) => {
        tx.file.update({
          where: { id: file.id },
          data: {
            ...file,
          },
        });
      })
    );
  }

  // Delete any files that were removed.
  const deletedFileIds = files.map((x) => x.id).filter(isDefined);

  if (deletedFileIds.length > 0) {
    await tx.file.deleteMany({
      where: {
        entityId,
        entityType,
        id: { notIn: files.map((x) => x.id).filter(isDefined) },
      },
    });
  }

  const newFiles = files.filter((x) => !x.id);

  if (newFiles.length > 0) {
    // Create any new files.
    await tx.file.createMany({
      data: newFiles.map((file) => ({
        ...file,
        entityId,
        entityType,
      })),
    });
  }
};

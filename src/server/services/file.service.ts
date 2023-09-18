import { Prisma } from '@prisma/client';
import { dbRead } from '../db/client';
import { BaseFileSchema, GetFilesByEntitySchema } from '~/server/schema/file.schema';
import { isDefined } from '~/utils/type-guards';
import { getBountyEntryFilteredFiles } from '~/server/services/bountyEntry.service';

export const getFilesByEntity = async ({ id, ids, type }: GetFilesByEntitySchema) => {
  if (!id && (!ids || ids.length === 0)) {
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

export const getFileWithPermission = async ({
  fileId,
  userId,
}: {
  fileId: number;
  userId?: number;
}) => {
  const file = await dbRead.file.findUnique({
    where: { id: fileId },
    select: { url: true, name: true, metadata: true, entityId: true, entityType: true },
  });

  if (!file) return null;

  switch (file.entityType) {
    case 'BountyEntry': {
      const bountyEntryFiles = await getBountyEntryFilteredFiles({ id: file.entityId, userId });
      if (!bountyEntryFiles.some((x) => x.id === fileId && !!x.url)) {
        return null;
      }

      return file;
    }
    default:
      return file;
  }
};

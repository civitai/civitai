import { dbRead, dbWrite } from '~/server/db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';

export const entityExists = async ({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: number;
}) => {
  // always use findUniqueOrThrow. This will throw an error if the entity does not exist.

  if (entityType === 'Model') {
    const modelFindArgs = { where: { id: entityId } } as const;
    await dbRead.model
      .findUniqueOrThrow(modelFindArgs)
      .catch(() => {
        dbReadFallbackCounter.inc({ entity: 'model', caller: 'entityExists' });
        return dbWrite.model.findUniqueOrThrow(modelFindArgs);
      });
  }

  if (entityType === 'Image') {
    const imageFindArgs = { where: { id: entityId } } as const;
    await dbRead.image
      .findUniqueOrThrow(imageFindArgs)
      .catch(() => {
        dbReadFallbackCounter.inc({ entity: 'image', caller: 'entityExists' });
        return dbWrite.image.findUniqueOrThrow(imageFindArgs);
      });
  }

  // TODO: Add more entities as needed here.
};

export const isImageOwner = async ({
  userId,
  imageId,
  isModerator,
  allowMods = true,
}: {
  userId: number;
  imageId: number;
  isModerator?: boolean;
  allowMods?: boolean;
}) => {
  if (allowMods) {
    if (isModerator === undefined) {
      const user = await dbRead.user.findUnique({
        select: { isModerator: true },
        where: { id: userId },
      });
      isModerator = user?.isModerator ?? false;
    }

    if (isModerator) return true;
  }

  const img = await dbRead.image.findUnique({
    select: { userId: true },
    where: { id: imageId },
  });

  if (!img) return false;
  return img.userId === userId;
};

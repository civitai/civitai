import { dbRead } from '~/server/db/client';

export const entityExists = async ({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: number;
}) => {
  // always use findUniqueOrThrow. This will throw an error if the entity does not exist.

  if (entityType === 'Model') {
    await dbRead.model.findUniqueOrThrow({
      where: { id: entityId },
    });
  }

  if (entityType === 'Image') {
    await dbRead.image.findUniqueOrThrow({
      where: { id: entityId },
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

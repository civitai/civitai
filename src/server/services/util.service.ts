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

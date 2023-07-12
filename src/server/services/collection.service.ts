import { dbWrite, dbRead } from '~/server/db/client';
import { AddCollectionItemInput, UpsertCollectionInput } from '~/server/schema/collection.schema';
import { SessionUser } from 'next-auth';
import {
  CollectionContributorPermission,
  CollectionWriteConfiguration,
  Prisma,
} from '@prisma/client';
import { throwNotFoundError } from '~/server/utils/errorHandling';

export const getUserCollectionsWithPermissions = <
  TSelect extends Prisma.CollectionSelect = Prisma.CollectionSelect
>({
  user,
  permissions,
  select,
}: {
  user: SessionUser;
  permissions: CollectionContributorPermission[];
  select: TSelect;
}) => {
  return dbRead.collection.findMany({
    where: {
      OR: [
        {
          write: CollectionWriteConfiguration.Public,
        },
        { userId: user.id },
        {
          contributors: {
            some: {
              userId: user.id,
              permissions: {
                hasSome: permissions,
              },
            },
          },
        },
      ],
    },
    select,
  });
};
export const addCollectionItems = async ({
  user,
  input: { collectionIds, ...input },
}: {
  user: SessionUser;
  input: AddCollectionItemInput;
}) => {
  const data: Prisma.CollectionItemCreateManyInput[] = collectionIds.map((collectionId) => ({
    ...input,
    addedById: user.id,
    collectionId,
  }));

  return dbWrite.collectionItem.createMany({
    data,
  });
};

export const upsertCollection = async ({
  input,
  user,
}: {
  input: UpsertCollectionInput;
  user: SessionUser;
}) => {
  const { id, name, description, coverImage, read, write, ...collectionItem } = input;

  if (id) {
    const updated = await dbWrite.collection.update({
      where: { id },
      data: {
        name,
        description,
        coverImage,
        read,
        write,
      },
    });

    if (!updated) throw throwNotFoundError(`No collection with id ${id}`);
    return updated;
  }

  return dbWrite.collection.create({
    data: {
      name,
      description,
      coverImage,
      read,
      write,
      userId: user.id,
      contributors: {
        create: {
          userId: user.id,
          permissions: [CollectionContributorPermission.MANAGE],
        },
      },
      items: { create: { ...collectionItem, addedById: user.id } },
    },
  });
};

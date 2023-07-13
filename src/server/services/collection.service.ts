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
export const saveItemInCollections = async ({
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
  const transactions = [dbWrite.collectionItem.createMany({ data })];

  // Determine which items need to be removed
  const itemsToRemove = await dbRead.collectionItem.findMany({
    where: { ...input, addedById: user.id, collectionId: { notIn: collectionIds } },
    select: { id: true },
  });
  // if we have items to remove, add a deleteMany mutation to the transaction
  if (itemsToRemove.length)
    transactions.push(
      dbWrite.collectionItem.deleteMany({ where: { id: { in: itemsToRemove.map((i) => i.id) } } })
    );

  return dbWrite.$transaction(transactions);
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
          permissions: [
            CollectionContributorPermission.MANAGE,
            CollectionContributorPermission.ADD,
            CollectionContributorPermission.VIEW,
          ],
        },
      },
      items: { create: { ...collectionItem, addedById: user.id } },
    },
  });
};

import { dbWrite, dbRead } from '~/server/db/client';
import {
  AddCollectionItemInput,
  GetUserCollectionsByItemSchema,
  UpsertCollectionInput,
} from '~/server/schema/collection.schema';
import { SessionUser } from 'next-auth';
import {
  CollectionContributorPermission,
  CollectionReadConfiguration,
  CollectionWriteConfiguration,
  Prisma,
} from '@prisma/client';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { GetByIdInput } from '~/server/schema/base.schema';

export const getUserCollectionPermissionsById = async ({
  user,
  collectionId,
}: {
  user?: SessionUser;
  collectionId: number;
}) => {
  const permissions = {
    read: false,
    write: false,
    manage: false,
  };

  const collection = await dbRead.collection.findFirst({
    select: {
      id: true,
      read: true,
      write: true,
      contributors: user
        ? {
            select: {
              permissions: true,
            },
            where: {
              user: {
                id: user.id,
              },
            },
          }
        : false,
    },
    where: {
      id: collectionId,
    },
  });

  if (!collection) {
    return permissions;
  }

  if (collection.read === CollectionReadConfiguration.Public) {
    permissions.read = true;
  }

  if (collection.write === CollectionWriteConfiguration.Public) {
    permissions.write = true;
  }

  if (!user) {
    return permissions;
  }

  const [contributorItem] = collection.contributors;

  if (!contributorItem) {
    return permissions;
  }

  if (contributorItem.permissions.includes(CollectionContributorPermission.VIEW)) {
    permissions.read = true;
  }

  if (contributorItem.permissions.includes(CollectionContributorPermission.ADD)) {
    permissions.write = true;
  }

  if (contributorItem.permissions.includes(CollectionContributorPermission.MANAGE)) {
    permissions.manage = true;
  }

  return permissions;
};
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

export const getUserCollectionsByItem = async ({
  input,
  user,
}: {
  input: GetUserCollectionsByItemSchema;
  user: SessionUser;
}) => {
  const { modelId, imageId, articleId, postId } = input;

  const userCollections = await getUserCollectionsWithPermissions({
    user,
    permissions: [CollectionContributorPermission.ADD, CollectionContributorPermission.MANAGE],
    select: { id: true },
  });

  if (userCollections.length === 0) return [];

  return dbRead.collection.findMany({
    where: {
      id: { in: userCollections.map((c) => c.id) },
      items: {
        some: {
          modelId,
          imageId,
          articleId,
          postId,
        },
      },
    },
    select: { id: true, name: true, read: true, write: true },
  });
};

export const deleteCollectionById = async ({ id, user }: GetByIdInput & { user: SessionUser }) => {
  try {
    const collection = await dbRead.collection.findFirst({
      // Confirm the collection belongs to the user:
      where: { id, userId: user.id },
      select: { id: true },
    });

    if (!collection) {
      return null;
    }

    return await dbWrite.collection.delete({ where: { id } });
  } catch {
    // Ignore errors
  }
};

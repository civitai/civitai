import { dbWrite, dbRead } from '~/server/db/client';
import { AddCollectionItemInput } from '~/server/schema/collection.schema';
import { SessionUser } from 'next-auth';
import {
  CollectionContributorPermission,
  CollectionWriteConfiguration,
  Prisma,
} from '@prisma/client';

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
        { userId: user?.id },
        {
          contributors: {
            some: {
              userId: user?.id,
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

import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import {
  CollectionContributorPermission,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import type { CollectionItemStatus } from '~/shared/utils/prisma/enums';

export type CollectionContributorPermissionFlags = {
  collectionId: number;
  read: boolean;
  write: boolean;
  writeReview: boolean;
  manage: boolean;
  follow: boolean;
  isContributor: boolean;
  isOwner: boolean;
  followPermissions: CollectionContributorPermission[];
  publicCollection: boolean;
  collectionType: CollectionType | null;
  collectionMode: CollectionMode | null;
};

export const getUserCollectionPermissionsById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & {
  userId?: number;
  isModerator?: boolean;
}) => {
  const permissions: CollectionContributorPermissionFlags = {
    collectionId: id,
    read: false,
    write: false,
    writeReview: false,
    manage: false,
    follow: false,
    isContributor: false,
    isOwner: false,
    publicCollection: false,
    followPermissions: [],
    collectionType: null,
    collectionMode: null,
  };

  const collection = await dbRead.collection.findFirst({
    select: {
      id: true,
      read: true,
      write: true,
      userId: true,
      type: true,
      mode: true,
      contributors: userId
        ? {
            select: {
              permissions: true,
            },
            where: {
              user: {
                id: userId,
              },
            },
          }
        : false,
    },
    where: {
      id,
    },
  });

  if (!collection) {
    return permissions;
  }

  permissions.collectionType = collection.type;
  permissions.collectionMode = collection.mode;

  if (
    collection.read === CollectionReadConfiguration.Public ||
    collection.read === CollectionReadConfiguration.Unlisted
  ) {
    permissions.read = true;
    permissions.follow = true;
    permissions.followPermissions.push(CollectionContributorPermission.VIEW);
    permissions.publicCollection = true;
  }

  if (collection.write === CollectionWriteConfiguration.Public) {
    // Follow will make it so that they can see the collection in their feed.
    permissions.follow = true;
    // Means that the users will be able to add stuff to the collection without following. It will follow automatically.
    permissions.write = true;
    permissions.followPermissions.push(CollectionContributorPermission.ADD);
  }

  if (collection.write === CollectionWriteConfiguration.Review) {
    // Follow will make it so that they can see the collection in their feed.
    permissions.follow = true;

    // Means that the users will be able to add stuff to the collection without following. It will follow automatically.
    permissions.writeReview = true;
    permissions.followPermissions.push(CollectionContributorPermission.ADD_REVIEW);
  }

  if (!userId) {
    return permissions;
  }

  if (userId === collection.userId) {
    permissions.isOwner = true;
    permissions.manage = true;
    permissions.read = true;
    permissions.write = true;
  }

  if (isModerator && !permissions.isOwner) {
    permissions.manage = true;
    permissions.read = true;
    // Makes sure that moderators' stuff still needs to be reviewed.
    permissions.write = collection.write === CollectionWriteConfiguration.Public;
    permissions.writeReview = collection.write === CollectionWriteConfiguration.Review;
  }

  const [contributorItem] = collection.contributors;

  if (!contributorItem || permissions.isOwner) {
    return permissions;
  }

  permissions.isContributor = true;

  if (contributorItem.permissions.includes(CollectionContributorPermission.VIEW)) {
    permissions.read = true;
  }

  if (contributorItem.permissions.includes(CollectionContributorPermission.ADD)) {
    permissions.write = true;
  }

  if (contributorItem.permissions.includes(CollectionContributorPermission.ADD_REVIEW)) {
    permissions.writeReview = true;
  }

  if (contributorItem.permissions.includes(CollectionContributorPermission.MANAGE)) {
    permissions.manage = true;
  }

  return permissions;
};

export const getAvailableCollectionItemsFilterForUser = ({
  statuses,
  permissions,
  userId,
}: {
  statuses?: CollectionItemStatus[];
  permissions: CollectionContributorPermissionFlags;
  userId?: number;
}) => {
  const rawAND: Prisma.Sql[] = [];
  const AND: Prisma.Enumerable<Prisma.CollectionItemWhereInput> = [];

  // A user with relevant permissions can filter & manage these permissions
  if ((permissions.manage || permissions.isOwner) && statuses) {
    AND.push({ status: { in: statuses } });
    rawAND.push(
      Prisma.sql`ci."status" IN (${Prisma.raw(
        statuses.map((s) => `'${s}'::"CollectionItemStatus"`).join(', ')
      )})`
    );

    return {
      AND,
      rawAND,
    };
  }

  if (userId) {
    AND.push({
      OR: [
        { status: 'ACCEPTED' as CollectionItemStatus },
        { AND: [{ status: 'REVIEW' as CollectionItemStatus }, { addedById: userId }] },
      ],
    });

    rawAND.push(
      Prisma.sql`(ci."status" = 'ACCEPTED'::"CollectionItemStatus" OR (ci."status" = 'REVIEW'::"CollectionItemStatus" AND ci."addedById" = ${userId}))`
    );
  } else {
    AND.push({ status: 'ACCEPTED' as CollectionItemStatus });
    rawAND.push(Prisma.sql`ci."status" = 'ACCEPTED'::"CollectionItemStatus"`);
  }

  return { AND, rawAND };
};

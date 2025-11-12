import { Prisma } from '@prisma/client';
import { ImageSort } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type {
  CosmeticShopItemMeta,
  GetAllCosmeticShopSections,
  GetPaginatedCosmeticShopItemInput,
  GetPreviewImagesInput,
  GetShopInput,
  PurchaseCosmeticShopItemInput,
  UpdateCosmeticShopSectionsOrderInput,
  UpsertCosmeticInput,
  UpsertCosmeticShopItemInput,
  UpsertCosmeticShopSectionInput,
} from '~/server/schema/cosmetic-shop.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { cosmeticShopItemSelect } from '~/server/selectors/cosmetic-shop.selector';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { createEntityImages, getAllImages } from '~/server/services/image.service';
import { withRetries } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import {
  CollectionType,
  CosmeticType,
  MediaType,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

export const getShopItemById = async ({ id }: GetByIdInput) => {
  return dbRead.cosmeticShopItem.findUniqueOrThrow({
    where: {
      id,
    },
    select: cosmeticShopItemSelect,
  });
};

export const getPaginatedCosmeticShopItems = async (input: GetPaginatedCosmeticShopItemInput) => {
  const { limit = DEFAULT_PAGE_SIZE, page } = input || {};
  const { take, skip } = getPagination(limit, page);

  const where: Prisma.CosmeticShopItemFindManyArgs['where'] = {};
  const cosmeticWhere: Prisma.CosmeticFindManyArgs['where'] = {};

  if (input.name) cosmeticWhere.name = { contains: input.name, mode: 'insensitive' };
  if (input.types && input.types.length) cosmeticWhere.type = { in: input.types };

  if (Object.keys(cosmeticWhere).length > 0) where.cosmetic = cosmeticWhere;

  const items = await dbRead.cosmeticShopItem.findMany({
    where,
    take,
    skip,
    select: cosmeticShopItemSelect,
    orderBy: { createdAt: 'desc' },
  });

  const count = await dbRead.cosmeticShopItem.count({ where });

  return getPagingData({ items, count: (count as number) ?? 0 }, limit, page);
};

export const upsertCosmetic = async (input: UpsertCosmeticInput) => {
  const { id, videoUrl } = input;

  if (!id) {
    throw new Error('ID is required to update the video URL');
  }

  try {
    const result = await dbWrite.cosmetic.update({
      where: { id },
      data: { videoUrl },
    });
    return result;
  } catch (error) {
    throw new Error('Failed to update cosmetic');
  }
};

export const upsertCosmeticShopItem = async ({
  userId,
  availableQuantity,
  availableTo,
  availableFrom,
  id,
  archived,
  videoUrl,
  ...cosmeticShopItem
}: UpsertCosmeticShopItemInput & { userId: number }) => {
  const existingItem = id
    ? await dbRead.cosmeticShopItem.findUnique({
        where: { id },
        select: {
          id: true,
          _count: {
            select: {
              purchases: true,
            },
          },
        },
      })
    : undefined;

  if (availableTo && availableFrom && availableTo < availableFrom) {
    throw new Error('Available to date cannot be before available from date');
  }

  if (
    existingItem &&
    availableQuantity &&
    availableQuantity !== null &&
    availableQuantity < existingItem?._count.purchases
  ) {
    throw new Error('Cannot set available quantity to less than the amount of purchases');
  }

  const data = {
    ...cosmeticShopItem,
    availableQuantity,
    availableTo,
    availableFrom,
    archivedAt: archived ? new Date() : null,
  };

  const item = id
    ? await dbWrite.cosmeticShopItem.update({
        where: { id },
        data,
        select: cosmeticShopItemSelect,
      })
    : await dbWrite.cosmeticShopItem.create({
        data: {
          ...data,
          addedById: userId,
          meta: {
            ...(cosmeticShopItem.meta ?? {}),
            purchases: 0,
          },
        },
        select: cosmeticShopItemSelect,
      });

  if (videoUrl) {
    await upsertCosmetic({
      id: item.cosmeticId,
      videoUrl,
    });
  }

  return item;
};

export const getShopSections = async (input: GetAllCosmeticShopSections) => {
  const where: Prisma.CosmeticShopSectionFindManyArgs['where'] = {};

  if (input.title) {
    where.title = { contains: input.title, mode: 'insensitive' };
  }

  if (input.withItems) {
    where.items = {
      some: {},
    };
  }

  const sections = await dbRead.cosmeticShopSection.findMany({
    select: {
      id: true,
      title: true,
      description: true,
      placement: true,
      meta: true,
      published: true,
      image: {
        select: imageSelect,
      },
      _count: {
        select: {
          items: true,
        },
      },
    },
    orderBy: {
      placement: 'asc',
    },
  });

  return sections.map((section) => ({
    ...section,
    image: !!section.image
      ? {
          ...section.image,
          meta: section.image.meta as ImageMetaProps,
          metadata: section.image.metadata as MixedObject,
        }
      : section.image,
  }));
};

export const getSectionById = async ({ id }: GetByIdInput) => {
  const section = await dbRead.cosmeticShopSection.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      title: true,
      description: true,
      placement: true,
      image: {
        select: imageSelect,
      },
      published: true,
      meta: true,
      items: {
        select: {
          shopItem: {
            select: cosmeticShopItemSelect,
          },
        },
      },
    },
  });

  return {
    ...section,
    image: !!section.image
      ? {
          ...section.image,
          meta: section.image.meta as ImageMetaProps,
          metadata: section.image.metadata as MixedObject,
        }
      : section.image,
  };
};

export const upsertCosmeticShopSection = async ({
  userId,
  id,
  items,
  image, // TODO
  ...cosmeticShopSection
}: UpsertCosmeticShopSectionInput & { userId: number }) => {
  const shouldCreateImage = image && !image.id;
  const [imageRecord] = shouldCreateImage
    ? await createEntityImages({
        userId,
        images: [image],
      })
    : [];

  if (!image && !id) {
    throw new Error('Image is required to create a new section');
  }

  if (id) {
    await dbWrite.cosmeticShopSection.update({
      where: { id },
      data: {
        ...cosmeticShopSection,
        imageId:
          image === null ? null : image === undefined ? undefined : image?.id ?? imageRecord?.id,
      },
    });
  } else {
    const section = await dbWrite.cosmeticShopSection.create({
      data: {
        ...cosmeticShopSection,
        imageId: image?.id ?? imageRecord?.id,
        placement: cosmeticShopSection.placement ?? 0,
      },
    });

    id = section.id;
  }

  if (items !== undefined && id) {
    // Delete all items:
    await dbWrite.cosmeticShopSectionItem.deleteMany({
      where: {
        shopSectionId: id,
        shopItemId: items.length
          ? {
              notIn: items.map((itemId) => itemId),
            }
          : // Undefined deletes 'em all
            undefined,
      },
    });

    // Recreate them:
    if (items.length > 0 && !!id) {
      const data = items.map((itemId, index) => ({
        shopSectionId: id as number,
        shopItemId: itemId,
        index,
      }));

      await dbWrite.$executeRaw`
        INSERT INTO "CosmeticShopSectionItem" ("shopSectionId", "shopItemId", "index")
        VALUES ${Prisma.join(
          data.map(
            ({ shopSectionId, shopItemId, index }) =>
              Prisma.sql`(${shopSectionId}, ${shopItemId}, ${index})`
          )
        )}
        ON CONFLICT ("shopSectionId", "shopItemId") DO UPDATE SET "index" = EXCLUDED."index"
      `;
    }
  }

  return getSectionById({ id });
};

export const deleteCosmeticShopItem = async ({ id }: GetByIdInput) => {
  const item = await dbRead.cosmeticShopItem.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      _count: {
        select: {
          purchases: true,
        },
      },
    },
  });

  if (item._count.purchases > 0) {
    throw new Error('Cannot delete item with purchases. Please mark it as archived instead.');
  }

  return dbWrite.cosmeticShopItem.delete({
    where: { id },
  });
};

export const deleteCosmeticShopSection = async ({ id }: GetByIdInput) => {
  return dbWrite.cosmeticShopSection.delete({
    where: { id },
  });
};

export const reorderCosmeticShopSections = async ({
  sortedSectionIds,
}: UpdateCosmeticShopSectionsOrderInput) => {
  await dbWrite.$queryRaw`
    UPDATE "CosmeticShopSection" AS "css"
    SET "placement" = "idx"
    FROM (SELECT "id", "idx" FROM UNNEST(${sortedSectionIds}) WITH ORDINALITY AS t("id", "idx")) AS "t"
    WHERE "css"."id" = "t"."id"
  `;

  return true;
};

export const getShopSectionsWithItems = async ({
  isModerator,
  cosmeticTypes,
  sectionId,
}: { isModerator?: boolean } & GetShopInput = {}) => {
  const sections = await dbRead.cosmeticShopSection.findMany({
    select: {
      id: true,
      title: true,
      description: true,
      placement: true,
      meta: true,
      image: {
        select: imageSelect,
      },
      _count: {
        select: {
          items: true,
        },
      },
      items: {
        select: {
          createdAt: true,
          shopItem: {
            select: cosmeticShopItemSelect,
          },
        },
        where: {
          shopItem: {
            cosmetic: (cosmeticTypes?.length ?? 0) > 0 ? { type: { in: cosmeticTypes } } : {},
            archivedAt: null,
            OR: isModerator
              ? undefined
              : [{ availableTo: { gte: new Date() } }, { availableTo: null }],
          },
        },
        orderBy: { index: 'asc' },
      },
    },
    where: {
      items: {
        some: {},
      },
      published: true,
      ...(sectionId ? { id: sectionId } : undefined),
      // id: sectionId ? { equals: sectionId } : undefined,
    },
    orderBy: {
      placement: 'asc',
    },
  });

  return (
    sections
      // Ensures we don't return empty sections
      .filter((s) => s.items.length > 0)
      .map((section) => ({
        ...section,
        image: !!section.image
          ? {
              ...section.image,
              meta: section.image.meta as ImageMetaProps,
              metadata: section.image.metadata as MixedObject,
            }
          : section.image,
      }))
  );
};

export const purchaseCosmeticShopItem = async ({
  userId,
  shopItemId,
  buzzType = 'yellow',
}: PurchaseCosmeticShopItemInput & {
  userId: number;
  buzzType?: BuzzSpendType;
}) => {
  const shopItem = await dbRead.cosmeticShopItem.findUnique({
    where: { id: shopItemId },
    select: {
      id: true,
      cosmeticId: true,
      availableQuantity: true,
      availableFrom: true,
      availableTo: true,
      unitAmount: true,
      title: true,
      meta: true,
      cosmetic: {
        select: {
          type: true,
        },
      },
      _count: {
        select: {
          purchases: true,
        },
      },
    },
  });

  const shopItemMeta = (shopItem?.meta ?? {}) as CosmeticShopItemMeta;

  if (!shopItem) {
    throw new Error('Cosmetic not found');
  }

  if (
    shopItem.availableQuantity !== null &&
    shopItem._count.purchases >= shopItem.availableQuantity
  ) {
    if (shopItemMeta.purchases !== shopItem._count.purchases) {
      // Update meta with new amount:
      await dbWrite.cosmeticShopItem.update({
        where: { id: shopItemId },
        data: {
          meta: {
            ...shopItemMeta,
            purchases: shopItem._count.purchases,
          },
        },
      });
    }
    throw new Error('Cosmetic is out of stock');
  }

  if (shopItem.availableFrom && shopItem.availableFrom > new Date()) {
    throw new Error('Cosmetic is not available yet');
  }

  if (shopItem.availableTo && shopItem.availableTo < new Date()) {
    throw new Error('Cosmetic is no longer available');
  }

  const onlySupportsSinglePurchase =
    shopItem.cosmetic.type == CosmeticType.Badge ||
    shopItem.cosmetic.type == CosmeticType.NamePlate ||
    shopItem.cosmetic.type == CosmeticType.ProfileBackground ||
    shopItem.cosmetic.type == CosmeticType.ProfileDecoration;

  if (onlySupportsSinglePurchase) {
    // Confirm the user doesn't own it already:
    const userCosmetic = await dbWrite.userCosmetic.findFirst({
      where: {
        userId,
        cosmeticId: shopItem.cosmeticId,
      },
    });

    if (userCosmetic) {
      throw new Error('You already own this cosmetic');
    }
  }

  const meta = (shopItem.meta ?? {}) as CosmeticShopItemMeta;

  // Confirms user has enough buzz:
  const transaction = await createBuzzTransaction({
    fromAccountId: userId,
    // Can use a combination of all these accounts:
    fromAccountType: buzzType,
    toAccountId: 0, // bank
    amount: shopItem.unitAmount,
    type: TransactionType.Purchase,
    description: `Cosmetic purchase - ${shopItem.title}`,
  });

  const transactionId = transaction.transactionId;
  if (!transactionId) {
    throw new Error('There was an error creating the transaction');
  }

  try {
    const data = await dbWrite.$transaction(async (tx) => {
      // Create purchase:
      await tx.userCosmeticShopPurchases.create({
        data: {
          userId,
          cosmeticId: shopItem.cosmeticId,
          shopItemId,
          unitAmount: shopItem.unitAmount,
          buzzTransactionId: transactionId,
          refunded: false,
        },
      });

      // Create cosmetic:
      const userCosmetic = await tx.userCosmetic.create({
        data: {
          userId,
          cosmeticId: shopItem.cosmeticId,
          claimKey: transactionId,
        },
      });

      // Update the cosmetic with the new amount:
      await dbWrite.cosmeticShopItem.update({
        where: { id: shopItemId },
        data: {
          meta: {
            ...(shopItemMeta ?? {}),
            purchases: (shopItemMeta?.purchases ?? 0) + 1,
          },
        },
      });

      return userCosmetic;
    });

    try {
      await withRetries(async () => {
        // We do this last mainly because we don't want to fail the purchase if this fails.
        // We can divide the funds later if needed.
        const paidToUsers: number[] = meta?.paidToUserIds ?? [];
        if (paidToUsers.length > 0) {
          // distribute the buzz to these users:
          const amountPerUser = Math.floor(shopItem.unitAmount / paidToUsers.length);

          await Promise.all(
            paidToUsers.map((paidToUserId) =>
              // TODO.RedSplit: In the future, we might (?) want to use a different type of transaction here.
              createBuzzTransaction({
                fromAccountId: 0,
                toAccountId: paidToUserId,
                amount: amountPerUser,
                type: TransactionType.Sell,
                description: `A user has purchased your cosmetic - ${shopItem.title}`,
                externalTransactionId: transactionId,
                details: {
                  purchasedBy: userId,
                  originalAmount: shopItem.unitAmount,
                },
              })
            )
          );
        }
      }, 3);
    } catch (e) {
      // We will NOT stop the user interaction for this.
      logToAxiom({
        level: 'error',
        message: 'Failed to distribute funds',
        data: {
          shopItemId,
          userId,
          transactionId,
          error: e,
        },
      });
    }

    return data;
  } catch (error) {
    await refundTransaction(transactionId, `Failed to purchase cosmetic - ${shopItem.title}`);

    throw new Error('Failed to purchase cosmetic');
  }
};

export const getUserPreviewImagesForCosmetics = async ({
  userId,
  browsingLevel,
  features,
  limit = 5,
}: {
  userId: number;
  features: FeatureAccess;
} & GetPreviewImagesInput) => {
  const userImages = await getAllImages({
    userId,
    limit: 2 * limit,
    sort: ImageSort.MostReactions,
    browsingLevel,
    include: [],
    period: MetricTimeframe.AllTime,
    periodMode: 'stats',
    types: [MediaType.image],
    withMeta: false,
    useLogicalReplica: features.logicalReplica,
  });

  const images = userImages.items.slice(0, limit);

  if (images.length <= limit) {
    // Get some of the civit ones:
    const featuredImagesCollection = await dbRead.collection.findFirst({
      where: {
        userId: -1, // Civit
        type: CollectionType.Image,
        name: {
          contains: 'Featured',
        },
        mode: null,
      },
    });

    if (!featuredImagesCollection) {
      return images;
    }

    const collectionImages = await getAllImages({
      collectionId: featuredImagesCollection.id,
      limit,
      browsingLevel,
      include: [],
      period: MetricTimeframe.AllTime,
      periodMode: 'stats',
      sort: ImageSort.Newest,
      types: [MediaType.image],
      withMeta: false,
      useLogicalReplica: features.logicalReplica,
    });

    return [...images, ...collectionImages.items].slice(0, limit);
  }

  return images;
};

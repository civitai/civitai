import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllCosmeticShopSections,
  GetPaginatedCosmeticShopItemInput,
  UpsertCosmeticShopItemInput,
  UpsertCosmeticShopSectionInput,
} from '~/server/schema/cosmetic-shop.schema';
import { cosmeticShopItemSelect } from '~/server/selectors/cosmetic-shop.selector';
import { imageSelect } from '~/server/selectors/image.selector';
import { createEntityImages } from '~/server/services/image.service';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

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

  if (input.name) cosmeticWhere.name = { contains: input.name };
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

export const upsertCosmeticShopItem = async ({
  userId,
  availableQuantity,
  availableTo,
  availableFrom,
  id,
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

  if (existingItem?.id && availableQuantity && existingItem._count.purchases > availableQuantity) {
    throw new Error('Cannot reduce available quantity below the number of purchases');
  }

  if (availableTo && availableFrom && availableTo < availableFrom) {
    throw new Error('Available to date cannot be before available from date');
  }

  if (id) {
    return dbWrite.cosmeticShopItem.upsert({
      where: { id },
      create: {
        ...cosmeticShopItem,
        availableQuantity,
        addedById: userId,
      },
      update: cosmeticShopItem,
      select: cosmeticShopItemSelect,
    });
  } else {
    return dbWrite.cosmeticShopItem.create({
      data: {
        ...cosmeticShopItem,
        availableQuantity,
        addedById: userId,
        availableTo,
        availableFrom,
      },
      select: cosmeticShopItemSelect,
    });
  }
};

export const getShopSections = async (input: GetAllCosmeticShopSections) => {
  const where: Prisma.CosmeticShopSectionFindManyArgs['where'] = {};

  if (input.title) {
    where.title = { contains: input.title };
  }

  if (input.withItems) {
    where.items = {
      some: {},
    };
  }

  return dbRead.cosmeticShopSection.findMany({
    select: {
      id: true,
      title: true,
      description: true,
      placement: true,
      image: {
        select: imageSelect,
      },
      _count: {
        select: {
          items: true,
        },
      },
    },
  });
};

export const getSectionById = async ({ id }: GetByIdInput) => {
  const section = dbRead.cosmeticShopSection.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      description: true,
      placement: true,
      image: {
        select: imageSelect,
      },
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
    image: section.image
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
      },
    });

    // Recreate them:
    if (items.length > 0 && id) {
      await dbWrite.cosmeticShopSectionItem.createMany({
        data: items.map((itemId, index) => ({
          shopSectionId: id,
          shopItemId: itemId,
          index,
        })),
      });
    }
  }

  return getSectionById({ id });
};

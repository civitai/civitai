import { Prisma } from '@prisma/client';
import isEqual from 'lodash/isEqual';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { constants } from '~/server/common/constants';
import { BountySort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { BountyUpsertSchema, GetAllBountiesSchema } from '~/server/schema/bounty.schema';

export const getBounties = <TSelect extends Prisma.BountySelect>({
  input: {
    take,
    skip,
    cursor,
    query,
    tag,
    types,
    favorites,
    sort = constants.bountyFilterDefaults.sort,
    period = constants.bountyFilterDefaults.period,
  },
  select,
  user,
}: {
  input: Omit<GetAllBountiesSchema, 'limit' | 'page'> & { take?: number; skip?: number };
  select: TSelect;
  user?: SessionUser;
}) => {
  const canViewNsfw = user?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;
  const where: Prisma.BountyWhereInput = {
    name: query ? { contains: query, mode: 'insensitive' } : undefined,
    type: types?.length ? { in: types } : undefined,
    nsfw: !canViewNsfw ? { equals: false } : undefined,
    favorites: favorites ? { some: { userId: user?.id } } : undefined,
    tags: tag ? { some: { name: { contains: tag, mode: 'insensitive' } } } : undefined,
  };

  return prisma.bounty.findMany({
    take,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    where,
    select,
    orderBy: [
      ...(sort === BountySort.MostLiked
        ? [{ rank: { [`favoriteCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === BountySort.HighestBounty
        ? [{ rank: { [`bountyValueCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === BountySort.MostDiscussed
        ? [{ rank: { [`commentCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === BountySort.Newest ? [{ createdAt: 'desc' } as const] : []),
    ],
  });
};

export const getBountyById = <TSelect extends Prisma.BountySelect>({
  id,
  select,
}: {
  id: number;
  select: TSelect;
}) => {
  return prisma.bounty.findUnique({ where: { id }, select });
};

export const createBounty = ({
  userId,
  tags,
  images,
  files,
  ...data
}: BountyUpsertSchema & { userId: number }) => {
  return prisma.bounty.create({
    data: {
      ...data,
      userId,
      images: {
        create: images.map((image, index) => ({
          index,
          image: {
            create: {
              ...image,
              userId,
              meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
            },
          },
        })),
      },
      files: {
        create: files.map((file) => ({ ...file })),
      },
      tags: {
        create: tags?.map((tag) => ({ ...tag })),
      },
    },
  });
};

export const updateBountyById = ({ id, data }: { id: number; data: Prisma.BountyUpdateInput }) => {
  return prisma.bounty.update({ where: { id }, data });
};

export const updateBounty = async ({
  id = -1,
  userId,
  files,
  images,
  tags,
  ...data
}: BountyUpsertSchema & { userId: number }) => {
  const currentBounty = await getBountyById({
    id,
    select: {
      name: true,
      description: true,
      type: true,
      deadline: true,
      files: {
        select: {
          id: true,
          type: true,
          url: true,
          name: true,
          sizeKB: true,
        },
      },
      images: {
        orderBy: { index: 'asc' },
        select: {
          index: true,
          image: {
            select: {
              id: true,
              meta: true,
              name: true,
              width: true,
              height: true,
              hash: true,
              url: true,
            },
          },
        },
      },
    },
  });
  if (!currentBounty) return null;

  // Determine which tags to create/update
  const { tagsToCreate, existingTags } = tags?.reduce(
    (acc, current) => {
      if (!current.id) acc.tagsToCreate.push(current);
      else acc.existingTags.push(current);

      return acc;
    },
    { tagsToCreate: [] as typeof tags, existingTags: [] as typeof tags }
  ) ?? { tagsToCreate: [], existingTags: [] };

  // Determine which images to create/update
  const existingImages = currentBounty.images.map(({ image }) => image);
  type PayloadImage = typeof images[number] & {
    index: number;
    userId: number;
    meta: Prisma.JsonObject;
  };
  const { imagesToCreate, imagesToUpdate } = images.reduce(
    (acc, current, index) => {
      if (!current.id)
        acc.imagesToCreate.push({
          ...current,
          index,
          userId,
          meta: (current.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
        });
      else {
        const matched = existingImages.findIndex((image) => image.id === current.id);
        const different = !isEqual(existingImages[matched], images[matched]);
        if (different)
          acc.imagesToUpdate.push({
            ...current,
            index,
            userId,
            meta: (current.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
          });
      }

      return acc;
    },
    { imagesToCreate: [] as PayloadImage[], imagesToUpdate: [] as PayloadImage[] }
  );

  return updateBountyById({
    id,
    data: {
      ...data,
      images: {
        create: imagesToCreate.map(({ index, ...image }) => ({
          index,
          image: { create: image },
        })),
        update: imagesToUpdate.map(({ index, ...image }) => ({
          where: { imageId_bountyId: { imageId: image.id as number, bountyId: id } },
          data: { index },
        })),
      },
      tags: {
        deleteMany: { id: { notIn: existingTags.map(({ id }) => id as number) } },
        create: tagsToCreate.map((tag) => tag),
      },
    },
  });
};

export const deleteBountyById = ({ id }: GetByIdInput) => {
  return prisma.bounty.delete({ where: { id } });
};

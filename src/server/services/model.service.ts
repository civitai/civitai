import { MetricTimeframe, ModelStatus, Prisma, TagTarget } from '@prisma/client';
import isEqual from 'lodash/isEqual';
import { SessionUser } from 'next-auth';

import { ModelSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetAllModelsOutput, ModelInput } from '~/server/schema/model.schema';
import { prepareFile } from '~/utils/file-helpers';
import { env } from '~/env/server.mjs';
import { isNotTag, isTag } from '~/server/schema/tag.schema';

export const getModel = async <TSelect extends Prisma.ModelSelect>({
  input: { id },
  user,
  select,
}: {
  input: GetByIdInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  return await prisma.model.findFirst({
    where: {
      id,
      OR: !user?.isModerator
        ? [{ status: ModelStatus.Published }, { user: { id: user?.id } }]
        : undefined,
    },
    select,
  });
};

export const getModels = async <TSelect extends Prisma.ModelSelect>({
  input: {
    take,
    skip,
    cursor,
    query,
    tag,
    tagname,
    user,
    username,
    baseModels,
    types,
    sort,
    period = MetricTimeframe.AllTime,
    rating,
    favorites,
    hideNSFW,
  },
  select,
  user: sessionUser,
  count = false,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & { take?: number; skip?: number };
  select: TSelect;
  user?: SessionUser;
  count?: boolean;
}) => {
  const canViewNsfw = sessionUser?.showNsfw ?? env.UNAUTHENTICATE_LIST_NSFW;
  const AND: Prisma.Enumerable<Prisma.ModelWhereInput> = [];
  if (!sessionUser?.isModerator) {
    AND.push({ OR: [{ status: ModelStatus.Published }, { user: { id: sessionUser?.id } }] });
  }
  if (query) {
    AND.push({
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        {
          modelVersions: {
            some: {
              files: query
                ? {
                    some: {
                      hashes: { some: { hash: { equals: query, mode: 'insensitive' } } },
                    },
                  }
                : undefined,
            },
          },
        },
      ],
    });
  }

  const where: Prisma.ModelWhereInput = {
    tagsOnModels:
      tagname ?? tag
        ? { some: { tag: { name: { equals: tagname ?? tag, mode: 'insensitive' } } } }
        : undefined,
    user: username ?? user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    nsfw: !canViewNsfw || hideNSFW ? { equals: false } : undefined,
    rank: rating
      ? {
          AND: [{ ratingAllTime: { gte: rating } }, { ratingAllTime: { lt: rating + 1 } }],
        }
      : undefined,
    favoriteModels: favorites ? { some: { userId: sessionUser?.id } } : undefined,
    AND: AND.length ? AND : undefined,
    modelVersions: baseModels?.length ? { some: { baseModel: { in: baseModels } } } : undefined,
  };

  const items = await prisma.model.findMany({
    take,
    skip,
    where,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy: [
      ...(sort === ModelSort.HighestRated ? [{ rank: { [`rating${period}Rank`]: 'asc' } }] : []),
      ...(sort === ModelSort.MostLiked
        ? [{ rank: { [`favoriteCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === ModelSort.MostDownloaded
        ? [{ rank: { [`downloadCount${period}Rank`]: 'asc' } }]
        : []),
      ...(sort === ModelSort.MostDiscussed
        ? [{ rank: { [`commentCount${period}Rank`]: 'asc' } }]
        : []),
      { rank: { newRank: 'asc' } },
    ],
    select,
  });

  if (count) {
    const count = await prisma.model.count({ where });
    return { items, count };
  }

  return { items };
};

export const getModelVersionsMicro = ({ id }: { id: number }) => {
  return prisma.modelVersion.findMany({
    where: { modelId: id },
    orderBy: { index: 'asc' },
    select: { id: true, name: true },
  });
};

export const updateModelById = ({ id, data }: { id: number; data: Prisma.ModelUpdateInput }) => {
  return prisma.model.update({
    where: { id },
    data,
  });
};

export const deleteModelById = ({ id }: GetByIdInput) => {
  return prisma.model.delete({ where: { id } });
};

export const createModel = async ({
  modelVersions,
  userId,
  tagsOnModels,
  ...data
}: ModelInput & { userId: number }) => {
  // TODO Cleaning: Merge Add & Update + Transaction
  // Create prisma transaction
  // Upsert Model: separate function
  // Upsert ModelVersions: separate function
  // Upsert Tags: separate function
  // Upsert Images: separate function
  // Upsert ImagesOnModels: separate function
  // Upsert ModelFiles: separate function
  // 👆 Ideally the whole thing will only be this many lines
  //    All of the logic would be in the separate functions
  return prisma.model.create({
    data: {
      ...data,
      publishedAt: data.status === ModelStatus.Published ? new Date() : null,
      lastVersionAt: new Date(),
      userId,
      modelVersions: {
        create: modelVersions.map(({ images, files, ...version }, versionIndex) => ({
          ...version,
          index: versionIndex,
          status: data.status,
          files: files ? { create: files.map(prepareFile) } : undefined,
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
        })),
      },
      tagsOnModels: {
        create: tagsOnModels?.map(({ name }) => ({
          tag: {
            connectOrCreate: {
              where: { name_target: { name, target: TagTarget.Model } },
              create: { name, target: TagTarget.Model },
            },
          },
        })),
      },
    },
  });
};

export const updateModel = async ({
  id,
  tagsOnModels,
  modelVersions,
  userId,
  ...data
}: ModelInput & { id: number; userId: number }) => {
  const currentModel = await prisma.model.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!currentModel) return currentModel;

  // Get currentVersions to compare files and images
  const currentVersions = await prisma.modelVersion.findMany({
    where: { modelId: id },
    orderBy: { index: 'asc' },
    select: {
      id: true,
      name: true,
      baseModel: true,
      description: true,
      steps: true,
      epochs: true,
      images: {
        orderBy: { index: 'asc' },
        select: {
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
      trainedWords: true,
      files: {
        select: { id: true, type: true, url: true, name: true, sizeKB: true, primary: true },
      },
    },
  });
  // Transform currentVersions to payload structure for easy compare
  const existingVersions = currentVersions.map(({ images, ...version }) => ({
    ...version,
    images: images.map(({ image }) => image),
  }));

  // Determine which version to create/update
  type PayloadVersion = typeof modelVersions[number] & { index: number };
  const { versionsToCreate, versionsToUpdate } = modelVersions.reduce(
    (acc, current, index) => {
      if (!current.id) acc.versionsToCreate.push({ ...current, index });
      else {
        const matched = existingVersions.findIndex((version) => version.id === current.id);
        const different = !isEqual(existingVersions[matched], modelVersions[matched]);
        if (different) acc.versionsToUpdate.push({ ...current, index });
      }

      return acc;
    },
    { versionsToCreate: [] as PayloadVersion[], versionsToUpdate: [] as PayloadVersion[] }
  );

  const versionIds = modelVersions.map((version) => version.id).filter(Boolean) as number[];
  const hasNewVersions = modelVersions.some((x) => !x.id);

  const model = await prisma.model.update({
    where: { id },
    data: {
      ...data,
      status: data.status,
      publishedAt:
        data.status === ModelStatus.Published && currentModel?.status !== ModelStatus.Published
          ? new Date()
          : null,
      lastVersionAt: hasNewVersions ? new Date() : undefined,
      modelVersions: {
        deleteMany: versionIds.length > 0 ? { id: { notIn: versionIds } } : undefined,
        create: versionsToCreate.map(({ images, files, ...version }) => ({
          ...version,
          files: { create: files.map(prepareFile) },
          images: {
            create: images.map(({ id, meta, ...image }, index) => ({
              index,
              image: {
                create: {
                  ...image,
                  userId,
                  meta: (meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                },
              },
            })),
          },
        })),
        update: versionsToUpdate.map(({ id = -1, images, files, ...version }) => {
          const fileIds = files.map((file) => file.id).filter(Boolean) as number[];
          const currentVersion = existingVersions.find((x) => x.id === id);

          // Determine which files to create/update
          const { filesToCreate, filesToUpdate } = files.reduce(
            (acc, current) => {
              if (!current.id) acc.filesToCreate.push(current);
              else {
                const existingFiles = currentVersion?.files ?? [];
                const matched = existingFiles.findIndex((file) => file.id === current.id);
                const different = !isEqual(existingFiles[matched], files[matched]);
                if (different) acc.filesToUpdate.push(current);
              }

              return acc;
            },
            { filesToCreate: [] as typeof files, filesToUpdate: [] as typeof files }
          );

          // Determine which images to create/update
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
                const existingImages = currentVersion?.images ?? [];
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

          return {
            where: { id },
            data: {
              ...version,
              status: data.status,
              files: {
                deleteMany: fileIds.length > 0 ? { id: { notIn: fileIds } } : undefined,
                create: filesToCreate.map(prepareFile),
                update: filesToUpdate.map(({ id, ...fileData }) => ({
                  where: { id: id ?? -1 },
                  data: { ...fileData },
                })),
              },
              images: {
                deleteMany: {
                  NOT: images.map((image) => ({ imageId: image.id })),
                },
                create: imagesToCreate.map(({ index, ...image }) => ({
                  index,
                  image: { create: image },
                })),
                update: imagesToUpdate.map(({ index, meta, ...image }) => ({
                  where: {
                    imageId_modelVersionId: {
                      imageId: image.id as number,
                      modelVersionId: id,
                    },
                  },
                  data: {
                    index,
                    image: {
                      update: {
                        meta,
                      },
                    },
                  },
                })),
              },
            },
          };
        }),
      },
      tagsOnModels: tagsOnModels
        ? {
            deleteMany: {
              tagId: {
                notIn: tagsOnModels.filter(isTag).map((x) => x.id),
              },
            },
            connectOrCreate: tagsOnModels.filter(isTag).map((tag) => ({
              where: { modelId_tagId: { tagId: tag.id, modelId: id } },
              create: { tagId: tag.id },
            })),
            create: tagsOnModels.filter(isNotTag).map(({ name }) => ({
              tag: {
                create: { name, target: TagTarget.Model },
              },
            })),
          }
        : undefined,
    },
  });

  return model;
};

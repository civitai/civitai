import { MetricTimeframe, ModelStatus, Prisma, ReportReason } from '@prisma/client';
import { SessionUser } from 'next-auth';

import { ModelSort } from '~/server/common/enums';
import { prisma } from '~/server/db/client';
import { GetByIdInput, ReportInput } from '~/server/schema/base.schema';
import { GetAllModelsOutput, ModelInput } from '~/server/schema/model.schema';
import { prepareFile } from '~/utils/file-helpers';

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
    types,
    sort,
    period = MetricTimeframe.AllTime,
    rating,
    favorites,
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
  const canViewNsfw = sessionUser?.showNsfw ?? true;
  const where: Prisma.ModelWhereInput = {
    name: query ? { contains: query, mode: 'insensitive' } : undefined,
    tagsOnModels:
      tagname ?? tag
        ? { some: { tag: { name: { equals: tagname ?? tag, mode: 'insensitive' } } } }
        : undefined,
    user: username ?? user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    nsfw: !canViewNsfw ? { equals: false } : undefined,
    rank: rating
      ? {
          AND: [{ ratingAllTime: { gte: rating } }, { ratingAllTime: { lt: rating + 1 } }],
        }
      : undefined,
    OR: !sessionUser?.isModerator
      ? [{ status: ModelStatus.Published }, { user: { id: sessionUser?.id } }]
      : undefined,
    favoriteModels: favorites ? { some: { userId: sessionUser?.id } } : undefined,
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
      { createdAt: 'desc' },
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
    select: { id: true, name: true },
  });
};

export const updateModelById = ({ id, data }: { id: number; data: Prisma.ModelUpdateInput }) => {
  return prisma.model.update({
    where: { id },
    data,
  });
};

export const reportModelById = ({ id, reason, userId }: ReportInput & { userId: number }) => {
  const data: Prisma.ModelUpdateInput =
    reason === ReportReason.NSFW ? { nsfw: true } : { tosViolation: true };

  return prisma.$transaction([
    updateModelById({ id, data }),
    prisma.modelReport.create({
      data: {
        modelId: id,
        reason,
        userId,
      },
    }),
  ]);
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
              where: { name },
              create: { name },
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
  const { tagsToCreate, tagsToUpdate } = tagsOnModels?.reduce(
    (acc, current) => {
      if (!current.id) acc.tagsToCreate.push(current);
      else acc.tagsToUpdate.push(current);

      return acc;
    },
    {
      tagsToCreate: [] as typeof tagsOnModels,
      tagsToUpdate: [] as typeof tagsOnModels,
    }
  ) ?? { tagsToCreate: [], tagsToUpdate: [] };

  const versionIds = modelVersions.map((version) => version.id).filter(Boolean) as number[];

  const model = await prisma.$transaction(
    async (tx) => {
      const imagesToUpdate = modelVersions.flatMap((x) => x.images).filter((x) => !!x.id);
      await Promise.all(
        imagesToUpdate.map(async (image) =>
          tx.image.updateMany({
            where: { id: image.id },
            data: {
              ...image,
              meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
            },
          })
        )
      );

      return tx.model.update({
        where: { id },
        data: {
          ...data,
          status: data.status,
          modelVersions: {
            deleteMany: versionIds.length > 0 ? { id: { notIn: versionIds } } : undefined,
            upsert: modelVersions.map(
              ({ id = -1, images, files = [], ...version }, versionIndex) => {
                const imagesWithIndex = images.map((image, index) => ({
                  index,
                  userId,
                  ...image,
                  meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                }));
                const fileIds = files.map((file) => file.id).filter(Boolean) as number[];

                // Determine which files to create/update
                const { filesToCreate, filesToUpdate } = files.reduce(
                  (acc, current) => {
                    if (!current.id) acc.filesToCreate.push(current);
                    else acc.filesToUpdate.push(current);

                    return acc;
                  },
                  {
                    filesToCreate: [] as typeof files,
                    filesToUpdate: [] as typeof files,
                  }
                );

                // Determine what images to create/update
                const { imagesToCreate, imagesToUpdate } = imagesWithIndex.reduce(
                  (acc, current) => {
                    if (!current.id) acc.imagesToCreate.push(current);
                    else acc.imagesToUpdate.push(current);

                    return acc;
                  },
                  {
                    imagesToCreate: [] as typeof imagesWithIndex,
                    imagesToUpdate: [] as typeof imagesWithIndex,
                  }
                );

                return {
                  where: { id },
                  create: {
                    ...version,
                    index: versionIndex,
                    status: data.status,
                    files: {
                      create: filesToCreate.map(prepareFile),
                    },
                    images: {
                      create: imagesWithIndex.map(({ index, ...image }) => ({
                        index,
                        image: { create: image },
                      })),
                    },
                  },
                  update: {
                    ...version,
                    index: versionIndex,
                    epochs: version.epochs ?? null,
                    steps: version.steps ?? null,
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
                      update: imagesToUpdate.map(({ index, ...image }) => ({
                        where: {
                          imageId_modelVersionId: {
                            imageId: image.id as number,
                            modelVersionId: id,
                          },
                        },
                        data: {
                          index,
                        },
                      })),
                    },
                  },
                };
              }
            ),
          },
          tagsOnModels: {
            deleteMany: {},
            connectOrCreate: tagsToUpdate.map((tag) => ({
              where: { modelId_tagId: { modelId: id, tagId: tag.id as number } },
              create: { tagId: tag.id as number },
            })),
            create: tagsToCreate.map((tag) => ({
              tag: { create: { name: tag.name.toLowerCase() } },
            })),
          },
        },
      });
    },
    {
      maxWait: 5000,
      timeout: 10000,
    }
  );

  return model;
};

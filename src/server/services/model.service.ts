import { MetricTimeframe, ModelStatus, ModelType, Prisma, TagTarget } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import isEqual from 'lodash/isEqual';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { dbWrite, dbRead } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { GetAllModelsOutput, ModelInput } from '~/server/schema/model.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import {
  imageSelect,
  prepareCreateImage,
  prepareUpdateImage,
} from '~/server/selectors/image.selector';
import { prepareFile } from '~/utils/file-helpers';

export const getModel = <TSelect extends Prisma.ModelSelect>({
  input: { id },
  user,
  select,
}: {
  input: GetByIdInput;
  user?: SessionUser;
  select: TSelect;
}) => {
  return dbRead.model.findFirst({
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
    hidden,
    browsingMode,
    excludedTagIds,
    excludedIds,
    checkpointType,
    status,
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
  const canViewNsfw = sessionUser?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
  const AND: Prisma.Enumerable<Prisma.ModelWhereInput> = [];
  const lowerQuery = query?.toLowerCase();
  if (!sessionUser?.isModerator) {
    AND.push({
      OR: [
        { status: ModelStatus.Published },
        ...(sessionUser
          ? [{ AND: [{ user: { id: sessionUser.id } }, { status: ModelStatus.Draft }] }]
          : []),
      ],
    });
  }
  if (sessionUser?.isModerator && !(username || user)) {
    AND.push({ status: status && status.length > 0 ? { in: status } : ModelStatus.Published });
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
        {
          modelVersions: {
            some: {
              trainedWords: { has: lowerQuery },
            },
          },
        },
      ],
    });
  }
  if (excludedTagIds && excludedTagIds.length && !username) {
    AND.push({
      tagsOnModels: { every: { tagId: { notIn: excludedTagIds } } },
    });
  }
  if (excludedIds) {
    AND.push({ id: { notIn: excludedIds } });
  }
  if (checkpointType && (!types?.length || types?.includes('Checkpoint'))) {
    const TypeOr: Prisma.Enumerable<Prisma.ModelWhereInput> = [{ checkpointType }];
    if (types?.length) {
      const otherTypes = types.filter((t) => t !== 'Checkpoint');
      TypeOr.push({ type: { in: otherTypes } });
    } else TypeOr.push({ type: { not: 'Checkpoint' } });
    AND.push({ OR: TypeOr });
  }

  if (canViewNsfw && !browsingMode) browsingMode = BrowsingMode.All;
  else if (!canViewNsfw) browsingMode = BrowsingMode.SFW;

  const where: Prisma.ModelWhereInput = {
    tagsOnModels:
      tagname ?? tag
        ? { some: { tag: { name: { equals: tagname ?? tag, mode: 'insensitive' } } } }
        : undefined,
    user: username || user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    nsfw:
      browsingMode === BrowsingMode.All
        ? undefined
        : { equals: browsingMode === BrowsingMode.NSFW },
    rank: rating
      ? {
          AND: [{ ratingAllTime: { gte: rating } }, { ratingAllTime: { lt: rating + 1 } }],
        }
      : undefined,
    engagements: favorites
      ? { some: { userId: sessionUser?.id, type: 'Favorite' } }
      : hidden
      ? { some: { userId: sessionUser?.id, type: 'Hide' } }
      : undefined,
    AND: AND.length ? AND : undefined,
    modelVersions: baseModels?.length ? { some: { baseModel: { in: baseModels } } } : undefined,
  };

  const items = await dbRead.model.findMany({
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
    const count = await dbRead.model.count({ where });
    return { items, count };
  }

  return { items };
};

export const getModelVersionsMicro = ({ id }: { id: number }) => {
  return dbRead.modelVersion.findMany({
    where: { modelId: id },
    orderBy: { index: 'asc' },
    select: { id: true, name: true },
  });
};

export const updateModelById = ({ id, data }: { id: number; data: Prisma.ModelUpdateInput }) => {
  return dbWrite.model.update({
    where: { id },
    data,
  });
};

export const deleteModelById = ({ id }: GetByIdInput) => {
  return dbWrite.model.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'Deleted' },
  });
};

export const restoreModelById = ({ id }: GetByIdInput) => {
  return dbWrite.model.update({ where: { id }, data: { deletedAt: null, status: 'Draft' } });
};

export const permaDeleteModelById = ({ id }: GetByIdInput) => {
  return dbWrite.model.delete({ where: { id } });
};

const prepareModelVersions = (versions: ModelInput['modelVersions']) => {
  return versions.map(({ files, ...version }) => {
    // Keep tab whether there's a file format-type conflict.
    // We needed to manually check for this because Prisma doesn't do
    // error handling all too well
    const fileConflicts: Record<string, boolean> = {};

    return {
      ...version,
      files: files.map((file) => {
        const preparedFile = prepareFile(file);

        if (fileConflicts[`${preparedFile.type}-${preparedFile.format}`])
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Only 1 ${preparedFile.format} ${preparedFile.type} file can be attached to a version, please review your uploads and try again`,
          });
        else fileConflicts[`${preparedFile.type}-${preparedFile.format}`] = true;

        return preparedFile;
      }),
    };
  });
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

  const parsedModelVersions = prepareModelVersions(modelVersions);
  const allImagesNSFW = parsedModelVersions
    .flatMap((version) => version.images)
    .every((image) => image.nsfw);

  return dbWrite.$transaction(async (tx) => {
    if (tagsOnModels)
      await tx.tag.updateMany({
        where: {
          name: { in: tagsOnModels.map((x) => x.name.toLowerCase().trim()) },
          NOT: { target: { has: TagTarget.Model } },
        },
        data: { target: { push: TagTarget.Model } },
      });

    return tx.model.create({
      data: {
        ...data,
        checkpointType: data.type === ModelType.Checkpoint ? data.checkpointType : null,
        publishedAt: data.status === ModelStatus.Published ? new Date() : null,
        lastVersionAt: new Date(),
        nsfw: data.nsfw || (allImagesNSFW && data.status === ModelStatus.Published),
        userId,
        modelVersions: {
          create: parsedModelVersions.map(({ images, files, ...version }, versionIndex) => ({
            ...version,
            trainedWords: version.trainedWords?.map((x) => x.toLowerCase()),
            index: versionIndex,
            status: data.status,
            files: files.length > 0 ? { create: files } : undefined,
            images: {
              create: images.map(({ tags = [], ...image }, index) => ({
                index,
                image: {
                  create: {
                    ...image,
                    userId,
                    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                    generationProcess: image.meta
                      ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
                      : null,
                    tags: {
                      create: tags.map((tag) => ({
                        tag: {
                          connectOrCreate: {
                            where: { id: tag.id },
                            create: { ...tag, target: [TagTarget.Image] },
                          },
                        },
                      })),
                    },
                  },
                },
              })),
            },
          })),
        },
        tagsOnModels: tagsOnModels
          ? {
              create: tagsOnModels.map((tag) => {
                const name = tag.name.toLowerCase().trim();
                return {
                  tag: {
                    connectOrCreate: {
                      where: { name },
                      create: { name, target: [TagTarget.Model] },
                    },
                  },
                };
              }),
            }
          : undefined,
      },
    });
  });
};

export const updateModel = async ({
  id,
  tagsOnModels,
  modelVersions,
  userId,
  ...data
}: ModelInput & { id: number; userId: number }) => {
  const parsedModelVersions = prepareModelVersions(modelVersions);
  const currentModel = await dbWrite.model.findUnique({
    where: { id },
    select: { status: true, publishedAt: true },
  });
  if (!currentModel) return currentModel;

  // Get currentVersions to compare files and images
  const currentVersions = await dbWrite.modelVersion.findMany({
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
            select: imageSelect,
          },
        },
      },
      trainedWords: true,
      files: {
        select: { id: true, type: true, url: true, name: true, sizeKB: true },
      },
    },
  });
  // Transform currentVersions to payload structure for easy compare
  const existingVersions = currentVersions.map(({ images, ...version }) => ({
    ...version,
    images: images.map(({ image }) => image),
  }));

  // Determine which version to create/update
  type PayloadVersion = (typeof modelVersions)[number] & { index: number };
  const { versionsToCreate, versionsToUpdate } = parsedModelVersions.reduce(
    (acc, current, index) => {
      if (!current.id) acc.versionsToCreate.push({ ...current, index });
      else {
        const matched = existingVersions.findIndex((version) => version.id === current.id);
        const different = !isEqual(existingVersions[matched], parsedModelVersions[matched]);
        if (different) acc.versionsToUpdate.push({ ...current, index });
      }

      return acc;
    },
    { versionsToCreate: [] as PayloadVersion[], versionsToUpdate: [] as PayloadVersion[] }
  );

  const versionIds = parsedModelVersions.map((version) => version.id).filter(Boolean) as number[];
  const hasNewVersions = parsedModelVersions.some((x) => !x.id);

  const allImagesNSFW = parsedModelVersions
    .flatMap((version) => version.images)
    .every((image) => image.nsfw);

  const tagsToCreate = tagsOnModels?.filter(isNotTag) ?? [];
  const tagsToUpdate = tagsOnModels?.filter(isTag) ?? [];

  if (tagsOnModels)
    await dbWrite.tag.updateMany({
      where: {
        name: { in: tagsOnModels.map((x) => x.name.toLowerCase().trim()) },
        NOT: { target: { has: TagTarget.Model } },
      },
      data: { target: { push: TagTarget.Model } },
    });

  return dbWrite.model.update({
    where: { id },
    data: {
      ...data,
      checkpointType: data.type === ModelType.Checkpoint ? data.checkpointType : null,
      nsfw: data.nsfw || (allImagesNSFW && data.status === ModelStatus.Published),
      status: data.status,
      publishedAt:
        data.status === ModelStatus.Published && currentModel.status !== ModelStatus.Published
          ? new Date()
          : currentModel.publishedAt,
      lastVersionAt: hasNewVersions ? new Date() : undefined,
      modelVersions: {
        deleteMany: versionIds.length > 0 ? { id: { notIn: versionIds } } : undefined,
        create: versionsToCreate.map(({ images, files, ...version }) => ({
          ...version,
          files: { create: files },
          images: {
            create: images.map((image, index) => ({
              index,
              image: {
                create: {
                  userId,
                  ...prepareCreateImage(image),
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
          type PayloadImage = (typeof images)[number] & { index: number };
          const { imagesToCreate, imagesToUpdate } = images.reduce(
            (acc, current, index) => {
              if (!current.id) acc.imagesToCreate.push({ ...current, index });
              else {
                const existingImages = currentVersion?.images ?? [];
                const matched = existingImages.findIndex((image) => image.id === current.id);
                // !This will always be different now that we have image tags
                const different = !isEqual(existingImages[matched], images[matched]);
                if (different) acc.imagesToUpdate.push({ ...current, index });
              }

              return acc;
            },
            { imagesToCreate: [] as PayloadImage[], imagesToUpdate: [] as PayloadImage[] }
          );

          return {
            where: { id },
            data: {
              ...version,
              trainedWords: version.trainedWords?.map((x) => x.toLowerCase()),
              status: data.status,
              files: {
                deleteMany: { id: { notIn: fileIds } },
                create: filesToCreate,
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
                  image: {
                    create: {
                      userId,
                      ...prepareCreateImage(image),
                    },
                  },
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
                    image: { update: prepareUpdateImage(image) },
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
                notIn: tagsToUpdate.map((x) => x.id),
              },
            },
            connectOrCreate: tagsToUpdate.map((tag) => ({
              where: { modelId_tagId: { tagId: tag.id, modelId: id } },
              create: { tagId: tag.id },
            })),
            create: tagsToCreate.map((tag) => {
              const name = tag.name.toLowerCase().trim();
              return {
                tag: {
                  connectOrCreate: {
                    where: { name },
                    create: { name, target: [TagTarget.Model] },
                  },
                },
              };
            }),
          }
        : undefined,
    },
  });
};

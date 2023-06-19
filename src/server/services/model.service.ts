import {
  GetAssociatedResourcesInput,
  GetModelsWithCategoriesSchema,
  SetAssociatedResourcesInput,
  SetModelsCategoryInput,
} from './../schema/model.schema';
import {
  CommercialUse,
  MetricTimeframe,
  ModelHashType,
  ModelModifier,
  ModelStatus,
  ModelType,
  Prisma,
  TagTarget,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { ManipulateType } from 'dayjs';
import { isEmpty } from 'lodash-es';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { ModelFileType } from '~/server/common/constants';
import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllModelsOutput,
  GetModelsByCategoryInput,
  GetModelVersionsSchema,
  ModelInput,
  ModelMeta,
  ModelUpsertInput,
  PublishModelSchema,
  ToggleModelLockInput,
  UnpublishModelSchema,
} from '~/server/schema/model.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getImagesForModelVersion, ingestNewImages } from '~/server/services/image.service';
import { getTypeCategories } from '~/server/services/tag.service';
import { getHiddenImagesForUser } from '~/server/services/user-cache.service';
import { getEarlyAccessDeadline, isEarlyAccess } from '~/server/utils/early-access-helpers';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { decreaseDate } from '~/utils/date-helpers';
import { prepareFile } from '~/utils/file-helpers';
import { isDefined } from '~/utils/type-guards';
import { getCategoryTags } from '~/server/services/system-cache';
import { associatedResourceSelect } from '~/server/selectors/model.selector';

export const getModel = <TSelect extends Prisma.ModelSelect>({
  id,
  user,
  select,
}: GetByIdInput & {
  user?: SessionUser;
  select: TSelect;
}) => {
  const OR: Prisma.Enumerable<Prisma.ModelWhereInput> = [{ status: ModelStatus.Published }];
  // if (user?.id) OR.push({ userId: user.id, deletedAt: null });

  return dbRead.model.findFirst({
    where: {
      id,
      // OR: !user?.isModerator ? OR : undefined,
    },
    select,
  });
};

export const getModels = async <TSelect extends Prisma.ModelSelect>({
  input,
  select,
  user: sessionUser,
  count = false,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & {
    take?: number;
    skip?: number;
  };
  select: TSelect;
  user?: SessionUser;
  count?: boolean;
}) => {
  const {
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
    period,
    periodMode,
    rating,
    favorites,
    hidden,
    excludedTagIds,
    excludedUserIds,
    excludedIds,
    checkpointType,
    status,
    allowNoCredit,
    allowDifferentLicense,
    allowDerivatives,
    allowCommercialUse,
    browsingMode,
    ids,
    needsReview,
    earlyAccess,
  } = input;
  const canViewNsfw = sessionUser?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
  const AND: Prisma.Enumerable<Prisma.ModelWhereInput> = [];
  const lowerQuery = query?.toLowerCase();

  // If the user is not a moderator, only show published models
  if (!sessionUser?.isModerator) {
    const statusVisibleOr: Prisma.Enumerable<Prisma.ModelWhereInput> = [
      { status: ModelStatus.Published },
    ];
    if (sessionUser && (username || user))
      statusVisibleOr.push({
        AND: [{ user: { id: sessionUser.id } }, { status: ModelStatus.Draft }],
      });

    AND.push({ OR: statusVisibleOr });
  }
  if (sessionUser?.isModerator) {
    if (status?.includes(ModelStatus.Unpublished)) status.push(ModelStatus.UnpublishedViolation);
    AND.push({ status: status && status.length > 0 ? { in: status } : ModelStatus.Published });
  }

  // Filter by model permissions
  if (allowCommercialUse !== undefined) {
    const commercialUseOr: CommercialUse[] = [];
    switch (allowCommercialUse) {
      case CommercialUse.None:
        commercialUseOr.push(CommercialUse.None);
        break;
      case CommercialUse.Image:
        commercialUseOr.push(CommercialUse.Image);
      case CommercialUse.Rent:
        commercialUseOr.push(CommercialUse.Rent);
      case CommercialUse.Sell:
        commercialUseOr.push(CommercialUse.Sell);
    }
    AND.push({ allowCommercialUse: { in: commercialUseOr } });
  }
  if (allowDerivatives !== undefined) AND.push({ allowDerivatives });
  if (allowDifferentLicense !== undefined) AND.push({ allowDifferentLicense });
  if (allowNoCredit !== undefined) AND.push({ allowNoCredit });

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
                      hashes: { some: { hash: query } },
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
  if (!!ids?.length) AND.push({ id: { in: ids } });
  if (excludedUserIds && excludedUserIds.length && !username) {
    AND.push({ userId: { notIn: excludedUserIds } });
  }
  if (excludedTagIds && excludedTagIds.length && !username) {
    AND.push({
      tagsOnModels: { none: { tagId: { in: excludedTagIds } } },
    });
  }
  if (excludedIds && !hidden && !username) {
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
  if (needsReview && sessionUser?.isModerator) {
    AND.push({
      OR: [
        { meta: { path: ['needsReview'], equals: true } },
        { modelVersions: { some: { meta: { path: ['needsReview'], equals: true } } } },
      ],
    });
  }
  if (earlyAccess) {
    AND.push({ earlyAccessDeadline: { gte: new Date() } });
  }

  const hideNSFWModels = browsingMode === BrowsingMode.SFW || !canViewNsfw;
  const where: Prisma.ModelWhereInput = {
    tagsOnModels: tagname ?? tag ? { some: { tag: { name: tagname ?? tag } } } : undefined,
    user: username || user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    nsfw: hideNSFWModels ? false : undefined,
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
    modelVersions: { some: { baseModel: baseModels?.length ? { in: baseModels } : undefined } },
    lastVersionAt:
      period !== MetricTimeframe.AllTime && periodMode !== 'stats'
        ? { gte: decreaseDate(new Date(), 1, period.toLowerCase() as ManipulateType) }
        : undefined,
  };

  let orderBy: Prisma.ModelOrderByWithRelationInput = {
    lastVersionAt: { sort: 'desc', nulls: 'last' },
  };
  if (sort === ModelSort.HighestRated) orderBy = { rank: { [`rating${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostLiked)
    orderBy = { rank: { [`favoriteCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostDownloaded)
    orderBy = { rank: { [`downloadCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostDiscussed)
    orderBy = { rank: { [`commentCount${period}Rank`]: 'asc' } };

  const items = await dbRead.model.findMany({
    take,
    skip,
    where,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy,
    select,
  });

  if (count) {
    const count = await dbRead.model.count({ where });
    return { items, count };
  }

  return { items };
};

export const getModelVersionsMicro = ({
  id,
  excludeUnpublished: excludeDrafts,
}: GetModelVersionsSchema) => {
  return dbRead.modelVersion.findMany({
    where: { modelId: id, status: excludeDrafts ? ModelStatus.Published : undefined },
    orderBy: { index: 'asc' },
    select: { id: true, name: true, index: true },
  });
};

export const updateModelById = ({ id, data }: { id: number; data: Prisma.ModelUpdateInput }) => {
  return dbWrite.model.update({
    where: { id },
    data,
  });
};

export const deleteModelById = async ({ id, userId }: GetByIdInput & { userId: number }) => {
  const deletedModel = await dbWrite.$transaction(async (tx) => {
    const model = await tx.model.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'Deleted',
        deletedBy: userId,
        modelVersions: {
          updateMany: { where: { status: 'Published' }, data: { status: 'Deleted' } },
        },
      },
      select: { id: true, userId: true, nsfw: true, modelVersions: { select: { id: true } } },
    });
    if (!model) return null;

    await tx.post.updateMany({
      where: {
        userId: model.userId,
        modelVersionId: { in: model.modelVersions.map(({ id }) => id) },
      },
      data: { publishedAt: null },
    });

    return model;
  });

  return deletedModel;
};

export const restoreModelById = ({ id }: GetByIdInput) => {
  return dbWrite.model.update({
    where: { id },
    data: {
      deletedAt: null,
      status: 'Draft',
      deletedBy: null,
      modelVersions: {
        updateMany: { where: { status: 'Deleted' }, data: { status: 'Draft' } },
      },
    },
  });
};

export const permaDeleteModelById = async ({ id }: GetByIdInput & { userId: number }) => {
  const deletedModel = await dbWrite.$transaction(async (tx) => {
    const model = await tx.model.findUnique({
      where: { id },
      select: { id: true, userId: true, nsfw: true, modelVersions: { select: { id: true } } },
    });
    if (!model) return null;

    await tx.post.deleteMany({
      where: {
        userId: model.userId,
        modelVersionId: { in: model.modelVersions.map(({ id }) => id) },
      },
    });

    const deletedModel = await tx.model.delete({ where: { id } });
    return deletedModel;
  });

  return deletedModel;
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
        const {
          type,
          metadata: { format, size },
        } = preparedFile;
        const key = [size, type, format].filter(Boolean).join('-');

        if (fileConflicts[key])
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Only 1 ${key.replace(
              '-',
              ' '
            )} file can be attached to a version, please review your uploads and try again`,
          });
        else fileConflicts[key] = true;

        return preparedFile;
      }),
    };
  });
};

export const upsertModel = ({
  id,
  tagsOnModels,
  userId,
  ...data
}: // TODO.manuel: hardcoding meta type since it causes type issues in lots of places if we set it in the schema
ModelUpsertInput & { userId: number; meta?: Prisma.ModelCreateInput['meta'] }) => {
  if (!id)
    return dbWrite.model.create({
      select: { id: true, nsfw: true },
      data: {
        ...data,
        userId,
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
  else
    return dbWrite.model.update({
      select: { id: true, nsfw: true },
      where: { id },
      data: {
        ...data,
        tagsOnModels: tagsOnModels
          ? {
              deleteMany: {
                tagId: {
                  notIn: tagsOnModels.filter(isTag).map((x) => x.id),
                },
              },
              connectOrCreate: tagsOnModels.filter(isTag).map((tag) => ({
                where: { modelId_tagId: { tagId: tag.id, modelId: id as number } },
                create: { tagId: tag.id },
              })),
              create: tagsOnModels.filter(isNotTag).map((tag) => {
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

export const createModel = async ({
  modelVersions,
  userId,
  tagsOnModels,
  ...data
}: ModelInput & { userId: number }) => {
  const parsedModelVersions = prepareModelVersions(modelVersions);
  const allImagesNSFW = parsedModelVersions
    .flatMap((version) => version.images)
    .every((image) => image.nsfw);

  const model = await dbWrite.$transaction(async (tx) => {
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
              create: images.map(({ ...image }, index) => ({
                index,
                image: {
                  create: {
                    ...image,
                    userId,
                    meta: (image.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                    generationProcess: image.meta
                      ? getImageGenerationProcess(image.meta as Prisma.JsonObject)
                      : null,
                    // tags: {
                    //   create: tags.map((tag) => ({
                    //     tag: {
                    //       connectOrCreate: {
                    //         where: { id: tag.id },
                    //         create: { ...tag, target: [TagTarget.Image] },
                    //       },
                    //     },
                    //   })),
                    // },
                  } as Prisma.ImageUncheckedCreateWithoutImagesOnModelsInput,
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
      select: { id: true, nsfw: true },
    });
  });

  await ingestNewImages({ modelId: model.id });

  return model;
};

export const publishModelById = async ({
  id,
  versionIds,
  meta,
  republishing,
}: PublishModelSchema & { meta?: ModelMeta; republishing?: boolean }) => {
  const model = await dbWrite.$transaction(
    async (tx) => {
      const includeVersions = versionIds && versionIds.length > 0;
      const publishedAt = new Date();

      const model = await tx.model.update({
        where: { id },
        data: {
          status: ModelStatus.Published,
          publishedAt,
          meta: isEmpty(meta) ? Prisma.JsonNull : meta,
          lastVersionAt: includeVersions && !republishing ? publishedAt : undefined,
          modelVersions: includeVersions
            ? {
                updateMany: {
                  where: { id: { in: versionIds } },
                  data: { status: ModelStatus.Published, publishedAt },
                },
              }
            : undefined,
        },
        select: { id: true, type: true, userId: true },
      });

      if (includeVersions) {
        await tx.post.updateMany({
          where: { modelVersionId: { in: versionIds } },
          data: { publishedAt },
        });
      }

      return model;
    },
    { timeout: 10000 }
  );

  return model;
};

export const unpublishModelById = async ({
  id,
  reason,
  customMessage,
  meta,
  user,
}: UnpublishModelSchema & { meta?: ModelMeta; user: SessionUser }) => {
  const model = await dbWrite.$transaction(
    async (tx) => {
      const updatedModel = await tx.model.update({
        where: { id },
        data: {
          status: reason ? ModelStatus.UnpublishedViolation : ModelStatus.Unpublished,
          publishedAt: null,
          meta: {
            ...meta,
            ...(reason
              ? {
                  unpublishedReason: reason,
                  customMessage,
                }
              : {}),
            unpublishedAt: new Date().toISOString(),
            unpublishedBy: user.id,
          },
          modelVersions: {
            updateMany: {
              where: { status: ModelStatus.Published },
              data: { status: ModelStatus.Unpublished, publishedAt: null },
            },
          },
        },
        select: { userId: true, modelVersions: { select: { id: true } } },
      });

      await tx.post.updateMany({
        where: {
          modelVersionId: { in: updatedModel.modelVersions.map((x) => x.id) },
          userId: updatedModel.userId,
          publishedAt: { not: null },
        },
        data: { publishedAt: null },
      });

      return updatedModel;
    },
    { timeout: 10000 }
  );

  return model;
};

export const getDraftModelsByUserId = async <TSelect extends Prisma.ModelSelect>({
  userId,
  select,
  page,
  limit = DEFAULT_PAGE_SIZE,
}: GetAllSchema & {
  userId: number;
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.ModelFindManyArgs['where'] = {
    userId,
    status: { notIn: [ModelStatus.Published, ModelStatus.Deleted] },
  };

  const items = await dbRead.model.findMany({
    select,
    skip,
    take,
    where,
    orderBy: { updatedAt: 'desc' },
  });
  const count = await dbRead.model.count({ where });

  return getPagingData({ items, count }, take, page);
};

export const toggleLockModel = async ({ id, locked }: ToggleModelLockInput) => {
  await dbWrite.model.update({ where: { id }, data: { locked } });
};

export const getSimpleModelWithVersions = async ({ id, ctx }: GetByIdInput & { ctx?: Context }) => {
  const model = await getModel({
    id,
    user: ctx?.user,
    select: {
      id: true,
      name: true,
      createdAt: true,
      locked: true,
      user: { select: userWithCosmeticsSelect },
    },
  });
  if (!model) throw throwNotFoundError();
  return model;
};

export const updateModelEarlyAccessDeadline = async ({ id }: GetByIdInput) => {
  const model = await dbRead.model.findUnique({
    where: { id },
    select: {
      id: true,
      publishedAt: true,
      modelVersions: {
        where: { status: ModelStatus.Published },
        select: { id: true, earlyAccessTimeFrame: true, createdAt: true },
      },
    },
  });
  if (!model) throw throwNotFoundError();

  const { modelVersions } = model;
  const nextEarlyAccess = modelVersions.find(
    (v) =>
      v.earlyAccessTimeFrame > 0 &&
      isEarlyAccess({
        earlyAccessTimeframe: v.earlyAccessTimeFrame,
        versionCreatedAt: v.createdAt,
        publishedAt: model.publishedAt,
      })
  );

  if (nextEarlyAccess) {
    await updateModelById({
      id,
      data: {
        earlyAccessDeadline: getEarlyAccessDeadline({
          earlyAccessTimeframe: nextEarlyAccess.earlyAccessTimeFrame,
          versionCreatedAt: nextEarlyAccess.createdAt,
          publishedAt: model.publishedAt,
        }),
      },
    });
  } else {
    await updateModelById({ id, data: { earlyAccessDeadline: null } });
  }
};

export const getModelsByCategory = async ({
  user,
  tag,
  tagname,
  cursor,
  ...input
}: GetModelsByCategoryInput & { user?: SessionUser }) => {
  input.limit ??= 10;
  let categories = await getTypeCategories({
    type: 'model',
    excludeIds: input.excludedTagIds,
    limit: input.limit + 1,
    cursor,
  });

  let nextCursor: number | null = null;
  if (categories.length > input.limit) nextCursor = categories.pop()?.id ?? null;
  categories = categories.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.random() - 0.5;
  });

  const items = await Promise.all(
    categories.map((c) =>
      getModels({
        input: { ...input, tagname: c.name, take: input.modelLimit ?? 21 },
        user,
        // Can we make this into a select schema? (low pri)
        select: {
          id: true,
          name: true,
          type: true,
          nsfw: true,
          status: true,
          createdAt: true,
          lastVersionAt: true,
          publishedAt: true,
          locked: true,
          earlyAccessDeadline: true,
          mode: true,
          rank: {
            select: {
              [`downloadCount${input.period}`]: true,
              [`favoriteCount${input.period}`]: true,
              [`commentCount${input.period}`]: true,
              [`ratingCount${input.period}`]: true,
              [`rating${input.period}`]: true,
            },
          },
          modelVersions: {
            orderBy: { index: 'asc' },
            take: 1,
            select: {
              id: true,
              earlyAccessTimeFrame: true,
              createdAt: true,
            },
          },
          user: { select: simpleUserSelect },
          hashes: {
            select: modelHashSelect,
            where: {
              hashType: ModelHashType.SHA256,
              fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
            },
          },
        },
      }).then(({ items }) => ({
        ...c,
        items,
      }))
    )
  );

  const modelVersionIds = items
    .flatMap((m) => m.items)
    .flatMap((m) => m.modelVersions)
    .map((m) => m.id);
  const images = !!modelVersionIds.length
    ? await getImagesForModelVersion({
        modelVersionIds,
        excludedTagIds: input.excludedImageTagIds,
        excludedIds: await getHiddenImagesForUser({ userId: user?.id }),
        excludedUserIds: input.excludedUserIds,
        currentUserId: user?.id,
      })
    : [];

  const result = {
    nextCursor,
    items: items.map(({ items, ...c }) => ({
      ...c,
      items: items
        .map(({ hashes, modelVersions, rank, ...model }) => {
          const [version] = modelVersions;
          if (!version) return null;
          const [image] = images.filter((i) => i.modelVersionId === version.id);
          if (!image) return null;

          return {
            ...model,
            hashes: hashes.map((hash) => hash.hash.toLowerCase()),
            rank: {
              downloadCount: rank?.[`downloadCount${input.period}`] ?? 0,
              favoriteCount: rank?.[`favoriteCount${input.period}`] ?? 0,
              commentCount: rank?.[`commentCount${input.period}`] ?? 0,
              ratingCount: rank?.[`ratingCount${input.period}`] ?? 0,
              rating: rank?.[`rating${input.period}`] ?? 0,
            },
            image:
              model.mode !== ModelModifier.TakenDown
                ? (image as (typeof images)[0] | undefined)
                : undefined,
            // earlyAccess,
          };
        })
        .filter(isDefined),
    })),
  };

  return result;
};

export const getAllModelsWithCategories = async ({
  userId,
  limit,
  page,
}: GetModelsWithCategoriesSchema) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.ModelFindManyArgs['where'] = {
    status: { in: [ModelStatus.Published, ModelStatus.Draft] },
    deletedAt: null,
    userId,
  };

  const modelCategories = await getCategoryTags('model');
  const categoryIds = modelCategories.map((c) => c.id);

  try {
    const [models, count] = await dbRead.$transaction([
      dbRead.model.findMany({
        take,
        skip,
        where,
        select: {
          id: true,
          name: true,
          tagsOnModels: {
            where: { tagId: { in: categoryIds } },
            select: {
              tag: {
                select: { id: true, name: true },
              },
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
      dbRead.model.count({ where }),
    ]);
    const items = models.map(({ tagsOnModels, ...model }) => ({
      ...model,
      tags: tagsOnModels.map(({ tag }) => tag),
    }));

    return getPagingData({ items, count }, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setModelsCategory = async ({
  categoryId,
  modelIds,
  userId,
}: SetModelsCategoryInput & { userId: number }) => {
  try {
    const modelCategories = await getCategoryTags('model');
    const category = modelCategories.find((c) => c.id === categoryId);
    if (!category) throw throwNotFoundError(`No category with id ${categoryId}`);

    const models = Prisma.join(modelIds);
    const allCategories = Prisma.join(modelCategories.map((c) => c.id));

    // Remove all categories from models
    await dbWrite.$executeRaw`
      DELETE FROM "TagsOnModels" tom
      USING "Model" m
      WHERE m.id = tom."modelId"
        AND m."userId" = ${userId}
        AND "modelId" IN (${models})
        AND "tagId" IN (${allCategories})
    `;

    // Add category to models
    await dbWrite.$executeRaw`
      INSERT INTO "TagsOnModels" ("modelId", "tagId")
      SELECT m.id, ${categoryId}
      FROM "Model" m
      WHERE m."userId" = ${userId}
        AND m.id IN (${models})
      ON CONFLICT ("modelId", "tagId") DO NOTHING;
    `;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// #region [associated models]
export const getAssociatedResourcesSimple = async ({
  fromId,
  type,
}: GetAssociatedResourcesInput) => {
  const associations = await dbWrite.modelAssociations.findMany({
    where: { fromModelId: fromId, type },
    orderBy: { index: 'asc' },
    select: {
      id: true,
      toModel: {
        select: associatedResourceSelect,
      },
      toArticle: {
        select: { id: true, title: true, nsfw: true, user: { select: simpleUserSelect } },
      },
    },
  });

  const items = associations
    .map(({ id, toModel, toArticle }) =>
      toModel
        ? { id, item: toModel, resourceType: 'model' as const }
        : toArticle
        ? { id, item: toArticle, resourceType: 'article' as const }
        : null
    )
    .filter(isDefined);

  return items;
};

export const setAssociatedResources = async (
  { fromId, type, associations }: SetAssociatedResourcesInput,
  user?: SessionUser
) => {
  const fromModel = await dbWrite.model.findUnique({
    where: { id: fromId },
    select: {
      userId: true,
      associations: {
        where: { type },
        select: { id: true },
        orderBy: { index: 'asc' },
      },
    },
  });

  if (!fromModel) throw throwNotFoundError();
  // only allow moderators or model owners to add/remove associated models
  if (!user?.isModerator && fromModel.userId !== user?.id) throw throwAuthorizationError();

  const existingAssociations = fromModel.associations.map((x) => x.id);
  const associationsToRemove = existingAssociations.filter(
    (existingToId) => !associations.find((item) => item.id === existingToId)
  );

  return await dbWrite.$transaction([
    // remove associated resources not included in payload
    dbWrite.modelAssociations.deleteMany({
      where: {
        fromModelId: fromId,
        type,
        id: { in: associationsToRemove },
      },
    }),
    // add or update associated models
    ...associations.map((association, index) => {
      const data =
        association.resourceType === 'model'
          ? { fromModelId: fromId, toModelId: association.resourceId, type }
          : { fromModelId: fromId, toArticleId: association.resourceId, type };

      return dbWrite.modelAssociations.upsert({
        where: { id: association.id ?? -1 },
        update: { index },
        create: { ...data, associatedById: user?.id, index },
      });
    }),
  ]);
};
// #endregion

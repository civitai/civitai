import { ModelMeta, ToggleModelLockInput } from './../schema/model.schema';
import {
  CommercialUse,
  MetricTimeframe,
  ModelStatus,
  ModelType,
  Prisma,
  TagTarget,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { ManipulateType } from 'dayjs';
import { isEmpty } from 'lodash-es';
import isEqual from 'lodash/isEqual';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { getImageGenerationProcess } from '~/server/common/model-helpers';
import { Context } from '~/server/createContext';
import { dbWrite, dbRead } from '~/server/db/client';
import { playfab } from '~/server/playfab/client';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllModelsOutput,
  ModelInput,
  ModelUpsertInput,
  PublishModelSchema,
} from '~/server/schema/model.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import {
  imageSelect,
  prepareCreateImage,
  prepareUpdateImage,
} from '~/server/selectors/image.selector';
import { modelWithDetailsSelect } from '~/server/selectors/model.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { ingestNewImages } from '~/server/services/image.service';
import { getEarlyAccessDeadline, isEarlyAccess } from '~/server/utils/early-access-helpers';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { decreaseDate } from '~/utils/date-helpers';
import { prepareFile } from '~/utils/file-helpers';

export const getModel = <TSelect extends Prisma.ModelSelect>({
  id,
  user,
  select,
}: GetByIdInput & {
  user?: SessionUser;
  select: TSelect;
}) => {
  return dbRead.model.findFirst({
    where: {
      id,
      OR: user?.isModerator
        ? undefined
        : [{ status: ModelStatus.Published }, { user: { id: user?.id }, deletedAt: null }],
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
  },
  select,
  user: sessionUser,
  count = false,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & {
    take?: number;
    skip?: number;
    ids?: number[];
  };
  select: TSelect;
  user?: SessionUser;
  count?: boolean;
}) => {
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
    AND.push({ meta: { path: ['needsReview'], equals: true } });
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
      period !== MetricTimeframe.AllTime
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

export const getModelVersionsMicro = ({ id }: { id: number }) => {
  return dbRead.modelVersion.findMany({
    where: { modelId: id },
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

export const deleteModelById = ({ id, userId }: GetByIdInput & { userId: number }) => {
  return dbWrite.model.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'Deleted', deletedBy: userId },
  });
};

export const restoreModelById = ({ id }: GetByIdInput) => {
  return dbWrite.model.update({ where: { id }, data: { deletedAt: null, status: 'Draft' } });
};

export const permaDeleteModelById = ({ id }: GetByIdInput & { userId: number }) => {
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
      select: { id: true },
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
      select: { id: true },
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
      select: { id: true },
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

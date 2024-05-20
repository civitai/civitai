import { truncate, uniq } from 'lodash-es';
import { dbWrite, dbRead } from '~/server/db/client';
import {
  BulkSaveCollectionItemsInput,
  AddCollectionItemInput,
  GetAllCollectionItemsSchema,
  GetAllUserCollectionsInputSchema,
  GetUserCollectionItemsByItemSchema,
  UpdateCollectionItemsStatusInput,
  UpsertCollectionInput,
  GetAllCollectionsInfiniteSchema,
  UpdateCollectionCoverImageInput,
  CollectionMetadataSchema,
} from '~/server/schema/collection.schema';
import { SessionUser } from 'next-auth';
import {
  Collection,
  CollectionContributorPermission,
  CollectionItemStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
  HomeBlockType,
  ImageIngestionStatus,
  MediaType,
  MetricTimeframe,
  Prisma,
} from '@prisma/client';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import type { ArticleGetAll } from '~/server/services/article.service';
import { getArticles } from '~/server/services/article.service';
import {
  getModelsWithImagesAndModelVersions,
  GetModelsWithImagesAndModelVersions,
} from '~/server/services/model.service';
import {
  ArticleSort,
  CollectionReviewSort,
  CollectionSort,
  ImageSort,
  ModelSort,
  NsfwLevel,
  PostSort,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import {
  deleteImageById,
  getAllImages,
  ImagesInfiniteModel,
  ingestImage,
} from '~/server/services/image.service';
import { getPostsInfinite, PostsInfiniteModel } from '~/server/services/post.service';
import {
  GetByIdInput,
  UserPreferencesInput,
  userPreferencesSchema,
} from '~/server/schema/base.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { collectionsSearchIndex } from '~/server/search-index';
import { createNotification } from '~/server/services/notification.service';

export type CollectionContributorPermissionFlags = {
  read: boolean;
  write: boolean;
  writeReview: boolean;
  manage: boolean;
  follow: boolean;
  isContributor: boolean;
  isOwner: boolean;
  followPermissions: CollectionContributorPermission[];
  publicCollection: boolean;
};

export const getAllCollections = async <TSelect extends Prisma.CollectionSelect>({
  input: { limit, cursor, privacy, types, userId, sort, ids },
  user,
  select,
}: {
  input: GetAllCollectionsInfiniteSchema;
  select: TSelect;
  user?: SessionUser;
}) => {
  if (privacy && !user?.isModerator) privacy = [CollectionReadConfiguration.Public];

  const orderBy: Prisma.CollectionFindManyArgs['orderBy'] = [{ createdAt: 'desc' }];
  if (sort === CollectionSort.MostContributors)
    orderBy.unshift({ contributors: { _count: 'desc' } });

  const collections = await dbRead.collection.findMany({
    take: limit,
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      id: ids && ids.length > 0 ? { in: ids } : undefined,
      read: privacy && privacy.length > 0 ? { in: privacy } : CollectionReadConfiguration.Public,
      type: types && types.length > 0 ? { in: types } : undefined,
      userId,
    },
    select,
    orderBy,
  });

  return collections;
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
    read: false,
    write: false,
    writeReview: false,
    manage: false,
    follow: false,
    isContributor: false,
    isOwner: false,
    publicCollection: false,
    followPermissions: [],
  };

  const collection = await dbRead.collection.findFirst({
    select: {
      id: true,
      read: true,
      write: true,
      userId: true,
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
    // Follow will grant write permissions
    permissions.follow = true;
    permissions.followPermissions.push(CollectionContributorPermission.ADD);
  }
  if (collection.write === CollectionWriteConfiguration.Review) {
    // Follow will grant write permissions
    permissions.follow = true;
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

  if (isModerator) {
    permissions.manage = true;
    permissions.read = true;
    permissions.write = true;
  }

  const [contributorItem] = collection.contributors;

  if (!contributorItem) {
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

export const getUserCollectionsWithPermissions = async <
  TSelect extends Prisma.CollectionSelect = Prisma.CollectionSelect
>({
  input,
  select,
}: {
  input: GetAllUserCollectionsInputSchema & { userId: number };
  select: TSelect;
}) => {
  const { userId, permissions, permission, contributingOnly } = input;
  // By default, owned collections will be always returned
  const OR: Prisma.Enumerable<Prisma.CollectionWhereInput> = [{ userId }];

  if (
    permissions &&
    permissions.includes(CollectionContributorPermission.ADD) &&
    !contributingOnly
  ) {
    OR.push({
      write: CollectionWriteConfiguration.Public,
    });
  }

  if (
    permissions &&
    permissions.includes(CollectionContributorPermission.VIEW) &&
    !contributingOnly
  ) {
    // Even with view permission we don't really
    // want to return unlisted unless the user is a contributor
    // with that permission
    OR.push({
      read: CollectionWriteConfiguration.Public,
    });
  }

  if (permissions || permission) {
    OR.push({
      contributors: {
        some: {
          userId,
          permissions: {
            hasSome: permission ? [permission] : permissions,
          },
        },
      },
    });
  }

  const AND: Prisma.Enumerable<Prisma.CollectionWhereInput> = [{ OR }];

  if (input.type) {
    // TODO.collections: Support exclusive type
    AND.push({
      OR: [
        {
          type: input.type,
        },
        {
          type: null,
        },
      ],
    });
  }

  const collections = (await dbRead.collection.findMany({
    where: {
      AND,
    },
    select,
  })) as Collection[];

  // Return user collections first && add isOwner  property
  return collections
    .map((collection) => ({
      ...collection,
      isOwner: collection.userId === userId,
    }))
    .sort(({ userId: collectionUserId }) => (userId === collectionUserId ? -1 : 1));
};

export const getCollectionById = async ({ input }: { input: GetByIdInput }) => {
  const { id } = input;
  const collection = await dbRead.collection.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      read: true,
      write: true,
      type: true,
      user: { select: userWithCosmeticsSelect },
      nsfw: true,
      nsfwLevel: true,
      image: { select: imageSelect },
      mode: true,
      metadata: true,
      availability: true,
    },
  });
  if (!collection) throw throwNotFoundError(`No collection with id ${id}`);

  return {
    ...collection,
    nsfwLevel: collection.nsfwLevel as NsfwLevel,
    image: collection.image
      ? {
          ...collection.image,
          nsfwLevel: collection.image.nsfwLevel as NsfwLevel,
          meta: collection.image.meta as ImageMetaProps | null,
        }
      : null,
    metadata: (collection.metadata ?? {}) as CollectionMetadataSchema,
  };
};

const inputToCollectionType = {
  modelId: CollectionType.Model,
  articleId: CollectionType.Article,
  imageId: CollectionType.Image,
  postId: CollectionType.Post,
} as const;

export const saveItemInCollections = async ({
  input: { collectionIds, type, userId, isModerator, removeFromCollectionIds, ...input },
}: {
  input: AddCollectionItemInput & { userId: number; isModerator?: boolean };
}) => {
  const itemKey = Object.keys(inputToCollectionType).find((key) => input.hasOwnProperty(key));
  if (!itemKey) throw throwBadRequestError(`We don't know the type of thing you're adding`);
  // Safeguard against duppes.
  collectionIds = uniq(collectionIds);
  removeFromCollectionIds = uniq(removeFromCollectionIds);

  const collections = await dbRead.collection.findMany({
    where: {
      id: { in: collectionIds },
    },
  });

  if (itemKey && inputToCollectionType.hasOwnProperty(itemKey)) {
    const type = inputToCollectionType[itemKey as keyof typeof inputToCollectionType];
    // check if all collections match the Model type
    const filteredCollections = collections.filter((c) => c.type === type || c.type == null);

    if (filteredCollections.length !== collectionIds.length) {
      throw throwBadRequestError('Collection type mismatch');
    }
  }

  const data = (
    await Promise.all(
      collectionIds.map(async (collectionId) => {
        const collection = collections.find((c) => c.id === collectionId);

        if (!collection) {
          return null;
        }

        const metadata = (collection?.metadata ?? {}) as CollectionMetadataSchema;
        const permission = await getUserCollectionPermissionsById({
          userId,
          isModerator,
          id: collectionId,
        });

        if (collection.mode === CollectionMode.Contest) {
          await validateContestCollectionEntry({
            metadata,
            collectionId,
            userId,
            [`${itemKey}s`]: [input[itemKey as keyof typeof input]],
          });
        }

        // A shame to hard-code the `featured` name here. Might wanna look into adding a featured mode instead,
        // For now tho, should work
        if (collection.userId == -1 && !collection.mode && collection.name.includes('Featured')) {
          // Assume it's a featured collection:
          await validateFeaturedCollectionEntry({
            [`${itemKey}s`]: [input[itemKey as keyof typeof input]],
          });
        }

        if (!permission.isContributor && !permission.isOwner) {
          // Person adding content to stuff they don't follow.
          return null;
        }

        if (!permission.writeReview && !permission.write) {
          return null;
        }

        return {
          addedById: userId,
          collectionId,
          status: permission.writeReview
            ? CollectionItemStatus.REVIEW
            : CollectionItemStatus.ACCEPTED,
          reviewedById: permission.write ? userId : null,
          reviewedAt: permission.write ? new Date() : null,
          [itemKey]: input[itemKey as keyof typeof input],
        };
      })
    )
  ).filter(isDefined);

  const transactions: Prisma.PrismaPromise<Prisma.BatchPayload | number>[] = [];

  if (data.length > 0) {
    transactions.push(
      dbWrite.$executeRaw`
      INSERT INTO "CollectionItem" ("collectionId", "addedById", "status", "randomId" , "${Prisma.raw(
        itemKey
      )}")
      SELECT
        v."collectionId",
        v."addedById",
        v."status",
        FLOOR(RANDOM() * 1000000000),
        v."${Prisma.raw(itemKey)}"
      FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS v(
        "collectionId" INTEGER,
        "addedById" INTEGER,
        "status" "CollectionItemStatus",
        "${Prisma.raw(itemKey)}" INTEGER
      )
      ON CONFLICT ("collectionId", "${Prisma.raw(itemKey)}")
        WHERE "${Prisma.raw(itemKey)}" IS NOT NULL
        DO NOTHING;
    `
    );
  }

  if (removeFromCollectionIds?.length) {
    const removeAllowedCollectionItemIds = (
      await Promise.all(
        removeFromCollectionIds.map(async (collectionId) => {
          const permission = await getUserCollectionPermissionsById({
            userId,
            isModerator,
            id: collectionId,
          });

          const item = await dbRead.collectionItem.findFirst({
            where: {
              collectionId,
              ...input,
            },
            select: {
              addedById: true,
              id: true,
            },
          });

          if (!item) {
            return null;
          }

          if (item.addedById !== userId && !permission.isOwner && !permission.manage) {
            // This person shouldn't cannot be removing that item
            return null;
          }

          return item.id;
        })
      )
    ).filter(isDefined);

    if (removeAllowedCollectionItemIds.length > 0)
      transactions.push(
        dbWrite.collectionItem.deleteMany({
          where: { id: { in: removeAllowedCollectionItemIds } },
        })
      );
  }

  // if we have items to remove, add a deleteMany mutation to the transaction

  await Promise.all(
    collectionIds.map((collectionId) => homeBlockCacheBust(HomeBlockType.Collection, collectionId))
  );

  await dbWrite.$transaction(transactions);

  return data.length > 0 ? 'added' : removeFromCollectionIds?.length > 0 ? 'removed' : null;
};

export const upsertCollection = async ({
  input,
}: {
  input: UpsertCollectionInput & { userId: number; isModerator?: boolean };
}) => {
  const {
    userId,
    isModerator,
    id,
    name,
    description,
    image,
    imageId,
    read,
    write,
    type,
    nsfw,
    mode,
    metadata,
    ...collectionItem
  } = input;

  if (id) {
    const permission = await getUserCollectionPermissionsById({
      id,
      userId,
      isModerator,
    });
    if (!permission.manage) {
      throw throwAuthorizationError('You do not have permission to manage this collection');
    }

    // Get current collection values for comparison
    const currentCollection = await dbWrite.collection.findUnique({
      where: { id },
      select: { id: true, mode: true, image: { select: { id: true } } },
    });
    if (!currentCollection) throw throwNotFoundError(`No collection with id ${id}`);

    const updated = await dbWrite.$transaction(async (tx) => {
      const updated = await tx.collection.update({
        select: {
          id: true,
          mode: true,
          image: { select: { id: true, url: true, ingestion: true, type: true } },
          read: true,
          write: true,
          userId: true,
        },
        where: { id },
        data: {
          name,
          description,
          nsfw,
          read,
          write,
          mode,
          metadata: (metadata ?? {}) as Prisma.JsonObject,
          image: imageId
            ? { connect: { id: imageId } }
            : image !== undefined
            ? image === null
              ? { disconnect: true }
              : {
                  connectOrCreate: {
                    where: { id: image.id ?? -1 },
                    create: {
                      ...image,
                      meta: (image?.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                      userId,
                      resources: undefined,
                    },
                  },
                }
            : undefined,
        },
      });

      if (updated.mode !== currentCollection.mode && updated.mode === CollectionMode.Contest) {
        await tx.$executeRaw`
            UPDATE "CollectionItem" ci SET "randomId" = FLOOR(RANDOM() * 1000000000)
            WHERE ci."collectionId" = ${updated.id}
        `;
      }
      return updated;
    });

    if (input.read === CollectionReadConfiguration.Public) {
      // Set publishedAt for all post belonging to this collection if changing privacy to public
      await dbWrite.post.updateMany({
        where: { collectionId: updated.id },
        data: { publishedAt: new Date() },
      });
    } else if (!updated.mode) {
      // otherwise set publishedAt to null
      await dbWrite.post.updateMany({
        where: { collectionId: updated.id },
        data: { publishedAt: null },
      });
    }

    // Update contributors:
    if (
      (input.write && input.write !== updated.write) ||
      (input.read && input.read !== updated.read)
    ) {
      // Update contributors permissions:
      const permissions: CollectionContributorPermission[] = [];
      if (updated.read !== CollectionReadConfiguration.Private) {
        permissions.push(CollectionContributorPermission.VIEW);
      }

      if (updated.write === CollectionWriteConfiguration.Public) {
        permissions.push(CollectionContributorPermission.ADD);
      }

      if (updated.write === CollectionWriteConfiguration.Review) {
        permissions.push(CollectionContributorPermission.ADD_REVIEW);
      }

      await dbWrite.collectionContributor.updateMany({
        where: {
          collectionId: updated.id,
          userId: {
            not: updated.userId,
          },
        },
        data: {
          permissions,
        },
      });
    }

    // Start image ingestion only if it's ingestion status is pending
    if (updated.image && updated.image.ingestion === ImageIngestionStatus.Pending) {
      await ingestImage({ image: updated.image });
    }

    // Delete image if it was removed
    if (currentCollection.image && !input.image) {
      await deleteImageById({ id: currentCollection.image.id });
    }

    return updated;
  }

  const collection = await dbWrite.collection.create({
    select: { id: true, image: { select: { id: true, url: true } } },
    data: {
      name,
      description,
      nsfw,
      read,
      write,
      userId,
      type,
      mode,
      metadata: (metadata ?? {}) as Prisma.JsonObject,
      contributors: {
        create: {
          userId,
          permissions: [
            CollectionContributorPermission.MANAGE,
            CollectionContributorPermission.ADD,
            CollectionContributorPermission.VIEW,
          ],
        },
      },
      items: { create: { ...collectionItem, imageId, addedById: userId } },
    },
  });

  return collection;
};

export const updateCollectionCoverImage = async ({
  input,
}: {
  input: UpdateCollectionCoverImageInput & { userId: number; isModerator?: boolean };
}) => {
  const { id, imageId, userId, isModerator } = input;
  const permission = await getUserCollectionPermissionsById({
    id,
    userId,
    isModerator,
  });

  if (!permission.manage) {
    return;
  }

  const updated = await dbWrite.collection.update({
    select: { id: true, image: { select: { id: true, url: true, ingestion: true, type: true } } },
    where: { id },
    data: {
      image: { connect: { id: imageId } },
    },
  });

  if (!updated) throw throwNotFoundError(`No collection with id ${id}`);

  return updated;
};

interface ModelCollectionItem {
  type: 'model';
  data: GetModelsWithImagesAndModelVersions;
}

interface PostCollectionItem {
  type: 'post';
  data: PostsInfiniteModel;
}

interface ImageCollectionItem {
  type: 'image';
  data: ImagesInfiniteModel;
}

interface ArticleCollectionItem {
  type: 'article';
  data: ArticleGetAll[0];
}

export type CollectionItemExpanded = {
  id: number;
  status?: CollectionItemStatus;
  createdAt: Date | null;
} & (ModelCollectionItem | PostCollectionItem | ImageCollectionItem | ArticleCollectionItem);

export const getCollectionItemsByCollectionId = async ({
  input,
  user,
}: {
  input: UserPreferencesInput & GetAllCollectionItemsSchema;
  // Requires user here because models service uses it
  user?: SessionUser;
}) => {
  const {
    statuses = [CollectionItemStatus.ACCEPTED],
    limit,
    collectionId,
    page,
    cursor,
    forReview,
    reviewSort,
  } = input;

  const skip = page && limit ? (page - 1) * limit : undefined;

  const userPreferencesInput = userPreferencesSchema.parse(input);

  const permission = await getUserCollectionPermissionsById({
    id: input.collectionId,
    userId: user?.id,
    isModerator: user?.isModerator,
  });

  if (
    (statuses.includes(CollectionItemStatus.REVIEW) ||
      statuses.includes(CollectionItemStatus.REJECTED)) &&
    !permission.isOwner &&
    !permission.manage
  ) {
    throw throwAuthorizationError('You do not have permission to view review items');
  }

  const collection = await dbRead.collection.findUniqueOrThrow({ where: { id: collectionId } });

  const where: Prisma.CollectionItemWhereInput = {
    collectionId,
    status: { in: statuses },
    // Ensure we only show images that have been scanned
    image:
      collection.type === CollectionType.Image
        ? {
            ingestion: ImageIngestionStatus.Scanned,
          }
        : undefined,
  };

  const orderBy: Prisma.CollectionItemFindManyArgs['orderBy'] = [];

  if (!forReview && collection.mode === CollectionMode.Contest) {
    orderBy.push({ randomId: 'desc' });
  } else if (forReview && reviewSort === CollectionReviewSort.Newest) {
    orderBy.push({ createdAt: 'desc' });
  } else if (forReview && reviewSort === CollectionReviewSort.Oldest) {
    orderBy.push({ createdAt: 'asc' });
  } else {
    orderBy.push({ createdAt: 'desc' });
  }

  const collectionItems = await dbRead.collectionItem.findMany({
    take: limit,
    skip,
    cursor: cursor ? { id: cursor } : undefined,
    select: {
      id: true,
      modelId: true,
      postId: true,
      imageId: true,
      articleId: true,
      status: input.forReview,
      createdAt: true,
      randomId: true,
    },
    where,
    orderBy,
  });

  if (collectionItems.length === 0) {
    return [];
  }

  const modelIds = collectionItems.map((item) => item.modelId).filter(isDefined);

  const models =
    modelIds.length > 0
      ? await getModelsWithImagesAndModelVersions({
          user,
          input: {
            limit: modelIds.length,
            sort: ModelSort.Newest,
            period: MetricTimeframe.AllTime,
            periodMode: 'stats',
            hidden: false,
            favorites: false,
            ...userPreferencesInput,
            ids: modelIds,
            browsingLevel: input.browsingLevel,
          },
        })
      : { items: [] };

  const articleIds = collectionItems.map((item) => item.articleId).filter(isDefined);

  const articles =
    articleIds.length > 0
      ? await getArticles({
          limit: articleIds.length,
          period: MetricTimeframe.AllTime,
          periodMode: 'stats',
          sort: ArticleSort.Newest,
          ...userPreferencesInput,
          browsingLevel: input.browsingLevel,
          sessionUser: user,
          ids: articleIds,
          include: ['cosmetics'],
        })
      : { items: [] };

  const imageIds = collectionItems.map((item) => item.imageId).filter(isDefined);

  const images =
    imageIds.length > 0
      ? await getAllImages({
          include: ['cosmetics', 'tagIds', 'profilePictures'],
          limit: imageIds.length,
          period: MetricTimeframe.AllTime,
          periodMode: 'stats',
          sort: ImageSort.Newest,
          ...userPreferencesInput,
          browsingLevel: input.browsingLevel,
          user,
          ids: imageIds,
          headers: { src: 'getCollectionItemsByCollectionId' },
          includeBaseModel: true,
        })
      : { items: [] };

  const postIds = collectionItems.map((item) => item.postId).filter(isDefined);

  const posts =
    postIds.length > 0
      ? await getPostsInfinite({
          limit: postIds.length,
          period: MetricTimeframe.AllTime,
          periodMode: 'published',
          sort: PostSort.Newest,
          ...userPreferencesInput,
          user,
          browsingLevel: input.browsingLevel,
          ids: postIds,
          include: ['cosmetics'],
        })
      : { items: [] };

  const collectionItemsExpanded: CollectionItemExpanded[] = collectionItems
    .map(({ imageId, postId, articleId, modelId, ...collectionItemRemainder }) => {
      if (modelId) {
        // Get all model info:
        const model = models.items.find((m) => m.id === modelId);
        if (!model) {
          return null;
        }

        return {
          ...collectionItemRemainder,
          type: 'model' as const,
          data: model,
        };
      }

      if (postId) {
        const post = posts.items.find((p) => p.id === postId);

        if (!post) {
          return null;
        }

        return {
          ...collectionItemRemainder,
          type: 'post' as const,
          data: post,
        };
      }

      if (imageId) {
        const image = images.items.find((i) => i.id === imageId);

        if (!image) {
          return null;
        }

        return {
          ...collectionItemRemainder,
          type: 'image' as const,
          data: image,
        };
      }

      if (articleId) {
        const article = articles.items.find((a) => a.id === articleId);

        if (!article) {
          return null;
        }

        return {
          ...collectionItemRemainder,
          type: 'article' as const,
          data: article,
        };
      }

      return null;
    })
    .filter(isDefined)
    .filter((collectionItem) => !!collectionItem.data);

  return collectionItemsExpanded;
};

export const getUserCollectionItemsByItem = async ({
  input,
}: {
  input: GetUserCollectionItemsByItemSchema & { userId: number; isModerator?: boolean };
}) => {
  const { userId, isModerator, modelId, imageId, articleId, postId } = input;

  const userCollections = await getUserCollectionsWithPermissions({
    input: {
      permissions: [
        CollectionContributorPermission.ADD,
        CollectionContributorPermission.ADD_REVIEW,
        CollectionContributorPermission.MANAGE,
      ],
      userId,
    },
    select: { id: true, userId: true },
  });

  if (userCollections.length === 0) return [];

  const collectionItems = await dbRead.collectionItem.findMany({
    select: {
      collectionId: true,
      addedById: true,
      collection: {
        select: {
          userId: true,
        },
      },
    },
    where: {
      collectionId: {
        in: userCollections.map((c) => c.id),
      },
      OR: [{ modelId }, { imageId }, { postId }, { articleId }],
    },
  });

  return Promise.all(
    collectionItems.map(async (collectionItem) => {
      const permission = await getUserCollectionPermissionsById({
        id: collectionItem.collectionId,
        userId,
        isModerator,
      });

      return {
        ...collectionItem,
        canRemoveItem: collectionItem.addedById === userId || permission.manage,
      };
    })
  );
};

export const deleteCollectionById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator?: boolean }) => {
  const collection = await dbRead.collection.findFirstOrThrow({
    // Confirm the collection belongs to the user:
    where: { id, userId: isModerator ? undefined : userId },
    select: { id: true, mode: true },
  });

  if (collection.mode === CollectionMode.Bookmark) {
    throw throwBadRequestError('You cannot delete a bookmark collection');
  }

  const res = await dbWrite.collection.delete({ where: { id } });

  await collectionsSearchIndex.queueUpdate([
    {
      id,
      action: SearchIndexUpdateQueueAction.Delete,
    },
  ]);

  return res;
};

export const addContributorToCollection = async ({
  collectionId,
  userId,
  targetUserId,
  permissions,
}: {
  userId: number;
  targetUserId: number;
  collectionId: number;
  permissions?: CollectionContributorPermission[];
}) => {
  // check if user can add contributors:
  const { followPermissions, manage, follow } = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
  });

  if (!manage && !follow) {
    throw throwAuthorizationError(
      'You do not have permission to add contributors to this collection.'
    );
  }

  const contributorPermissions =
    permissions && permissions.length > 0 ? permissions : followPermissions;

  if (!contributorPermissions.length) {
    return; // Can't add this user as contributor due to lacking permissions.
  }

  return dbWrite.collectionContributor.upsert({
    where: { userId_collectionId: { userId: targetUserId, collectionId } },
    create: { userId: targetUserId, collectionId, permissions: contributorPermissions },
    update: { permissions: contributorPermissions },
  });
};

export const removeContributorFromCollection = async ({
  userId,
  targetUserId,
  collectionId,
}: {
  userId: number;
  targetUserId: number;
  collectionId: number;
}) => {
  const { manage } = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
  });

  if (!manage && targetUserId !== userId) {
    throw throwAuthorizationError(
      'You do not have permission to remove contributors from this collection.'
    );
  }
  try {
    return await dbWrite.collectionContributor.delete({
      where: {
        userId_collectionId: {
          userId: targetUserId,
          collectionId,
        },
      },
    });
  } catch {
    // Ignore errors
  }
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
        { status: CollectionItemStatus.ACCEPTED },
        { AND: [{ status: CollectionItemStatus.REVIEW }, { addedById: userId }] },
      ],
    });

    rawAND.push(
      Prisma.sql`(ci."status" = ${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus" OR (ci."status" = ${CollectionItemStatus.REVIEW}::"CollectionItemStatus" AND ci."addedById" = ${userId}))`
    );
  } else {
    AND.push({ status: CollectionItemStatus.ACCEPTED });
    rawAND.push(Prisma.sql`ci."status" = ${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus"`);
  }

  return { AND, rawAND };
};

export const updateCollectionItemsStatus = async ({
  input,
  userId,
  isModerator,
}: {
  input: UpdateCollectionItemsStatusInput;
  userId: number;
  isModerator?: boolean;
}) => {
  const { collectionId, collectionItemIds, status } = input;

  // Check if collection actually exists before anything
  const collection = await dbWrite.collection.findUnique({
    where: { id: collectionId },
    select: { id: true, type: true, mode: true, name: true },
  });

  if (!collection) throw throwNotFoundError('No collection with id ' + collectionId);

  const { manage, isOwner } = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
    isModerator,
  });

  if (!manage && !isOwner)
    throw throwAuthorizationError('You do not have permissions to manage contributor item status.');

  if (collectionItemIds.length > 0) {
    await dbWrite.$executeRaw`
      UPDATE "CollectionItem"
      SET "reviewedById" = ${userId}, "reviewedAt" = ${new Date()}, "status" = ${status}::"CollectionItemStatus" ${Prisma.raw(
      collection.mode === CollectionMode.Contest
        ? ', "randomId" = FLOOR(RANDOM() * 1000000000)'
        : ''
    )}
      WHERE "collectionId" = ${collectionId} AND "id" IN (${Prisma.join(collectionItemIds)})
    `;
  }

  if (collection.mode === CollectionMode.Contest) {
    const updatedItems = await dbWrite.collectionItem.findMany({
      where: { id: { in: collectionItemIds }, collectionId },
    });

    await Promise.all(
      updatedItems.map(async (item) => {
        if (!item.addedById) {
          return;
        }

        await createNotification({
          type: 'contest-collection-item-status-change',
          userId: item.addedById,
          category: 'Update',
          details: {
            status,
            collectionId: collection.id,
            collectionName: collection.name,
            imageId: item.imageId,
            articleId: item.articleId,
            modelId: item.modelId,
            postId: item.postId,
          },
        });
      })
    );
  }

  // Send back the collection to update/invalidate state accordingly
  return collection;
};

export function getCollectionItemCount({
  collectionIds: ids,
  status,
}: {
  collectionIds: number[];
  status?: CollectionItemStatus;
}) {
  const where = [Prisma.sql`"collectionId" IN (${Prisma.join(ids)})`];
  if (status) where.push(Prisma.sql`"status" = ${status}::"CollectionItemStatus"`);

  return dbRead.$queryRaw<{ id: number; count: number }[]>`
    SELECT "collectionId" as "id", COUNT(*) as "count"
    FROM "CollectionItem"
    WHERE ${Prisma.sql`${Prisma.join(where, ' AND ')}`}
    GROUP BY "collectionId"
  `;
}

export function getContributorCount({ collectionIds: ids }: { collectionIds: number[] }) {
  const where = [Prisma.sql`"collectionId" IN (${Prisma.join(ids)})`];

  return dbRead.$queryRaw<{ id: number; count: number }[]>`
    SELECT "collectionId" as "id", COUNT(*) as "count"
    FROM "CollectionContributor"
    WHERE ${Prisma.sql`${Prisma.join(where, ' AND ')}`}
    GROUP BY "collectionId"
  `;
}

const validateContestCollectionEntry = async ({
  collectionId,
  userId,
  metadata,
  articleIds = [],
  modelIds = [],
  imageIds = [],
  postIds = [],
}: {
  collectionId: number;
  userId: number;
  metadata?: CollectionMetadataSchema;
  articleIds?: number[];
  modelIds?: number[];
  imageIds?: number[];
  postIds?: number[];
}) => {
  if (!metadata) {
    return;
  }

  const savedItemsCount =
    (articleIds?.length ?? 0) +
    (modelIds?.length ?? 0) +
    (imageIds?.length ?? 0) +
    (postIds?.length ?? 0);

  if (metadata.maxItemsPerUser) {
    // check how many items user has created:
    const itemCount = await dbRead.collectionItem.count({
      where: {
        collectionId,
        addedById: userId,
      },
    });

    if (itemCount + savedItemsCount > metadata.maxItemsPerUser) {
      throw throwBadRequestError(`You have reached the maximum number of items in collection`);
    }
  }

  if (
    (metadata.submissionStartDate && new Date(metadata.submissionStartDate) > new Date()) ||
    (metadata.submissionEndDate && new Date(metadata.submissionEndDate) < new Date())
  ) {
    throw throwBadRequestError('Collection is not accepting submissions at this time');
  }

  if (metadata.submissionStartDate) {
    // confirm items were created after the start date
    if (articleIds.length > 0) {
      const articles = await dbRead.article.findMany({
        where: {
          id: { in: articleIds },
          createdAt: { lt: new Date(metadata.submissionStartDate) },
        },
      });

      if (articles.length > 0) {
        throw throwBadRequestError(
          `Some articles were created before the submission start date. Please only upload items that were created after the submission period started.`
        );
      }
    }

    if (modelIds.length > 0) {
      const models = await dbRead.model.findMany({
        where: {
          id: { in: modelIds },
          createdAt: { lt: new Date(metadata.submissionStartDate) },
        },
      });

      if (models.length > 0) {
        throw throwBadRequestError(
          `Some models were created before the submission start date. Please only upload items that were created after the submission period started.`
        );
      }
    }

    if (imageIds.length > 0) {
      const images = await dbRead.image.findMany({
        where: {
          id: { in: imageIds },
          createdAt: { lt: new Date(metadata.submissionStartDate) },
        },
      });

      if (images.length > 0) {
        throw throwBadRequestError(
          `Some images were created before the submission start date. Please only upload items that were created after the submission period started.`
        );
      }
    }

    if (postIds.length > 0) {
      const posts = await dbRead.post.findMany({
        where: {
          id: { in: postIds },
          createdAt: { lt: new Date(metadata.submissionStartDate) },
        },
      });

      if (posts.length > 0) {
        throw throwBadRequestError(
          `Some posts were created before the submission start date. Please only upload items that were created after the submission period started.`
        );
      }
    }
  }

  // Check the entry is not on a feature collection:
  const featuredCollections = await dbRead.collection.findMany({
    where: {
      userId: -1, // Civit
      mode: null, // Not contest or anything like that
      name: {
        contains: 'Featured',
      },
    },
    select: {
      id: true,
    },
  });

  if (featuredCollections.length > 0) {
    // confirm no collection items exists on those for this contest collection:
    const existingCollectionItemsOnFeaturedCollections = await dbRead.collectionItem.findFirst({
      where: {
        collectionId: {
          in: featuredCollections.map((f) => f.id),
        },
        modelId: modelIds.length > 0 ? { in: modelIds } : undefined,
        imageId: imageIds.length > 0 ? { in: imageIds } : undefined,
        articleId: articleIds.length > 0 ? { in: articleIds } : undefined,
        postId: postIds.length > 0 ? { in: postIds } : undefined,
      },
    });

    if (existingCollectionItemsOnFeaturedCollections) {
      throw throwBadRequestError(
        'At least one of the items provided is already featured by civitai and cannot be added to the contest.'
      );
    }
  }
};

const validateFeaturedCollectionEntry = async ({
  articleIds = [],
  modelIds = [],
  imageIds = [],
  postIds = [],
}: {
  articleIds?: number[];
  modelIds?: number[];
  imageIds?: number[];
  postIds?: number[];
}) => {
  // Check the entry is not on a feature collection:
  const contestCollectionIds = await dbRead.collection.findMany({
    where: {
      mode: CollectionMode.Contest,
    },
    select: {
      id: true,
    },
  });

  if (contestCollectionIds.length > 0) {
    // confirm no collection items exists on those for this contest collection:
    const existingCollectionItemsOnContestCollection = await dbRead.collectionItem.findFirst({
      where: {
        collectionId: {
          in: contestCollectionIds.map((f) => f.id),
        },
        modelId: modelIds.length > 0 ? { in: modelIds } : undefined,
        imageId: imageIds.length > 0 ? { in: imageIds } : undefined,
        articleId: articleIds.length > 0 ? { in: articleIds } : undefined,
        postId: postIds.length > 0 ? { in: postIds } : undefined,
      },
    });

    if (existingCollectionItemsOnContestCollection) {
      throw throwBadRequestError(
        'At least one of the items provided is already in a contest collection and cannot be added to the featured collections.'
      );
    }
  }
};

export const bulkSaveItems = async ({
  input: { userId, collectionId, articleIds = [], modelIds = [], imageIds = [], postIds = [] },
  permissions,
}: {
  input: BulkSaveCollectionItemsInput & { userId: number };
  permissions: CollectionContributorPermissionFlags;
}) => {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: { type: true, metadata: true, name: true, userId: true, mode: true },
  });

  if (!collection) throw throwNotFoundError('No collection with id ' + collectionId);

  const metadata = (collection.metadata ?? {}) as CollectionMetadataSchema;

  if (collection.mode === CollectionMode.Contest) {
    await validateContestCollectionEntry({
      metadata,
      collectionId,
      userId,
      articleIds,
      modelIds,
      imageIds,
      postIds,
    });
  }

  if (collection.userId == -1 && !collection.mode && collection.name.includes('Featured')) {
    // Assume it's a featured collection:
    await validateFeaturedCollectionEntry({
      articleIds,
      modelIds,
      imageIds,
      postIds,
    });
  }

  const baseData = {
    collectionId,
    addedById: userId,
    status: permissions.writeReview ? CollectionItemStatus.REVIEW : CollectionItemStatus.ACCEPTED,
    reviewedAt: permissions.write ? new Date() : null,
    reviewedById: permissions.write ? userId : null,
  };
  let data: Prisma.CollectionItemCreateManyInput[] = [];
  if (
    articleIds.length > 0 &&
    (collection.type === CollectionType.Article || collection.type === null)
  ) {
    const existingArticleIds = (
      await dbRead.collectionItem.findMany({
        select: {
          articleId: true,
          article: {
            select: {
              createdAt: true,
            },
          },
        },
        where: { articleId: { in: articleIds }, collectionId },
      })
    ).map((item) => item.articleId);

    data = articleIds
      .filter((id) => !existingArticleIds.includes(id))
      .map((articleId) => ({
        articleId,
        ...baseData,
      }));
  }

  if (
    modelIds.length > 0 &&
    (collection.type === CollectionType.Model || collection.type === null)
  ) {
    const existingModelIds = (
      await dbRead.collectionItem.findMany({
        select: { modelId: true },
        where: { modelId: { in: modelIds }, collectionId },
      })
    ).map((item) => item.modelId);

    data = modelIds
      .filter((id) => !existingModelIds.includes(id))
      .map((modelId) => ({
        modelId,
        ...baseData,
      }));
  }
  if (
    imageIds.length > 0 &&
    (collection.type === CollectionType.Image || collection.type === null)
  ) {
    const existingImageIds = (
      await dbRead.collectionItem.findMany({
        select: { imageId: true },
        where: { imageId: { in: imageIds }, collectionId },
      })
    ).map((item) => item.imageId);

    data = imageIds
      .filter((id) => !existingImageIds.includes(id))
      .map((imageId) => ({
        imageId,
        ...baseData,
      }));
  }
  if (postIds.length > 0 && (collection.type === CollectionType.Post || collection.type === null)) {
    const existingPostIds = (
      await dbRead.collectionItem.findMany({
        select: { postId: true },
        where: { postId: { in: postIds }, collectionId },
      })
    ).map((item) => item.postId);

    data = postIds
      .filter((id) => !existingPostIds.includes(id))
      .map((postId) => ({
        postId,
        ...baseData,
      }));
  }

  await homeBlockCacheBust(HomeBlockType.Collection, collectionId);

  return dbWrite.collectionItem.createMany({ data });
};

type ImageProps = {
  type: MediaType;
  id: number;
  createdAt: Date;
  name: string | null;
  url: string;
  hash: string | null;
  height: number | null;
  width: number | null;
  nsfwLevel: NsfwLevel;
  postId: number | null;
  index: number | null;
  scannedAt: Date | null;
  mimeType: string | null;
  meta: Prisma.JsonObject | null;
  userId: number;
} | null;

type CollectionImageRaw = {
  id: number;
  image: ImageProps | null;
  src: string | null;
};

export const getCollectionCoverImages = async ({
  collectionIds,
  imagesPerCollection,
}: {
  collectionIds: number[];
  imagesPerCollection: number;
}) => {
  const imageSql = Prisma.sql`
    jsonb_build_object(
        'id', i."id",
        'index', i."index",
        'postId', i."postId",
        'name', i."name",
        'url', i."url",
        'nsfw', i."nsfw",
        'nsfwLevel', i."nsfwLevel",
        'width', i."width",
        'height', i."height",
        'hash', i."hash",
        'createdAt', i."createdAt",
        'mimeType', i."mimeType",
        'scannedAt', i."scannedAt",
        'type', i."type",
        'meta', i."meta",
        'userId', i."userId"
      ) image
  `;

  const itemImages: CollectionImageRaw[] =
    collectionIds?.length > 0
      ? await dbRead.$queryRaw<CollectionImageRaw[]>`
    WITH target AS MATERIALIZED (
      SELECT *
      FROM (
        SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY ci."collectionId"
            ORDER BY ci.id
          ) AS idx
        FROM "CollectionItem" ci
        WHERE ci.status = 'ACCEPTED'
          AND ci."collectionId" IN (${Prisma.join(collectionIds)})
      ) t
      WHERE idx <= ${imagesPerCollection}
    ), imageItemImage AS MATERIALIZED (
      SELECT
        i.id,
        ${imageSql}
      FROM "Image" i
      WHERE i.id IN (SELECT "imageId" FROM target WHERE "imageId" IS NOT NULL)
        AND i."ingestion" = 'Scanned'
        AND i."needsReview" IS NULL
    ), postItemImage AS MATERIALIZED (
      SELECT * FROM (
          SELECT
            i."postId" id,
            ${imageSql},
            ROW_NUMBER() OVER (PARTITION BY i."postId" ORDER BY i.index) rn
          FROM "Image" i
          WHERE i."postId" IN (SELECT "postId" FROM target WHERE "postId" IS NOT NULL)
            AND i."ingestion" = 'Scanned'
            AND i."needsReview" IS NULL
      ) t
      WHERE t.rn = 1
    ), modelItemImage AS MATERIALIZED (
      SELECT * FROM (
          SELECT
            m.id,
            ${imageSql},
            ROW_NUMBER() OVER (PARTITION BY m.id ORDER BY mv.index, i."postId", i.index) rn
          FROM "Image" i
          JOIN "Post" p ON p.id = i."postId"
          JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
          JOIN "Model" m ON mv."modelId" = m.id AND m."userId" = p."userId"
          WHERE m."id" IN (SELECT "modelId" FROM target WHERE "modelId" IS NOT NULL)
              AND i."ingestion" = 'Scanned'
              AND i."needsReview" IS NULL
      ) t
      WHERE t.rn = 1
    ), articleItemImage as MATERIALIZED (
        SELECT a.id, a.cover image FROM "Article" a
        WHERE a.id IN (SELECT "articleId" FROM target)
    )
    SELECT
        target."collectionId" id,
        COALESCE(
          (SELECT image FROM imageItemImage iii WHERE iii.id = target."imageId"),
          (SELECT image FROM postItemImage pii WHERE pii.id = target."postId"),
          (SELECT image FROM modelItemImage mii WHERE mii.id = target."modelId"),
          NULL
        ) image,
        (SELECT image FROM articleItemImage aii WHERE aii.id = target."articleId") src
    FROM target
  `
      : [];

  const tags = await dbRead.tagsOnImage.findMany({
    where: {
      imageId: { in: [...new Set(itemImages.map(({ image }) => image?.id).filter(isDefined))] },
      disabled: false,
    },
    select: { imageId: true, tagId: true },
  });

  return itemImages
    .map(({ id, image, src }) => ({
      id,
      image: image
        ? {
            ...image,
            tags: tags.filter((t) => t.imageId === image.id).map((t) => ({ id: t.tagId })),
          }
        : null,
      src,
    }))
    .filter((itemImage) => !!(itemImage.image || itemImage.src));
};

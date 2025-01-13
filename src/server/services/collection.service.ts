import { Prisma } from '@prisma/client';
import { uniq, uniqBy } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { v4 as uuid } from 'uuid';
import { FEATURED_MODEL_COLLECTION_ID } from '~/server/common/constants';
import {
  ArticleSort,
  CollectionReviewSort,
  CollectionSort,
  ImageSort,
  ModelSort,
  NotificationCategory,
  NsfwLevel,
  PostSort,
  SearchIndexUpdateQueueAction,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { userContentOverviewCache } from '~/server/redis/caches';
import {
  GetByIdInput,
  UserPreferencesInput,
  userPreferencesSchema,
} from '~/server/schema/base.schema';
import {
  AddCollectionItemInput,
  BulkSaveCollectionItemsInput,
  CollectionMetadataSchema,
  EnableCollectionYoutubeSupportInput,
  GetAllCollectionItemsSchema,
  GetAllCollectionsInfiniteSchema,
  GetAllUserCollectionsInputSchema,
  GetUserCollectionItemsByItemSchema,
  RemoveCollectionItemInput,
  SetCollectionItemNsfwLevelInput,
  SetItemScoreInput,
  UpdateCollectionCoverImageInput,
  UpdateCollectionItemsStatusInput,
  UpsertCollectionInput,
} from '~/server/schema/collection.schema';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { UserMeta } from '~/server/schema/user.schema';
import { collectionsSearchIndex, imagesSearchIndex } from '~/server/search-index';
import { collectionSelect } from '~/server/selectors/collection.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import type { ArticleGetAll } from '~/server/services/article.service';
import { getArticles } from '~/server/services/article.service';
import { homeBlockCacheBust } from '~/server/services/home-block-cache.service';
import { getAllImages, ImagesInfiniteModel, ingestImage } from '~/server/services/image.service';
import {
  bustFeaturedModelsCache,
  getModelsWithImagesAndModelVersions,
  GetModelsWithImagesAndModelVersions,
} from '~/server/services/model.service';
import { createNotification } from '~/server/services/notification.service';
import { bustOrchestratorModelCache } from '~/server/services/orchestrator/models';
import { getPostsInfinite, PostsInfiniteModel } from '~/server/services/post.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getYoutubeRefreshToken } from '~/server/youtube/client';
import {
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
  TagTarget,
} from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';

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

export const getAllCollections = async <TSelect extends Prisma.CollectionSelect>({
  input: { limit, cursor, privacy, types, userId, sort, ids, modes },
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
      mode: modes && modes.length > 0 && user?.isModerator ? { in: modes } : undefined,
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

type CollectionForPermission = {
  id: number;
  name: string;
  description?: string;
  read: CollectionReadConfiguration;
  userId: number;
  write: CollectionWriteConfiguration;
  imageId?: number;
};

export const getUserCollectionsWithPermissions = async <
  TSelect extends Prisma.CollectionSelect = Prisma.CollectionSelect
>({
  input,
}: {
  input: GetAllUserCollectionsInputSchema & { userId: number };
}) => {
  const { userId, permissions, permission, contributingOnly = true } = input;
  // By default, owned collections will be always returned
  const AND: Prisma.Sql[] = [];
  const SELECT: Prisma.Sql = Prisma.raw(
    `SELECT c."id", c."name", c."description", c."read", c."userId", c."write", c."imageId"`
  );

  if (input.type) {
    AND.push(Prisma.sql`(c."type" = ${input.type}::"CollectionType" OR c."type" IS NULL)`);
  }

  const queries: Prisma.Sql[] = [
    Prisma.sql`(
      ${SELECT}
      FROM "Collection" c
      WHERE "userId" = ${userId}
        ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}

    )`,
  ];

  if (
    permissions &&
    permissions.includes(CollectionContributorPermission.ADD) &&
    !contributingOnly
  ) {
    queries.push(Prisma.sql`
      ${SELECT}
      FROM "Collection" c
      WHERE "write" = ${CollectionWriteConfiguration.Public}::"CollectionWriteConfiguration"
          ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}
    `);
  }

  if (
    permissions &&
    permissions.includes(CollectionContributorPermission.VIEW) &&
    !contributingOnly
  ) {
    // Even with view permission we don't really
    // want to return unlisted unless the user is a contributor
    // with that permission
    queries.push(Prisma.sql`
      ${SELECT}
      FROM "Collection" c
      WHERE "read" = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration"
        ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}

    `);
  }

  if (permissions || permission) {
    queries.push(Prisma.sql`(
        ${SELECT}
        FROM "CollectionContributor" AS cc
        JOIN "Collection" AS c ON c."id" = cc."collectionId"
        WHERE cc."userId" = ${userId}
          AND cc."permissions" && ARRAY[${Prisma.raw(
            (permissions || [permission]).map((p) => `'${p}'`).join(',')
          )}]::"CollectionContributorPermission"[]
          AND cc."collectionId" IS NOT NULL
          ${AND.length > 0 ? Prisma.sql`AND ${Prisma.join(AND, ',')}` : Prisma.sql``}
    )`);
  }

  // Moved to using raw queries because of huge performance issues with Prisma.
  // Now we're doing Unions which makes it faster
  const collections = await dbRead.$queryRaw<CollectionForPermission[]>`
    ${Prisma.join(queries, ' UNION ')}
  `;

  const collectionImageIds = collections.map((c) => c.imageId).filter(isDefined);

  const images =
    collectionImageIds.length > 0
      ? await dbRead.image.findMany({
          where: {
            id: {
              in: collectionImageIds,
            },
          },
        })
      : [];

  const collectionTags = await dbRead.tagsOnCollection.findMany({
    where: {
      collectionId: {
        in: collections.map((c) => c.id),
      },
    },
    include: {
      tag: true,
    },
  });

  // Return user collections first && add isOwner  property
  return collections
    .map((collection) => ({
      ...collection,
      isOwner: collection.userId === userId,
      image: images.find((i) => i.id === collection.imageId),
      tags: collectionTags
        .filter((t) => t.collectionId === collection.id)
        .map((t) => ({
          ...t.tag,
          filterableOnly: t.filterableOnly,
        })),
    }))
    .sort(({ userId: collectionUserId }) => (userId === collectionUserId ? -1 : 1));
};

export const getCollectionById = async ({ input }: { input: GetByIdInput }) => {
  const { id } = input;
  const collection = await dbRead.collection.findUnique({
    where: { id },
    select: {
      ...collectionSelect,
      user: { select: userWithCosmeticsSelect },
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
    tags: collection.tags.map((t) => ({
      ...t.tag,
      filterableOnly: t.filterableOnly,
    })),
  };
};

const inputToCollectionType = {
  modelId: CollectionType.Model,
  articleId: CollectionType.Article,
  imageId: CollectionType.Image,
  postId: CollectionType.Post,
} as const;

export const saveItemInCollections = async ({
  input: {
    collections: upsertCollectionItems,
    type,
    userId,
    isModerator,
    removeFromCollectionIds,
    ...input
  },
}: {
  input: AddCollectionItemInput & { userId: number; isModerator?: boolean };
}) => {
  const itemKey = Object.keys(inputToCollectionType).find((key) =>
    input.hasOwnProperty(key)
  ) as keyof typeof inputToCollectionType;
  if (!itemKey) throw throwBadRequestError(`We don't know the type of thing you're adding`);
  // Safeguard against duppes.
  upsertCollectionItems = uniqBy(upsertCollectionItems, 'collectionId');
  removeFromCollectionIds = uniq(removeFromCollectionIds);

  const collections = await dbRead.collection.findMany({
    select: collectionSelect,
    where: {
      id: { in: upsertCollectionItems.map((c) => c.collectionId) },
    },
  });

  if (itemKey && inputToCollectionType.hasOwnProperty(itemKey)) {
    const type = inputToCollectionType[itemKey];
    // check if all collections match the Model type
    const filteredCollections = collections.filter((c) => c.type === type || c.type == null);

    if (filteredCollections.length !== upsertCollectionItems.length) {
      throw throwBadRequestError('Collection type mismatch');
    }
  }

  const data = (
    await Promise.all(
      upsertCollectionItems.map(async (upsertCollection) => {
        const { collectionId, tagId } = upsertCollection;
        const collection = collections.find((c) => c.id === collectionId);

        if (!collection) {
          return null;
        }

        const inputTags = collection.tags?.filter((t) => !t.filterableOnly);

        if (
          inputTags.length > 0 &&
          !tagId &&
          !(collection.metadata as CollectionMetadataSchema)?.disableTagRequired
        ) {
          throw throwBadRequestError('Collection requires a tag');
        }

        if (collection.tags.length === 0 && tagId) {
          throw throwBadRequestError('Provided tag is not part of this collection');
        }

        if (
          collection.tags.length > 0 &&
          tagId &&
          !collection.tags.some((t) => t.tag.id === tagId)
        ) {
          throw throwBadRequestError('Provided tag is not part of this collection');
        }

        const metadata = (collection?.metadata ?? {}) as CollectionMetadataSchema;
        const permission = await getUserCollectionPermissionsById({
          userId,
          isModerator,
          id: collectionId,
        });

        if (
          !permission.isContributor &&
          !permission.isOwner &&
          !metadata?.disableFollowOnSubmission
        ) {
          // Make sure to follow the collection
          await addContributorToCollection({
            targetUserId: userId,
            userId: userId,
            collectionId,
          });
        }

        if (collection.mode === CollectionMode.Contest) {
          await validateContestCollectionEntry({
            metadata,
            collectionId,
            userId,
            isModerator,
            [`${itemKey}s`]: [input[itemKey]],
          });
        }

        // A shame to hard-code the `featured` name here. Might wanna look into adding a featured mode instead,
        // For now tho, should work
        if (collection.userId == -1 && !collection.mode && collection.name.includes('Featured')) {
          // Assume it's a featured collection:
          await validateFeaturedCollectionEntry({
            [`${itemKey}s`]: [input[itemKey]],
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
          [itemKey]: input[itemKey],
          tagId,
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
      )}", "tagId")
      SELECT
        v."collectionId",
        v."addedById",
        v."status",
        FLOOR(RANDOM() * 1000000000),
        v."${Prisma.raw(itemKey)}",
        v."tagId"
      FROM jsonb_to_recordset(${JSON.stringify(data)}::jsonb) AS v(
        "collectionId" INTEGER,
        "addedById" INTEGER,
        "status" "CollectionItemStatus",
        "${Prisma.raw(itemKey)}" INTEGER,
        "tagId" INTEGER
      )
      ON CONFLICT ("collectionId", "${Prisma.raw(itemKey)}")
        WHERE "${Prisma.raw(itemKey)}" IS NOT NULL
        DO UPDATE SET "tagId" = EXCLUDED."tagId";
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

    // if we have items to remove, add a deleteMany mutation to the transaction
    if (removeAllowedCollectionItemIds.length > 0)
      transactions.push(
        dbWrite.collectionItem.deleteMany({
          where: { id: { in: removeAllowedCollectionItemIds } },
        })
      );
  }

  await dbWrite.$transaction(transactions);

  // Check for updates to featured models
  if (input.modelId && collections.some((c) => c.id === FEATURED_MODEL_COLLECTION_ID)) {
    await bustFeaturedModelsCache();
    const versions = await dbRead.modelVersion.findMany({
      where: { id: input.modelId },
      select: { id: true },
    });
    await bustOrchestratorModelCache(versions.map((x) => x.id));
  }

  // Clear cache for homeBlocks
  await Promise.all(
    upsertCollectionItems.map((item) =>
      homeBlockCacheBust(HomeBlockType.Collection, item.collectionId)
    )
  );

  // Update collection search index
  const affectedCollections = [
    ...upsertCollectionItems.map((item) => item.collectionId),
    ...removeFromCollectionIds,
  ];
  if (affectedCollections.length > 0) {
    await collectionsSearchIndex.queueUpdate(
      affectedCollections.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
    );
  }

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
    tags,
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
      select: {
        id: true,
        read: true,
        mode: true,
        createdAt: true,
        image: { select: { id: true } },
      },
    });
    if (!currentCollection) throw throwNotFoundError(`No collection with id ${id}`);

    // nb - if we ever allow a cover image on create, copy this logic below
    // TODO commenting this out - other users can manage collections
    // const coverImgId = imageId ?? image?.id;
    // if (isDefined(coverImgId)) {
    //   const isImgOwner = await isImageOwner({ userId, isModerator, imageId: coverImgId });
    //   if (!isImgOwner) {
    //     throw throwAuthorizationError('Invalid cover image');
    //   }
    // }

    const updated = await dbWrite.$transaction(async (tx) => {
      if (tags) {
        // Attempt to run this first, collides with create/connect
        await tx.tagsOnCollection.deleteMany({
          where: {
            collectionId: id,

            tagId: {
              notIn: tags.filter(isTag).map((x) => x.id),
            },
          },
        });
      }

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
                      id: undefined,
                    },
                  },
                }
            : undefined,
          tags: tags
            ? {
                connectOrCreate: tags.filter(isTag).map((tag) => ({
                  where: { tagId_collectionId: { tagId: tag.id, collectionId: id as number } },
                  create: { tagId: tag.id },
                })),
                create: tags.filter(isNotTag).map((tag) => {
                  const name = tag.name.toLowerCase().trim();
                  return {
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { name, target: [TagTarget.Collection] },
                      },
                    },
                  };
                }),
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

      await userContentOverviewCache.bust(updated.userId);

      return updated;
    });

    if (
      input.read === CollectionReadConfiguration.Public &&
      currentCollection.read !== input.read
    ) {
      // Set publishedAt for all post belonging to this collection if changing privacy to public
      await dbWrite.$queryRaw`
        UPDATE "Post" SET
          "publishedAt" = COALESCE(DATE("metadata"->>'prevPublishedAt'), ${currentCollection.createdAt}, NOW()),
          "metadata" = jsonb_set("metadata", '{prevPublishedAt}', NULL)
        WHERE "collectionId" = ${updated.id}
      `;
    } else if (!updated.mode && input.read !== CollectionReadConfiguration.Public) {
      // otherwise set publishedAt to null when no mode is setup.
      await dbWrite.$queryRaw`
        UPDATE "Post" SET
          "publishedAt" = NULL,
          "metadata" = jsonb_set("metadata", '{prevPublishedAt}', to_jsonb("publishedAt"))
        WHERE "collectionId" = ${updated.id}
      `;
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

    await collectionsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

    // nb: doing this will delete a user's own image
    // if (currentCollection.image && !input.image) {
    //   const isOwner = await isImageOwner({
    //     userId,
    //     isModerator,
    //     imageId: currentCollection.image.id,
    //   });
    //   if (isOwner) {
    //     await deleteImageById({ id: currentCollection.image.id });
    //   }
    // }

    return updated;
  }

  // TODO allow cover image
  const collection = await dbWrite.collection.create({
    select: {
      id: true,
      image: { select: { id: true, url: true } },
      read: true,
      write: true,
      userId: true,
    },
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
      tags: tags
        ? {
            create: tags.map((tag) => {
              const name = tag.name.toLowerCase().trim();
              return {
                tag: {
                  connectOrCreate: {
                    where: { name },
                    create: { name, target: [TagTarget.Collection] },
                  },
                },
              };
            }),
          }
        : undefined,
    },
  });

  await userContentOverviewCache.bust(userId);

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

  // TODO if necessary, check image ownership here

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
  scores?: { userId: number; score: number }[] | null;
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
    collectionTagId,
  } = input;

  const skip = page && limit ? (page - 1) * limit : undefined;

  const userPreferencesInput = userPreferencesSchema.parse(input);

  const permission = await getUserCollectionPermissionsById({
    id: input.collectionId,
    userId: user?.id,
    isModerator: user?.isModerator,
  });

  if (
    (forReview ||
      statuses.includes(CollectionItemStatus.REVIEW) ||
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
      collection.type === CollectionType.Image && !forReview
        ? { ingestion: ImageIngestionStatus.Scanned }
        : undefined,
    tagId: collectionTagId,
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
      scores: input.forReview
        ? {
            select: {
              userId: true,
              score: true,
            },
            where: {
              userId: user?.id,
            },
          }
        : undefined,
    },
    where,
    orderBy,
  });

  if (collectionItems.length === 0) {
    return [];
  }

  if (user && forReview) {
    user.isModerator = true;
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
          pending: forReview,
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
  });

  if (userCollections.length === 0) return [];

  const collectionItems = await dbRead.collectionItem.findMany({
    select: {
      collectionId: true,
      addedById: true,
      tagId: true,
      collection: {
        select: {
          userId: true,
          read: true,
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
    select: { id: true, type: true, mode: true, name: true, metadata: true },
  });

  if (!collection) throw throwNotFoundError('No collection with id ' + collectionId);

  const { manage, isOwner } = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
    isModerator,
  });

  if (!manage && !isOwner)
    throw throwAuthorizationError('You do not have permissions to manage contributor item status.');

  const collectionMetadata = collection.metadata as CollectionMetadataSchema;

  if (status === CollectionItemStatus.ACCEPTED) {
    if (collectionMetadata?.judgesCanScoreEntries) {
      const exists = await dbRead.collectionItem.findFirst({
        where: {
          id: { in: collectionItemIds },
          scores: {
            none: {},
          },
        },
      });

      if (exists) {
        throw throwBadRequestError(
          'Some of the items selected do not have scores. Please ensure all items have scores before approving them.'
        );
      }
    }

    if (collectionMetadata?.judgesApplyBrowsingLevel && collection.type === CollectionType.Image) {
      const exists = await dbRead.collectionItem.findFirst({
        where: {
          id: { in: collectionItemIds },
          image: {
            nsfwLevel: {
              in: [0, -1],
            },
          },
        },
      });

      if (exists) {
        throw throwBadRequestError(
          'Some of the items selected have not been given a NSFW rating. Please ensure all items have a NSFW rating before approving them.'
        );
      }
    }
  }

  if (collectionItemIds.length > 0) {
    await dbWrite.$executeRaw`
      UPDATE "CollectionItem"
      SET "reviewedById" = ${userId},
      "reviewedAt" = ${new Date()},
      "updatedAt" = ${new Date()},
      "status" = ${status}::"CollectionItemStatus" ${Prisma.raw(
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
          category: NotificationCategory.Update,
          key: `contest-collection-item-status-change:${uuid()}`,
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
  if (ids.length === 0) return [] as { id: number; count: number }[];

  const where = [Prisma.sql`"collectionId" IN (${Prisma.join(ids)})`];
  if (status) where.push(Prisma.sql`"status" = ${status}::"CollectionItemStatus"`);

  return dbRead.$queryRaw<{ id: number; count: number }[]>`
    SELECT "collectionId" as "id", COUNT(*) as "count"
    FROM "CollectionItem"
    WHERE ${Prisma.sql`${Prisma.join(where, ' AND ')}`}
      AND ("imageId" IS NOT NULL OR "modelId" IS NOT NULL OR "postId" IS NOT NULL OR "articleId" IS NOT NULL)
    GROUP BY "collectionId"
  `;
}

export function getContributorCount({ collectionIds: ids }: { collectionIds: number[] }) {
  if (ids.length === 0) return [] as { id: number; count: number }[];

  const where = [Prisma.sql`"collectionId" IN (${Prisma.join(ids)})`];

  return dbRead.$queryRaw<{ id: number; count: number }[]>`
    SELECT "collectionId" as "id", COUNT(*) as "count"
    FROM "CollectionContributor"
    WHERE ${Prisma.sql`${Prisma.join(where, ' AND ')}`}
    GROUP BY "collectionId"
  `;
}

export const validateContestCollectionEntry = async ({
  collectionId,
  userId,
  isModerator,
  metadata,
  articleIds = [],
  modelIds = [],
  imageIds = [],
  postIds = [],
}: {
  collectionId: number;
  userId: number;
  isModerator?: boolean;
  metadata?: CollectionMetadataSchema;
  articleIds?: number[];
  modelIds?: number[];
  imageIds?: number[];
  postIds?: number[];
}) => {
  const user = await dbRead.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      meta: true,
    },
  });

  const userMeta = (user?.meta ?? {}) as UserMeta;

  if (userMeta?.contestBanDetails) {
    throw throwBadRequestError('You are banned from participating in contests');
  }

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
        status: {
          in: [CollectionItemStatus.ACCEPTED, CollectionItemStatus.REVIEW],
        },
      },
    });

    if (itemCount + savedItemsCount > metadata.maxItemsPerUser && !isModerator) {
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
  input: {
    userId,
    collectionId,
    articleIds = [],
    modelIds = [],
    imageIds = [],
    postIds = [],
    tagId,
    isModerator,
  },
  permissions,
}: {
  input: BulkSaveCollectionItemsInput & { userId: number; isModerator?: boolean };
  permissions: CollectionContributorPermissionFlags;
}) => {
  const collection = await dbRead.collection.findUnique({
    where: { id: collectionId },
    select: collectionSelect,
  });

  if (!collection) throw throwNotFoundError('No collection with id ' + collectionId);
  const inputTags = collection.tags?.filter((t) => !t.filterableOnly);

  if (
    inputTags.length > 0 &&
    !tagId &&
    !(collection.metadata as CollectionMetadataSchema)?.disableTagRequired
  ) {
    throw throwBadRequestError(
      'It is required to tag your entry in order for it to be added to this collection'
    );
  }

  if (collection.tags.length === 0 && tagId) {
    throw throwBadRequestError('This collection does not support tagging entries');
  }

  if (collection.tags.length > 0 && tagId && !collection.tags.find((t) => t.tag.id === tagId)) {
    throw throwBadRequestError('The tag provided is not allowed in this collection');
  }

  if (
    !permissions.isContributor &&
    !permissions.isOwner &&
    !(collection.metadata as CollectionMetadataSchema)?.disableFollowOnSubmission
  ) {
    // Make sure to follow the collection
    await addContributorToCollection({
      targetUserId: userId,
      userId: userId,
      collectionId,
    });
  }

  const metadata = (collection.metadata ?? {}) as CollectionMetadataSchema;

  if (collection.mode === CollectionMode.Contest) {
    await validateContestCollectionEntry({
      metadata,
      collectionId,
      userId,
      isModerator,
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
    tagId,
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

  const { count } = await dbWrite.collectionItem.createMany({ data });

  // return imageIds for use in controller updateEntityMetrics
  return {
    count,
    imageIds: data.map((d) => d.imageId).filter(isDefined),
  };
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
      disabledAt: null,
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

type CollectionForMeta = { id: number; metadata: CollectionMetadataSchema | null };

export const getContestsFromEntity = async ({
  entityType,
  entityId,
}: {
  entityType: 'post' | 'article' | 'model' | 'image';
  entityId: number;
}) => {
  const entityToField = {
    post: 'postId',
    article: 'articleId',
    model: 'modelId',
    image: 'imageId',
  };

  if (!entityToField[entityType]) {
    return [] as CollectionForMeta[];
  }

  const contestEntries = await dbRead.$queryRaw<CollectionForMeta[]>`
    SELECT ci."collectionId" as "id", c."metadata"
    FROM "CollectionItem" ci
    JOIN "Collection" c ON c.id = ci."collectionId"
    WHERE ci."${Prisma.raw(entityToField[entityType])}" = ${entityId} AND c."mode" = 'Contest'
  `;

  return contestEntries;
};

export const removeCollectionItem = async ({
  userId,
  collectionId,
  itemId,
  isModerator,
}: RemoveCollectionItemInput & { userId: number; isModerator?: boolean }) => {
  const permissions = await getUserCollectionPermissionsById({
    id: collectionId,
    userId,
    isModerator,
  });

  if (!permissions.collectionType) {
    throw throwNotFoundError('Unable to determine collection type');
  }

  let isOwner = false;
  const tableKey =
    permissions.collectionType === CollectionType.Model
      ? 'Model'
      : permissions.collectionType === CollectionType.Article
      ? 'Article'
      : permissions.collectionType === CollectionType.Image
      ? 'Image'
      : permissions.collectionType === CollectionType.Post
      ? 'Post'
      : null;

  if (!tableKey) {
    throw throwNotFoundError('Unable to determine collection type');
  }

  const [item] = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT "userId" FROM "${Prisma.raw(tableKey)}" WHERE id = ${itemId}
  `;

  if (!item) {
    throw throwNotFoundError('Item not found');
  }

  isOwner = item.userId === userId;

  if (
    !permissions.write &&
    !permissions.writeReview &&
    !isOwner &&
    !permissions.manage &&
    !isModerator
  ) {
    throw throwAuthorizationError(
      'You do not have permission to remove items from this collection.'
    );
  }

  await dbWrite.$queryRaw`
    DELETE FROM "CollectionItem"
    WHERE "collectionId" = ${collectionId} AND "${Prisma.raw(
    `${tableKey.toLowerCase()}Id`
  )}" = ${itemId}
  `;

  return {
    collectionId,
    itemId,
    type: permissions.collectionType,
  };
};

export async function checkUserOwnsCollectionAndItem({
  itemId,
  collectionId,
  userId,
}: {
  itemId: number;
  collectionId: number;
  userId: number;
}) {
  const collection = await dbRead.collection.findFirst({
    where: { id: collectionId, userId },
    select: { type: true, userId: true },
  });
  if (!collection) return false;

  const tableKey =
    collection.type === CollectionType.Model
      ? 'Model'
      : collection.type === CollectionType.Article
      ? 'Article'
      : collection.type === CollectionType.Image
      ? 'Image'
      : collection.type === CollectionType.Post
      ? 'Post'
      : null;

  if (!tableKey) throw throwNotFoundError('Unable to determine collection type');

  const [item] = await dbRead.$queryRaw<{ userId: number }[]>`
    SELECT "userId" FROM "${Prisma.raw(tableKey)}" WHERE id = ${itemId}
  `;
  if (!item) return false;

  return item.userId === collection.userId;
}

export const setItemScore = async ({
  collectionItemId,
  userId,
  score,
}: SetItemScoreInput & { userId: number }) => {
  const collectionItem = await dbRead.collectionItem.findUnique({
    where: { id: collectionItemId },
    select: {
      id: true,
      collection: {
        select: { id: true, mode: true },
      },
    },
  });
  if (!collectionItem) throw throwNotFoundError('Collection item not found');
  if (!collectionItem.collection) throw throwNotFoundError('Collection not found');
  if (collectionItem.collection.mode !== CollectionMode.Contest)
    throw throwBadRequestError('This collection is not a contest collection');

  const itemScore = await dbWrite.collectionItemScore.upsert({
    where: { userId_collectionItemId: { userId, collectionItemId: collectionItem.id } },
    create: { userId, collectionItemId: collectionItem.id, score },
    update: { score },
  });

  return itemScore;
};

export const getCollectionItemById = ({ id }: GetByIdInput) => {
  return dbRead.collectionItem.findUniqueOrThrow({
    where: { id },
    include: {
      collection: true,
    },
  });
};

export async function getCollectionEntryCount({
  collectionId,
  userId,
}: {
  collectionId: number;
  userId: number;
}) {
  const [collection] = await dbRead.$queryRaw<{ total: number }[]>`
    SELECT
      CAST(c.metadata->'maxItemsPerUser' as int) as total
    FROM "Collection" c
    WHERE c.id = ${collectionId}
  `;
  if (!collection) throw throwNotFoundError('Collection not found');

  const statuses = await dbRead.$queryRaw<{ status: CollectionItemStatus; count: number }[]>`
    SELECT
      "status",
      CAST(COUNT(*) as int) as "count"
    FROM "CollectionItem"
    WHERE "collectionId" = ${collectionId}
    AND "addedById" = ${userId}
    GROUP BY "status"
  `;
  console.log(collection);
  const result: { [key in CollectionItemStatus]?: number } & { max: number } = {
    max: collection.total,
  };
  for (const { status, count } of statuses) result[status] = count;
  return result;
}

export const setCollectionItemNsfwLevel = async ({
  collectionItemId,
  nsfwLevel,
}: SetCollectionItemNsfwLevelInput) => {
  const collectionItem = await getCollectionItemById({ id: collectionItemId });

  if (!collectionItem) {
    throw throwNotFoundError('Collection item not found');
  }

  if (collectionItem.collection.type !== CollectionType.Image || !collectionItem.imageId) {
    throw throwBadRequestError(
      'NSFW Level assignment support is only available on image collections.'
    );
  }

  const metadata = (collectionItem.collection.metadata ?? {}) as CollectionMetadataSchema;

  if (!metadata?.judgesApplyBrowsingLevel) {
    throw throwBadRequestError('This collection does not support NSFW level assignment.');
  }

  const image = await dbRead.image.findUnique({
    where: { id: collectionItem.imageId as number },
    select: {
      post: {
        select: {
          collectionId: true,
        },
      },
    },
  });

  if (!image) {
    throw throwNotFoundError('Image not found');
  }

  if (image.post?.collectionId !== collectionItem.collectionId) {
    throw throwBadRequestError(
      'The image you are trying to apply an NSFW level to was not created for this collection. NSFW level assignment is only available for images created for this collection.'
    );
  }

  if (!nsfwLevel) throw throwBadRequestError();

  await dbWrite.image.update({
    where: { id: collectionItem.imageId as number },
    data: { nsfwLevel, scannedAt: new Date(), ingestion: ImageIngestionStatus.Scanned },
  });

  await imagesSearchIndex.queueUpdate([
    { id: collectionItem.imageId, action: SearchIndexUpdateQueueAction.Update },
  ]);
};

export const enableCollectionYoutubeSupport = async ({
  collectionId,
  userId,
  authenticationCode,
}: EnableCollectionYoutubeSupportInput & { userId: number }) => {
  const user = await dbRead.user.findUnique({ where: { id: userId } });
  if (!user?.isModerator) {
    throw throwAuthorizationError('You do not have permission to enable youtube support');
  }

  const collection = await getCollectionById({ input: { id: collectionId } });

  if (collection.mode !== CollectionMode.Contest) {
    throw throwBadRequestError('Only contest collections can have youtube support enabled');
  }

  if (collection.type !== CollectionType.Image) {
    throw throwBadRequestError('Only image collections can have youtube support enabled');
  }

  const metadata = collection.metadata as CollectionMetadataSchema;

  if (metadata.youtubeSupportEnabled) {
    throw throwBadRequestError('Youtube support is already enabled for this collection');
  }

  // Attempt to save the auth code on the key-value store.
  try {
    const { tokens } = await getYoutubeRefreshToken(
      authenticationCode,
      '/collections/youtube/auth'
    );
    const collectionKey = `collection:${collectionId}:youtube-authentication-code`;

    if (!tokens.refresh_token) {
      throw throwBadRequestError('Failed to get youtube refresh token');
    }
    await dbWrite.$transaction(async (tx) => {
      await tx.keyValue.upsert({
        where: {
          key: collectionKey,
        },
        update: {
          value: tokens.refresh_token as string,
        },
        create: {
          key: collectionKey,
          value: tokens.refresh_token as string,
        },
      });

      await tx.collection.update({
        where: {
          id: collection.id,
        },
        data: {
          metadata: {
            ...metadata,
            youtubeSupportEnabled: true,
          },
        },
      });
    });

    return { collectionId, youtubeSupportEnabled: true };
  } catch (error) {
    throw throwBadRequestError('Failed to save youtube authentication code');
  }
};

export async function randomizeCollectionItems(collectionId: number) {
  await dbWrite.$executeRaw`
    UPDATE "CollectionItem" ci SET "randomId" = FLOOR(RANDOM() * 1000000000)
    WHERE ci."collectionId" = ${collectionId}
      AND ci."status" = 'ACCEPTED'
  `;
}

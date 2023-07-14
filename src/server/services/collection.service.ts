import { dbRead, dbWrite } from '~/server/db/client';
import { AddCollectionItemInput, UpsertCollectionInput } from '~/server/schema/collection.schema';
import { SessionUser } from 'next-auth';
import {
  CollectionContributorPermission,
  CollectionWriteConfiguration,
  MetricTimeframe,
  Prisma,
} from '@prisma/client';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';
import { UserPreferencesInput } from '~/server/middleware.trpc';
import { ArticleGetAll } from '~/types/router';
import { getArticles } from '~/server/services/article.service';
import {
  getModelsWithImagesAndModelVersions,
  GetModelsWithImagesAndModelVersions,
} from '~/server/services/model.service';
import { Context } from '~/server/createContext';
import { ArticleSort, BrowsingMode, ImageSort, ModelSort, PostSort } from '~/server/common/enums';
import { getAllImages, ImagesInfiniteModel } from '~/server/services/image.service';
import { getPostsInfinite, PostsInfiniteModel } from '~/server/services/post.service';

export const getUserCollectionsWithPermissions = <
  TSelect extends Prisma.CollectionSelect = Prisma.CollectionSelect
>({
  user,
  permissions,
  select,
}: {
  user: SessionUser;
  permissions: CollectionContributorPermission[];
  select: TSelect;
}) => {
  return dbRead.collection.findMany({
    where: {
      OR: [
        {
          write: CollectionWriteConfiguration.Public,
        },
        { userId: user.id },
        {
          contributors: {
            some: {
              userId: user.id,
              permissions: {
                hasSome: permissions,
              },
            },
          },
        },
      ],
    },
    select,
  });
};
export const addCollectionItems = async ({
  user,
  input: { collectionIds, ...input },
}: {
  user: SessionUser;
  input: AddCollectionItemInput;
}) => {
  const data: Prisma.CollectionItemCreateManyInput[] = collectionIds.map((collectionId) => ({
    ...input,
    addedById: user.id,
    collectionId,
  }));

  return dbWrite.collectionItem.createMany({
    data,
  });
};

export const upsertCollection = async ({
  input,
  user,
}: {
  input: UpsertCollectionInput;
  user: SessionUser;
}) => {
  const { id, name, description, coverImage, read, write, ...collectionItem } = input;

  if (id) {
    const updated = await dbWrite.collection.update({
      where: { id },
      data: {
        name,
        description,
        coverImage,
        read,
        write,
      },
    });

    if (!updated) throw throwNotFoundError(`No collection with id ${id}`);
    return updated;
  }

  return dbWrite.collection.create({
    data: {
      name,
      description,
      coverImage,
      read,
      write,
      userId: user.id,
      contributors: {
        create: {
          userId: user.id,
          permissions: [
            CollectionContributorPermission.MANAGE,
            CollectionContributorPermission.ADD,
            CollectionContributorPermission.VIEW,
          ],
        },
      },
      items: { create: { ...collectionItem, addedById: user.id } },
    },
  });
};

export const getCollectionById = ({ id }: { id: number }) => {
  return dbRead.collection.findUnique({
    select: {
      id: true,
      name: true,
      coverImage: true,
      description: true,
    },
    where: {
      id,
    },
  });
};

type CollectionItemExpanded = {
  model?: GetModelsWithImagesAndModelVersions;
  post?: PostsInfiniteModel;
  image?: ImagesInfiniteModel;
  article?: ArticleGetAll['items'][0];
};

export const getCollectionItemsByCollectionId = async ({
  id,
  ctx,
  input,
}: {
  id: number;
  ctx: Context;
  input: UserPreferencesInput & { limit: number };
}) => {
  const { limit: take, ...userPreferencesInput } = input;
  const collectionWithItems = await dbRead.collection.findUnique({
    select: {
      id: true,
      items: {
        take,
        select: {
          id: true,
          modelId: true,
          postId: true,
          imageId: true,
          articleId: true,
        },
      },
    },
    where: {
      id,
    },
  });

  if (!collectionWithItems) {
    return [];
  }

  const modelIds = collectionWithItems.items.map((item) => item.modelId).filter(isDefined);

  const models = await getModelsWithImagesAndModelVersions({
    input: {
      sort: ModelSort.Newest,
      period: MetricTimeframe.AllTime,
      periodMode: 'stats',
      hidden: false,
      favorites: false,
      ...userPreferencesInput,
      ids: modelIds,
    },
    ctx,
  });

  const articleIds = collectionWithItems.items.map((item) => item.articleId).filter(isDefined);

  const articles = await getArticles({
    limit: articleIds.length,
    period: MetricTimeframe.AllTime,
    periodMode: 'stats',
    sort: ArticleSort.Newest,
    ...userPreferencesInput,
    browsingMode: userPreferencesInput.browsingMode || BrowsingMode.SFW,
    sessionUser: ctx.user,
    ids: articleIds,
  });

  const imageIds = collectionWithItems.items.map((item) => item.imageId).filter(isDefined);

  const images = await getAllImages({
    include: [],
    limit: imageIds.length,
    period: MetricTimeframe.AllTime,
    periodMode: 'stats',
    sort: ImageSort.Newest,
    ...userPreferencesInput,
    userId: ctx.user?.id,
    isModerator: ctx.user?.isModerator,
    ids: imageIds,
  });

  const postIds = collectionWithItems.items.map((item) => item.postId).filter(isDefined);

  const posts = await getPostsInfinite({
    limit: 0,
    period: MetricTimeframe.AllTime,
    periodMode: 'stats',
    sort: PostSort.Newest,
    ...userPreferencesInput,
    user: ctx.user,
    browsingMode: userPreferencesInput.browsingMode || BrowsingMode.SFW,
    ids: postIds,
  });

  // TODO.collections:
  // Make structure work like so:
  // { type: 'model', ....data } => Discriminated union with models/posts/images/articles
  const collectionItemsExpanded: (Omit<
    (typeof collectionWithItems.items)[0],
    'postId' | 'modelId' | 'imageId' | 'articleId'
  > &
    CollectionItemExpanded)[] = collectionWithItems.items
    .map(({ imageId, postId, articleId, modelId, ...collectionItemRemainder }) => {
      const collectionItem: typeof collectionItemRemainder & CollectionItemExpanded = {
        ...collectionItemRemainder,
        // Mark all as undefined:
        image: undefined,
        model: undefined,
        post: undefined,
        article: undefined,
      };

      if (modelId) {
        // Get all model info:
        const model = models.items.find((m) => m.id === modelId);
        if (!model) {
          return collectionItem;
        }

        collectionItem.model = model;
      }

      if (postId) {
        const post = posts.items.find((p) => p.id === postId);

        if (!post) {
          return collectionItem;
        }

        collectionItem.post = post;
      }

      if (imageId) {
        const image = images.items.find((i) => i.id === imageId);

        if (!image) {
          return collectionItem;
        }

        collectionItem.image = image;
      }

      if (articleId) {
        const article = articles.items.find((a) => a.id === articleId);

        if (!article) {
          return collectionItem;
        }

        collectionItem.article = article;
      }

      return collectionItem;
    })
    .filter(isDefined)
    .filter(
      (collectionItem) =>
        collectionItem.model ||
        collectionItem.post ||
        collectionItem.article ||
        collectionItem.image
    );

  return collectionItemsExpanded;
};

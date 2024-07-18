import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

// Moveable only if submitted through an api

export const featuredNotifications = createNotificationProcessor({
  // TODO can models only be featured once?
  'featured-model': {
    displayName: 'Model featured',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your ${details.modelName} model has been featured on the homepage`,
      url: `/models/${details.modelId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT DISTINCT
          m."userId",
          jsonb_build_object(
            'modelId', ci."modelId",
            'modelName', m.name
          ) "details",
          ci."modelId"
        FROM "CollectionItem" ci
        JOIN "Collection" c ON c.id = ci."collectionId"
        JOIN "Model" m ON m.id = ci."modelId"
        WHERE c."userId" = -1 AND c.name = 'Featured Models'
          AND ci.status = 'ACCEPTED'
          AND (ci."createdAt" > '${lastSent}' OR ci."updatedAt" > '${lastSent}')
      )
      SELECT
        CONCAT('featured-model:',"modelId") "key", -- maybe add last sent
        "userId",
        'featured-model' "type",
        details
      FROM data
    `,
  },
  'featured-image': {
    displayName: 'Image featured',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your image has been featured on the homepage`,
      url: `/images/${details.imageId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT DISTINCT
          i."userId",
          jsonb_build_object(
            'imageId', ci."imageId"
          ) "details",
          ci."imageId"
        FROM "CollectionItem" ci
        JOIN "Collection" c ON c.id = ci."collectionId"
        JOIN "Image" i ON i.id = ci."imageId"
        WHERE c."userId" = -1 AND c.name = 'Featured Images'
          AND ci.status = 'ACCEPTED'
          AND (ci."createdAt" > '${lastSent}' OR ci."updatedAt" > '${lastSent}')
      )
      SELECT
        CONCAT('featured-image:',"imageId") "key", -- maybe add last sent
        "userId",
        'featured-image' "type",
        details
      FROM data
    `,
  },
  'featured-post': {
    displayName: 'Post featured',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      let message = `Congrats! Your post has been featured on the homepage`;
      if (details.postTitle)
        message = `Congrats! Your post "${details.postTitle}" has been featured on the homepage`;
      const url = `/posts/${details.postId}`;
      return { message, url };
    },
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT DISTINCT
          p."userId",
          jsonb_build_object(
            'postId', ci."postId",
            'postTitle', p.title
          ) "details",
          ci."postId"
        FROM "CollectionItem" ci
        JOIN "Collection" c ON c.id = ci."collectionId"
        JOIN "Post" p ON p.id = ci."postId"
        WHERE c."userId" = -1 AND c.name = 'Featured Posts'
          AND ci.status = 'ACCEPTED'
          AND (ci."createdAt" > '${lastSent}' OR ci."updatedAt" > '${lastSent}')
      )
      SELECT
        CONCAT('featured-post:',"postId") "key", -- maybe add last sent
        "userId",
        'featured-post' "type",
        details
      FROM data
    `,
  },
  'featured-article': {
    displayName: 'Article featured',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your article "${details.articleTitle}" has been featured on the homepage`,
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT DISTINCT
          a."userId",
          jsonb_build_object(
            'articleId', ci."articleId",
            'articleTitle', a.title
          ) "details",
          ci."articleId"
        FROM "CollectionItem" ci
        JOIN "Collection" c ON c.id = ci."collectionId"
        JOIN "Article" a ON a.id = ci."articleId"
        WHERE c."userId" = -1 AND c.name = 'Featured Articles'
          AND ci.status = 'ACCEPTED'
          AND (ci."createdAt" > '${lastSent}' OR ci."updatedAt" > '${lastSent}')
      )
      SELECT
        CONCAT('featured-article:',"articleId") "key", -- maybe add last sent
        "userId",
        'featured-article' "type",
        details
      FROM data
    `,
  },
});

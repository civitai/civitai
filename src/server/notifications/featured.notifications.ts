import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const featuredNotifications = createNotificationProcessor({
  'featured-model': {
    displayName: 'Model featured',
    category: 'System',
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your ${details.modelName} model has been featured on the homepage`,
      url: `/models/${details.modelId}`,
    }),
    prepareQuery: async ({ lastSent, category }) => `
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT("userId",':','featured-model',':',"modelId"),
        "userId",
        'featured-model' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM data
      ON CONFLICT("id") DO NOTHING;
    `,
  },
  'featured-image': {
    displayName: 'Image featured',
    category: 'System',
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your image has been featured on the homepage`,
      url: `/images/${details.imageId}`,
    }),
    prepareQuery: async ({ lastSent, category }) => `
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT("userId",':','featured-image',':',"imageId"),
        "userId",
        'featured-image' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM data
      ON CONFLICT("id") DO NOTHING;
    `,
  },
  'featured-post': {
    displayName: 'Post featured',
    category: 'System',
    toggleable: false,
    prepareMessage: ({ details }) => {
      let message = `Congrats! Your post has been featured on the homepage`;
      if (details.postTitle)
        message = `Congrats! Your post "${details.postTitle}" has been featured on the homepage`;
      const url = `/posts/${details.postId}`;
      return { message, url };
    },
    prepareQuery: async ({ lastSent, category }) => `
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT("userId",':','featured-post',':',"postId"),
        "userId",
        'featured-post' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM data
      ON CONFLICT("id") DO NOTHING;
    `,
  },
  'featured-article': {
    displayName: 'Article featured',
    category: 'System',
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your article "${details.articleTitle}" has been featured on the homepage`,
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: async ({ lastSent, category }) => `
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT("userId",':','featured-article',':',"articleId"),
        "userId",
        'featured-article' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM data
      ON CONFLICT("id") DO NOTHING;
    `,
  },
});

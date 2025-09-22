import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { Tracker } from '~/server/clickhouse/client';
import { createLogger } from '~/utils/logging';
import type { EntityMetric_EntityType_Type, EntityMetric_MetricType_Type } from '~/shared/utils/prisma/enums';

const log = createLogger('migrate-metrics', 'cyan');

/**
 * Backfill historical metrics data from PostgreSQL to ClickHouse
 * This is a one-time migration to populate ClickHouse with existing metric data
 */
async function migrateMetricsToClickHouse() {
  if (!clickhouse) {
    log('ClickHouse client not configured');
    return;
  }

  log('Starting metrics migration to ClickHouse...');

  // Create a tracker instance for recording events
  const tracker = new Tracker();

  // Migrate Model metrics
  await migrateModelMetrics(tracker);

  // Migrate Post metrics
  await migratePostMetrics(tracker);

  // Migrate Collection metrics
  await migrateCollectionMetrics(tracker);

  // Migrate User metrics (followers)
  await migrateUserMetrics(tracker);

  // Migrate BuzzTips
  await migrateBuzzTips(tracker);

  log('Migration complete!');
}

async function migrateModelMetrics(tracker: Tracker) {
  log('Migrating model metrics...');

  // Get all models with metrics
  const models = await dbRead.$queryRaw<{
    modelId: number;
    thumbsUpCount: number;
    thumbsDownCount: number;
    commentCount: number;
    collectedCount: number;
  }[]>`
    SELECT
      m."modelId",
      COALESCE(m."thumbsUpCount", 0)::int as "thumbsUpCount",
      COALESCE(m."thumbsDownCount", 0)::int as "thumbsDownCount",
      COALESCE(m."commentCount", 0)::int as "commentCount",
      COALESCE(m."collectedCount", 0)::int as "collectedCount"
    FROM "ModelMetric" m
    WHERE m.timeframe = 'AllTime'
      AND (m."thumbsUpCount" > 0 OR m."thumbsDownCount" > 0 OR m."commentCount" > 0 OR m."collectedCount" > 0)
  `;

  log(`Found ${models.length} models with metrics`);

  const batches = chunk(models, 1000);
  for (const batch of batches) {
    for (const model of batch) {
      if (model.thumbsUpCount > 0) {
        await tracker.entityMetric({
          entityType: 'Model',
          entityId: model.modelId,
          metricType: 'ThumbsUp',
          metricValue: model.thumbsUpCount,
        });
      }

      if (model.thumbsDownCount > 0) {
        await tracker.entityMetric({
          entityType: 'Model',
          entityId: model.modelId,
          metricType: 'ThumbsDown',
          metricValue: model.thumbsDownCount,
        });
      }

      if (model.commentCount > 0) {
        await tracker.entityMetric({
          entityType: 'Model',
          entityId: model.modelId,
          metricType: 'Comment',
          metricValue: model.commentCount,
        });
      }

      if (model.collectedCount > 0) {
        await tracker.entityMetric({
          entityType: 'Model',
          entityId: model.modelId,
          metricType: 'Collection',
          metricValue: model.collectedCount,
        });
      }
    }

    log(`Migrated batch of ${batch.length} models`);
  }

  log('Model metrics migration complete');
}

async function migratePostMetrics(tracker: Tracker) {
  log('Migrating post metrics...');

  // Get all posts with metrics
  const posts = await dbRead.$queryRaw<{
    postId: number;
    reactionCount: number;
    commentCount: number;
    collectedCount: number;
  }[]>`
    SELECT
      p."postId",
      COALESCE(p."reactionCount", 0)::int as "reactionCount",
      COALESCE(p."commentCount", 0)::int as "commentCount",
      COALESCE(p."collectedCount", 0)::int as "collectedCount"
    FROM "PostMetric" p
    WHERE p.timeframe = 'AllTime'
      AND (p."reactionCount" > 0 OR p."commentCount" > 0 OR p."collectedCount" > 0)
  `;

  log(`Found ${posts.length} posts with metrics`);

  const batches = chunk(posts, 1000);
  for (const batch of batches) {
    for (const post of batch) {
      // For reactions, we'll distribute them evenly across types for now
      // In production, you might want to get the actual breakdown
      if (post.reactionCount > 0) {
        const reactionPerType = Math.floor(post.reactionCount / 4);
        const remainder = post.reactionCount % 4;

        await tracker.entityMetric({
          entityType: 'Post',
          entityId: post.postId,
          metricType: 'ReactionLike',
          metricValue: reactionPerType + (remainder > 0 ? 1 : 0),
        });

        await tracker.entityMetric({
          entityType: 'Post',
          entityId: post.postId,
          metricType: 'ReactionHeart',
          metricValue: reactionPerType + (remainder > 1 ? 1 : 0),
        });

        await tracker.entityMetric({
          entityType: 'Post',
          entityId: post.postId,
          metricType: 'ReactionLaugh',
          metricValue: reactionPerType + (remainder > 2 ? 1 : 0),
        });

        await tracker.entityMetric({
          entityType: 'Post',
          entityId: post.postId,
          metricType: 'ReactionCry',
          metricValue: reactionPerType,
        });
      }

      if (post.commentCount > 0) {
        await tracker.entityMetric({
          entityType: 'Post',
          entityId: post.postId,
          metricType: 'Comment',
          metricValue: post.commentCount,
        });
      }

      if (post.collectedCount > 0) {
        await tracker.entityMetric({
          entityType: 'Post',
          entityId: post.postId,
          metricType: 'Collection',
          metricValue: post.collectedCount,
        });
      }
    }

    log(`Migrated batch of ${batch.length} posts`);
  }

  log('Post metrics migration complete');
}

async function migrateCollectionMetrics(tracker: Tracker) {
  log('Migrating collection metrics...');

  // Get all collections with metrics
  const collections = await dbRead.$queryRaw<{
    collectionId: number;
    itemCount: number;
    followerCount: number;
    contributorCount: number;
  }[]>`
    SELECT
      c."collectionId",
      COALESCE(c."itemCount", 0)::int as "itemCount",
      COALESCE(c."followerCount", 0)::int as "followerCount",
      COALESCE(c."contributorCount", 0)::int as "contributorCount"
    FROM "CollectionMetric" c
    WHERE c.timeframe = 'AllTime'
      AND (c."itemCount" > 0 OR c."followerCount" > 0 OR c."contributorCount" > 0)
  `;

  log(`Found ${collections.length} collections with metrics`);

  const batches = chunk(collections, 1000);
  for (const batch of batches) {
    for (const collection of batch) {
      if (collection.itemCount > 0) {
        await tracker.entityMetric({
          entityType: 'Collection',
          entityId: collection.collectionId,
          metricType: 'Item',
          metricValue: collection.itemCount,
        });
      }

      if (collection.followerCount > 0) {
        await tracker.entityMetric({
          entityType: 'Collection',
          entityId: collection.collectionId,
          metricType: 'Follower',
          metricValue: collection.followerCount,
        });
      }

      if (collection.contributorCount > 0) {
        await tracker.entityMetric({
          entityType: 'Collection',
          entityId: collection.collectionId,
          metricType: 'Contributor',
          metricValue: collection.contributorCount,
        });
      }
    }

    log(`Migrated batch of ${batch.length} collections`);
  }

  log('Collection metrics migration complete');
}

async function migrateUserMetrics(tracker: Tracker) {
  log('Migrating user metrics...');

  // Get all user follow relationships
  const follows = await dbRead.$queryRaw<{
    targetUserId: number;
    followerCount: number;
  }[]>`
    SELECT
      "targetUserId",
      COUNT(*)::int as "followerCount"
    FROM "UserEngagement"
    WHERE type = 'Follow'
    GROUP BY "targetUserId"
    HAVING COUNT(*) > 0
  `;

  log(`Found ${follows.length} users with followers`);

  const batches = chunk(follows, 1000);
  for (const batch of batches) {
    for (const user of batch) {
      if (user.followerCount > 0) {
        await tracker.entityMetric({
          entityType: 'User',
          entityId: user.targetUserId,
          metricType: 'Follow',
          metricValue: user.followerCount,
        });
      }
    }

    log(`Migrated batch of ${batch.length} user follow metrics`);
  }

  log('User metrics migration complete');
}

async function migrateBuzzTips(tracker: Tracker) {
  log('Migrating buzz tips...');

  // Get all buzz tips
  const tips = await dbRead.buzzTip.findMany({
    select: {
      entityType: true,
      entityId: true,
      amount: true,
    },
  });

  log(`Found ${tips.length} buzz tips`);

  const batches = chunk(tips, 1000);
  for (const batch of batches) {
    for (const tip of batch) {
      // Map entity type to ClickHouse entity type
      const entityType =
        tip.entityType === 'Model' ? 'Model' :
        tip.entityType === 'Image' ? 'Image' :
        tip.entityType === 'Post' ? 'Post' :
        tip.entityType === 'ModelVersion' ? 'ModelVersion' :
        null;

      if (entityType) {
        // Record tip count
        await tracker.entityMetric({
          entityType: entityType as EntityMetric_EntityType_Type,
          entityId: tip.entityId,
          metricType: 'Tip',
          metricValue: 1, // Each row represents at least one tip
        });

        // Record buzz amount
        await tracker.entityMetric({
          entityType: entityType as EntityMetric_EntityType_Type,
          entityId: tip.entityId,
          metricType: 'Buzz',
          metricValue: tip.amount,
        });
      }
    }

    log(`Migrated batch of ${batch.length} buzz tips`);
  }

  log('Buzz tips migration complete');
}

// Run the migration
if (require.main === module) {
  migrateMetricsToClickHouse()
    .then(() => {
      log('All migrations completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      log('Migration failed:', error);
      process.exit(1);
    });
}
import { createEventHandler } from './base';

/**
## Metrics driven by commentv2 table:
- PostMetric.commentCount (create/delete)
- ImageMetric.commentCount (create/delete)
- ArticleMetric.commentCount (create/delete)
- BountyMetric.commentCount (create/delete)
- UserMetric.commentCount (create/delete) — comments *received* by the owner of the commented-on
  entity, across every surface CommentsV2 serves, not just the four with their own entity metric.
*/

interface CommentV2Record {
  userId: number;
  threadId: number;
}

export const commentV2Handler = createEventHandler<CommentV2Record>({
  tables: ['CommentV2'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions, pg }) => {
    const value = operation === 'create' ? 1 : -1;

    // One query for the entity *and* its owner: the owner columns are what make a per-creator comment
    // count possible at all. Without them the only route from a creator to their comments is a join
    // over the whole image space, which is why Creator Studio reads Postgres for this today.
    //
    // A Thread carries exactly one entity FK, so the owner COALESCE has at most one non-null input
    // and its argument order carries no meaning. Owner column names are not uniform — Challenge and
    // ClubPost record `createdById`, app_listings is snake_cased, and a comic thread points at the
    // chapter's project rather than at an owner directly.
    const thread = await pg.queryOne<{
      postId: number | null;
      imageId: number | null;
      articleId: number | null;
      bountyId: number | null;
      ownerId: number | null;
    }>(
      `SELECT
        COALESCE(r."postId", t."postId") AS "postId",
        COALESCE(r."imageId", t."imageId") AS "imageId",
        COALESCE(r."articleId", t."articleId") AS "articleId",
        COALESCE(r."bountyId", t."bountyId") AS "bountyId",
        COALESCE(
          p."userId", i."userId", a."userId", b."userId",
          rev."userId", be."userId", ch."createdById", cp."userId", clp."createdById",
          m3d."userId", m3dr."userId", mdl."userId", q."userId", ans."userId", al.user_id
        ) AS "ownerId"
      FROM "Thread" t
      LEFT JOIN "Thread" r ON r.id = t."rootThreadId"
      LEFT JOIN "Post" p ON p.id = COALESCE(r."postId", t."postId")
      LEFT JOIN "Image" i ON i.id = COALESCE(r."imageId", t."imageId")
      LEFT JOIN "Article" a ON a.id = COALESCE(r."articleId", t."articleId")
      LEFT JOIN "Bounty" b ON b.id = COALESCE(r."bountyId", t."bountyId")
      LEFT JOIN "ResourceReview" rev ON rev.id = COALESCE(r."reviewId", t."reviewId")
      LEFT JOIN "BountyEntry" be ON be.id = COALESCE(r."bountyEntryId", t."bountyEntryId")
      LEFT JOIN "Challenge" ch ON ch.id = COALESCE(r."challengeId", t."challengeId")
      LEFT JOIN "ComicProject" cp ON cp.id = COALESCE(r."comicProjectId", t."comicProjectId")
      LEFT JOIN "ClubPost" clp ON clp.id = COALESCE(r."clubPostId", t."clubPostId")
      LEFT JOIN "Model3D" m3d ON m3d.id = COALESCE(r."model3dId", t."model3dId")
      LEFT JOIN "Model3DReview" m3dr ON m3dr.id = COALESCE(r."model3dReviewId", t."model3dReviewId")
      LEFT JOIN "Model" mdl ON mdl.id = COALESCE(r."modelId", t."modelId")
      LEFT JOIN "Question" q ON q.id = COALESCE(r."questionId", t."questionId")
      LEFT JOIN "Answer" ans ON ans.id = COALESCE(r."answerId", t."answerId")
      LEFT JOIN app_listings al ON al.serial_id = COALESCE(r."appListingId", t."appListingId")
      WHERE t.id = $1`,
      [record.threadId]
    );

    if (!thread) return;

    // A creator answering their own commenters is not engagement received. Left in, it dominates:
    // 71.4% / 60.9% / 57.6% of the raw total for userIds 1421581 / 2895 / 1279061. Keep this in step
    // with `reactions_owner_scores`, which excludes self-reactions for the same reason, and with
    // Creator Studio's tile, which excludes self-comments — a metric named the same thing on two
    // surfaces must not mean two things.
    if (thread.ownerId && thread.ownerId !== record.userId) {
      actions.forMetric('User', thread.ownerId).as(record.userId).add('commentCount', value);
    }

    // Entity metrics stay at the four surfaces that already have a registered
    // (entityType, metricType) row in default.entityMetricKind. An unregistered pair falls into the
    // presence path and would silently count distinct commenters instead of comments.
    if (thread.postId) {
      const postMetric = actions.forMetric('Post', thread.postId).as(record.userId);
      postMetric.add('commentCount', value);
    }

    if (thread.imageId) {
      const imageMetric = actions.forMetric('Image', thread.imageId).as(record.userId);
      imageMetric.add('commentCount', value);
    }

    if (thread.articleId) {
      const articleMetric = actions.forMetric('Article', thread.articleId).as(record.userId);
      articleMetric.add('commentCount', value);
    }

    if (thread.bountyId) {
      const bountyMetric = actions.forMetric('Bounty', thread.bountyId).as(record.userId);
      bountyMetric.add('commentCount', value);
    }
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      threadId: faker.number.int({ min: 1, max: 5000 }),
    }),
    pg: (sql: string) => {
      if (sql.includes('Thread')) {
        const entityType = faker.helpers.arrayElement([
          'post',
          'image',
          'article',
          'bounty',
          'review',
          'model',
        ]);

        return {
          postId: entityType === 'post' ? faker.number.int({ min: 1, max: 5000 }) : null,
          imageId: entityType === 'image' ? faker.number.int({ min: 1, max: 5000 }) : null,
          articleId: entityType === 'article' ? faker.number.int({ min: 1, max: 5000 }) : null,
          bountyId: entityType === 'bounty' ? faker.number.int({ min: 1, max: 5000 }) : null,
          ownerId: faker.number.int({ min: 1, max: 1000 }),
        };
      }
      return null;
    },
  }),
});

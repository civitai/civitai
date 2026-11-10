import { createEventHandler } from './base';
import { COMMENT_V3_SURFACES } from './comment-v3';

/**
## Metrics driven by commentv2 table:
- UserMetric.commentCount (create/delete) — comments *received* by the owner of the commented-on
  entity, on the threads CommentV3 does not count: 3D model review and club post. An orphaned
  thread has no owner, so it counts nothing.

A surface in COMMENT_V3_SURFACES is counted by comment-v3.ts instead, entity metrics included, so it
is skipped here.
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
    // and its argument order carries no meaning.
    const thread = await pg.queryOne<{ surface: string | null; ownerId: number | null }>(
      `SELECT
        CASE
          WHEN COALESCE(r."postId", t."postId") IS NOT NULL THEN 'post'
          WHEN COALESCE(r."imageId", t."imageId") IS NOT NULL THEN 'image'
          WHEN COALESCE(r."articleId", t."articleId") IS NOT NULL THEN 'article'
          WHEN COALESCE(r."bountyId", t."bountyId") IS NOT NULL THEN 'bounty'
          WHEN COALESCE(r."reviewId", t."reviewId") IS NOT NULL THEN 'review'
          WHEN COALESCE(r."bountyEntryId", t."bountyEntryId") IS NOT NULL THEN 'bountyEntry'
          WHEN COALESCE(r."challengeId", t."challengeId") IS NOT NULL THEN 'challenge'
          WHEN COALESCE(r."comicProjectId", t."comicProjectId") IS NOT NULL THEN 'comicChapter'
          WHEN COALESCE(r."model3dId", t."model3dId") IS NOT NULL THEN 'model3d'
          WHEN COALESCE(r."appListingId", t."appListingId") IS NOT NULL THEN 'appListing'
          WHEN COALESCE(r."crucibleId", t."crucibleId") IS NOT NULL THEN 'crucible'
          WHEN COALESCE(r."storylineId", t."storylineId") IS NOT NULL THEN 'storyline'
          WHEN COALESCE(r."modelId", t."modelId") IS NOT NULL THEN 'model'
        END AS "surface",
        COALESCE(
          p."userId", i."userId", a."userId", b."userId",
          rev."userId", be."userId", ch."createdById", cp."userId", clp."createdById",
          m3d."userId", m3dr."userId", mdl."userId", al.user_id
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
      LEFT JOIN app_listings al ON al.serial_id = COALESCE(r."appListingId", t."appListingId")
      WHERE t.id = $1`,
      [record.threadId]
    );

    if (!thread) return;
    if (thread.surface && COMMENT_V3_SURFACES.includes(thread.surface)) return;

    // A creator answering their own commenters is not engagement received. Left in, it dominates:
    // 71.4% / 60.9% / 57.6% of the raw total for userIds 1421581 / 2895 / 1279061. Keep this in step
    // with `reactions_owner_scores`, which excludes self-reactions for the same reason, and with
    // Creator Studio's tile, which excludes self-comments — a metric named the same thing on two
    // surfaces must not mean two things.
    if (thread.ownerId && thread.ownerId !== record.userId) {
      actions.forMetric('User', thread.ownerId).as(record.userId).add('commentCount', value);
    }
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      threadId: faker.number.int({ min: 1, max: 5000 }),
    }),
    pg: (sql: string) => {
      if (sql.includes('Thread'))
        return {
          surface: faker.helpers.arrayElement([null, 'image', 'post']),
          ownerId: faker.number.int({ min: 1, max: 1000 }),
        };
      return null;
    },
  }),
});

import { createEventHandler } from './base';

/**
## Metrics driven by the CommentV3 table, which holds every comment:
- Article, Image, Post, Bounty and ModelMetric.commentCount (create, delete, tombstone)
- UserMetric.commentCount (same) — comments received by the owner of the commented-on entity

Replies count too. A deleted comment that keeps its replies stays as a tombstone (`deletedAt` set),
which takes it off the count; the tombstone's later removal does not take it off again.
*/

interface CommentV3Record {
  id: number;
  userId: number;
  entityType: string;
  entityId: number;
  deletedAt: string | number | null;
}

const ownedBy = (table: string, owner = '"userId"') =>
  `SELECT ${owner} AS "ownerId" FROM ${table} WHERE id = $1`;

/**
 * Per surface: the entity metric it feeds, if any, and how to find the owner. `metric` only for
 * pairs registered in the event engine's default.entityMetricKind; an unregistered pair silently
 * counts distinct commenters. Crucible and storyline have no entry: no comment table ever counted
 * them.
 */
const SURFACES: Record<string, { metric?: string; ownerSql: string }> = {
  article: { metric: 'Article', ownerSql: ownedBy('"Article"') },
  image: { metric: 'Image', ownerSql: ownedBy('"Image"') },
  post: { metric: 'Post', ownerSql: ownedBy('"Post"') },
  bounty: { metric: 'Bounty', ownerSql: ownedBy('"Bounty"') },
  model: { metric: 'Model', ownerSql: ownedBy('"Model"') },
  review: { ownerSql: ownedBy('"ResourceReview"') },
  bountyEntry: { ownerSql: ownedBy('"BountyEntry"') },
  challenge: { ownerSql: ownedBy('"Challenge"', '"createdById"') },
  model3d: { ownerSql: ownedBy('"Model3D"') },
  model3dReview: { ownerSql: ownedBy('"Model3DReview"') },
  // `entityId` is the listing's serial id.
  appListing: { ownerSql: `SELECT user_id AS "ownerId" FROM app_listings WHERE serial_id = $1` },
  comicChapter: {
    ownerSql: `SELECT p."userId" AS "ownerId" FROM "ComicChapter" c
      JOIN "ComicProject" p ON p.id = c."projectId" WHERE c.id = $1`,
  },
  // No metric: a storyline text has no metrics row.
  postText: {
    ownerSql: `SELECT p."userId" AS "ownerId" FROM "PostText" t
      JOIN "Post" p ON p.id = t."postId" WHERE t.id = $1`,
  },
};

export const commentV3Handler = createEventHandler<CommentV3Record>({
  tables: ['CommentV3'],
  operations: ['create', 'update', 'delete'],
  processor: async ({ operation, record, old, current, actions, pg }) => {
    let value: number;
    if (operation === 'create') value = 1;
    else if (operation === 'delete') value = record.deletedAt ? 0 : -1;
    // Only the update that tombstones a comment counts.
    else value = !old?.deletedAt && current?.deletedAt ? -1 : 0;
    if (!value) return;

    const surface = SURFACES[record.entityType];
    if (!surface) return;

    // Before any emit: a throw redelivers the message, and `metricSignals.sendDelta` is not
    // deduped, so an emit above this await double-fires the live delta on every retry.
    const owner = await pg.queryOne<{ ownerId: number | null }>(surface.ownerSql, [
      record.entityId,
    ]);

    if (surface.metric)
      actions
        .forMetric(surface.metric, record.entityId)
        .as(record.userId)
        .add('commentCount', value);
    // A creator answering their own commenters is not engagement received. Keep this in step with
    // `reactions_owner_scores`, which excludes self-reactions, and with Creator Studio's tile, which
    // excludes self-comments: a metric named the same on two surfaces must not mean two things.
    if (owner?.ownerId && owner.ownerId !== record.userId)
      actions.forMetric('User', owner.ownerId).as(record.userId).add('commentCount', value);
  },
  debug: (faker) => ({
    sample: () => ({
      id: faker.number.int({ min: 1, max: 100000 }),
      userId: faker.number.int({ min: 1, max: 1000 }),
      entityType: faker.helpers.arrayElement(Object.keys(SURFACES)),
      entityId: faker.number.int({ min: 1, max: 5000 }),
      deletedAt: null,
    }),
    pg: () => ({ ownerId: faker.number.int({ min: 1, max: 1000 }) }),
  }),
});

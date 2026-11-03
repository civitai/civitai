import { createEventHandler } from './base';

/**
## Metrics driven by the CommentV3 table, for the surfaces in COMMENT_V3_SURFACES:
- ArticleMetric.commentCount (create, delete, tombstone)
- UserMetric.commentCount (same) — comments received by the owner of the commented-on entity

A surface counts here once the main app writes its comments to CommentV3 directly
(`constants.comments.v3WriteSurfaces` in src/server/common/constants.ts; pinned by
comment-v3-surfaces.parity.test.ts).
Every comment on it is counted here, whichever table it was written to: one written to CommentV2
reaches CommentV3 through the mirror trigger, and `comment-v2.ts` skips these surfaces, so each
comment is counted once and the count does not depend on which service deploys first.

Replies count too. A deleted comment that keeps its replies stays as a tombstone (`deletedAt` set),
which takes it off the count; the tombstone's later removal does not take it off again.
*/

export const COMMENT_V3_SURFACES = ['article'];

interface CommentV3Record {
  id: number;
  userId: number;
  entityType: string;
  entityId: number;
  deletedAt: string | number | null;
}

/** Per surface: the entity metric it feeds, if any, and how to find the entity's owner. */
const SURFACES: Record<string, { metric?: string; ownerSql: string }> = {
  article: {
    metric: 'Article',
    ownerSql: `SELECT "userId" AS "ownerId" FROM "Article" WHERE id = $1`,
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
    if (!value || !COMMENT_V3_SURFACES.includes(record.entityType)) return;

    const surface = SURFACES[record.entityType];
    if (!surface) return;

    if (surface.metric)
      actions
        .forMetric(surface.metric, record.entityId)
        .as(record.userId)
        .add('commentCount', value);

    const owner = await pg.queryOne<{ ownerId: number | null }>(surface.ownerSql, [
      record.entityId,
    ]);
    // A creator answering their own commenters is not engagement received (see comment-v2.ts).
    if (owner?.ownerId && owner.ownerId !== record.userId)
      actions.forMetric('User', owner.ownerId).as(record.userId).add('commentCount', value);
  },
  debug: (faker) => ({
    sample: () => ({
      id: faker.number.int({ min: 1, max: 100000 }),
      userId: faker.number.int({ min: 1, max: 1000 }),
      entityType: 'article',
      entityId: faker.number.int({ min: 1, max: 5000 }),
      deletedAt: null,
    }),
    pg: () => ({ ownerId: faker.number.int({ min: 1, max: 1000 }) }),
  }),
});

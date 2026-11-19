import { createOutboxHandler } from '../base'

export const postHandler = createOutboxHandler({
  entityTypes: ['Post'],
  events: ['DELETED', 'PUBLISHED', 'UNPUBLISHED', 'UPDATED'],
  processor: async ({ event, entityId, actions, pg }) => {
    // Update the user's post count metric
    if (event === 'UPDATED') return;

    const { userId } = await pg.queryOne<{ userId: number | null }>(`
      SELECT p."userId"
      FROM "Post" p
      WHERE p.id = $1
    `, [entityId]) ?? {};

    const userMetrics = actions.forMetric('User', userId).as(userId);
    const value = ['DELETED', 'UNPUBLISHED'].includes(event) ? -1 : 1;
    userMetrics.add('postCount', value);
  }
})

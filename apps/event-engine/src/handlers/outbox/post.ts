import { createOutboxHandler } from '../base'

export const postHandler = createOutboxHandler({
  entityTypes: ['Post'],
  events: ['DELETED', 'PUBLISHED', 'UNPUBLISHED', 'UPDATED'],
  processor: async ({ event, entityId, actions, pg }) => {
    const { modelId, userId } = await pg.queryOne<{ modelId: number | null, userId: number | null }>(`
      SELECT mv."modelId", p."userId"
      FROM "Post" p
      LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
      WHERE p.id = $1
    `, [entityId]) ?? {};

    // If the post is tied to a model, and the user is the model owner, update the model feed too
    if (modelId) {
      const { modelOwnerId } = await pg.queryOne<{ modelOwnerId: number | null }>(`
        SELECT "userId" AS "modelOwnerId" FROM "Model" WHERE id = $1
      `, [modelId]) ?? {};
      if (modelOwnerId === userId) actions.feedUpdate('Model', modelId);
    }

    // Update the user's post count metric
    if (event !== 'UPDATED') {
      const userMetrics = actions.forMetric('User', userId).as(userId);
      const value = ['DELETED', 'UNPUBLISHED'].includes(event) ? -1 : 1;
      userMetrics.add('postCount', value);
    }

    // Always update the post feed
    actions.feedUpdate('Post', entityId, event === 'DELETED' ? 'delete' : 'update');
  }
})
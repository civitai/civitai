import { createOutboxHandler } from '../base'

export const modelVersionHandler = createOutboxHandler({
  entityTypes: ['ModelVersion'],
  events: ['DELETED', 'PUBLISHED', 'UNPUBLISHED', 'UPDATED'],
  processor: async ({ event, entityId, actions, pg }) => {
    const { userId, modelId } = await pg.queryOne<{ userId: number, modelId: number }>(`
      SELECT m."userId", mv."modelId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.id = $1
    `,
      [entityId]
    ) ?? {}

    if (['PUBLISHED', 'UNPUBLISHED'].includes(event)) {
      const value = event === 'PUBLISHED' ? 1 : -1
      const ownerMetrics = actions.forMetric('User', userId).as(userId)
      ownerMetrics.add('uploadCount', value)
    }

    actions.feedUpdate('Model', modelId, event === 'DELETED' ? 'delete' : 'update')
  }
})
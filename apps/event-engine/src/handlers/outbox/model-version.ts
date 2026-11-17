import { createOutboxHandler } from '../base'

export const modelVersionHandler = createOutboxHandler({
  entityTypes: ['ModelVersion'],
  events: ['DELETED', 'PUBLISHED', 'UNPUBLISHED', 'UPDATED'],
  processor: async ({ event, entityId, actions, pg }) => {
    if (!['PUBLISHED', 'UNPUBLISHED'].includes(event)) return

    const { userId } = await pg.queryOne<{ userId: number }>(`
      SELECT m."userId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mv.id = $1
    `,
      [entityId]
    ) ?? {}

    const value = event === 'PUBLISHED' ? 1 : -1
    const ownerMetrics = actions.forMetric('User', userId).as(userId)
    ownerMetrics.add('uploadCount', value)
  }
})

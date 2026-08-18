import { createEventHandler } from './base';

/**
## Metrics driven by comment table:
- ModelMetric.commentCount (create/delete)
- ModelVersionMetric.commentCount (create/delete)
- UserMetric.commentCount (create/delete) — comments *received* by the model's creator
*/

interface CommentRecord {
  userId: number;
  modelId: number;
}

export const commentHandler = createEventHandler<CommentRecord>({
  tables: ['Comment'],
  operations: ['create', 'delete'],
  processor: async ({ operation, record, actions, pg }) => {
    const value = operation === 'create' ? 1 : -1;

    const modelMetric = actions.forMetric('Model', record.modelId).as(record.userId);
    modelMetric.add('commentCount', value);

    // Model comments never reach CommentsV2, so this lookup is the only path to their owner.
    const model = await pg.queryOne<{ userId: number | null }>(
      `SELECT "userId" FROM "Model" WHERE id = $1`,
      [record.modelId]
    );

    // Self-authored excluded, matching commentV2Handler.
    if (model?.userId && model.userId !== record.userId) {
      actions.forMetric('User', model.userId).as(record.userId).add('commentCount', value);
    }
  },
  debug: (faker) => ({
    sample: () => ({
      userId: faker.number.int({ min: 1, max: 1000 }),
      modelId: faker.number.int({ min: 1, max: 1000 }),
    }),
    pg: (sql: string) => {
      if (sql.includes('"Model"')) {
        return { userId: faker.number.int({ min: 1, max: 1000 }) };
      }
      return null;
    },
  }),
});

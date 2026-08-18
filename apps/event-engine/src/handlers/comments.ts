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

    // Update model metric
    const modelMetric = actions.forMetric('Model', record.modelId).as(record.userId);
    modelMetric.add('commentCount', value);

    // Model comments are the largest single surface (1.17M), and they never reach CommentsV2, so
    // the owner has to be resolved here or User.commentCount stays a minority of the real total.
    const model = await pg.queryOne<{ userId: number | null }>(
      `SELECT "userId" FROM "Model" WHERE id = $1`,
      [record.modelId]
    );

    // Self-authored comments excluded, matching commentV2Handler — a creator replying under their
    // own model is not engagement received.
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

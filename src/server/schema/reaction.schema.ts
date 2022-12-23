import { z } from 'zod';

const reactionOutput = z
  .boolean()
  .optional()
  .transform((bool) => {
    if (bool === undefined) return undefined;
    return bool ? new Date() : null;
  });

export const reactionConnector = z.object({
  entityType: z.enum(['question', 'answer', 'comment']),
});

export type GetReactionInput = z.infer<typeof getReactionSchema>;
export const getReactionSchema = reactionConnector.extend({
  entityId: z.number(),
});

export type GetManyReactionsInput = z.infer<typeof getManyReactionsSchema>;
export const getManyReactionsSchema = reactionConnector.extend({
  entityIds: z.number().array(),
});

export type UpsertReactionSchema = z.infer<typeof upsertReactionSchema>;
export const upsertReactionSchema = reactionConnector.extend({
  id: z.number().optional(),
  like: reactionOutput,
  dislike: reactionOutput,
  laugh: reactionOutput,
  cry: reactionOutput,
  heart: reactionOutput,
  check: reactionOutput,
  cross: reactionOutput,
  entityId: z.number(),
});

// export type UpsertQuestionReactionSchema = z.infer<typeof upsertQuestionReactionSchema>;
// export const upsertQuestionReactionSchema = upsertReactionSchema
//   .extend({
//     questionId: z.number(),
//   })
//   .transform(({ questionId, ...obj }) => ({
//     entityType: 'question',
//     entityId: questionId,
//     ...obj,
//   }));

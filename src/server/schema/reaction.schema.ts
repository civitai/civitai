import { z } from 'zod';

const reactionOutput = z
  .boolean()
  .optional()
  .transform((bool) => {
    if (bool === undefined) return undefined;
    return bool ? new Date() : null;
  });

const connector = z.object({
  entityId: z.number(),
  entityType: z.enum(['question', 'answer', 'comment']),
});

export type GetReactionInput = z.infer<typeof getReactionSchema>;
export const getReactionSchema = connector;

export type UpsertReactionSchema = z.infer<typeof upsertReactionSchema>;
export const upsertReactionSchema = connector.extend({
  id: z.number().optional(),
  like: reactionOutput,
  dislike: reactionOutput,
  laugh: reactionOutput,
  cry: reactionOutput,
  heart: reactionOutput,
  check: reactionOutput,
  cross: reactionOutput,
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

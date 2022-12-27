import { number, z } from 'zod';

export type GetAnswersInput = z.infer<typeof getAnswersSchema>;
export const getAnswersSchema = z.object({
  questionId: number(),
});

export type UpsertAnswerInput = z.infer<typeof upsertAnswerSchema>;
export const upsertAnswerSchema = z.object({
  id: z.number().optional(),
  content: z.string(),
  questionId: z.number(),
});

export type AnswerVoteInput = z.infer<typeof answerVoteSchema>;
export const answerVoteSchema = z.object({
  id: z.number(),
  vote: z.boolean().nullable(),
  questionId: z.number().optional(),
  questionOwnerId: z.number().optional(),
});

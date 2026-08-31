import * as z from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

export type GetAnswersInput = z.infer<typeof getAnswersSchema>;
export const getAnswersSchema = z.object({
  questionId: z.number(),
});

export type UpsertAnswerInput = z.infer<typeof upsertAnswerSchema>;
export const upsertAnswerSchema = z.object({
  id: z.number().optional(),
  content: getSanitizedStringSchema(),
  questionId: z.number(),
});

export type AnswerVoteInput = z.infer<typeof answerVoteSchema>;
export const answerVoteSchema = z.object({
  id: z.number(),
  vote: z.boolean().nullable(),
  questionId: z.number().optional(),
  questionOwnerId: z.number().optional(),
});

import { QuestionStatus } from './../common/enums';
import { MetricTimeframe } from '@prisma/client';
import { z } from 'zod';
import { QuestionSort } from '~/server/common/enums';
import { getAllQuerySchema } from '~/server/schema/base.schema';
import { tagSchema } from '~/server/schema/tag.schema';

export type GetQuestionsInput = z.infer<typeof getQuestionsSchema>;
export const getQuestionsSchema = getAllQuerySchema.extend({
  tagname: z.string().optional(),
  sort: z.nativeEnum(QuestionSort).default(QuestionSort.Newest),
  period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
  status: z.nativeEnum(QuestionStatus).optional(),
});

export type UpsertQuestionInput = z.infer<typeof upsertQuestionSchema>;
export const upsertQuestionSchema = z.object({
  id: z.number().optional(),
  title: z.string(),
  content: z.string(),
  tags: z.array(tagSchema).nullish(),
});

export type SetQuestionAnswerInput = z.infer<typeof setQuestionAnswerSchema>;
export const setQuestionAnswerSchema = z.object({
  id: z.number(),
  answerId: z.number().nullable(),
});

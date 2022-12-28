import { z } from 'zod';

const connector = z.object({
  entityId: z.number(),
  entityType: z.enum(['question', 'answer']),
});

export type GetCommentsV2Input = z.infer<typeof getCommentsV2Schema>;
export const getCommentsV2Schema = connector;

export type UpsertCommentV2Input = z.infer<typeof upsertCommentv2Schema>;
export const upsertCommentv2Schema = connector.extend({
  id: z.number().optional(),
  content: z.string(),
  nsfw: z.boolean().optional(),
  tosViolation: z.boolean().optional(),
  parentId: z.number().nullish(),
});

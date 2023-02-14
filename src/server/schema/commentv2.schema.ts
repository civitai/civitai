import { z } from 'zod';

export type CommentConnectorInput = z.infer<typeof commentConnectorSchema>;
export const commentConnectorSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(['question', 'answer', 'image']),
});

export type GetCommentsV2Input = z.infer<typeof getCommentsV2Schema>;
export const getCommentsV2Schema = commentConnectorSchema.extend({
  limit: z.number().min(0).max(100).optional(),
  cursor: z.number().nullish(),
});

export type UpsertCommentV2Input = z.infer<typeof upsertCommentv2Schema>;
export const upsertCommentv2Schema = commentConnectorSchema.extend({
  id: z.number().optional(),
  content: z.string(),
  nsfw: z.boolean().optional(),
  tosViolation: z.boolean().optional(),
});

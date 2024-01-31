import { z } from 'zod';
import { CommentV2Sort } from '~/server/common/enums';

export type CommentConnectorInput = z.infer<typeof commentConnectorSchema>;
export const commentConnectorSchema = z.object({
  entityId: z.number(),
  entityType: z.enum([
    'question',
    'answer',
    'image',
    'post',
    'model',
    'comment',
    'review',
    'article',
    'bounty',
    'bountyEntry',
    'clubPost',
  ]),
  hidden: z.boolean().optional(),
  parentThreadId: z.number().optional(),
});

export type GetCommentsV2Input = z.infer<typeof getCommentsV2Schema>;
export const getCommentsV2Schema = commentConnectorSchema.extend({
  limit: z.number().min(0).max(100).default(20),
  cursor: z.number().nullish(),
  sort: z.nativeEnum(CommentV2Sort).optional(),
});

export type UpsertCommentV2Input = z.infer<typeof upsertCommentv2Schema>;
export const upsertCommentv2Schema = commentConnectorSchema.extend({
  id: z.number().optional(),
  content: z.string(),
  nsfw: z.boolean().optional(),
  tosViolation: z.boolean().optional(),
});

export type ToggleHideCommentInput = z.infer<typeof toggleHideCommentSchema>;
export const toggleHideCommentSchema = z.object({
  id: z.number(),
  entityId: z.number(),
  entityType: z.enum([
    'question',
    'answer',
    'image',
    'post',
    'model',
    'comment',
    'review',
    'article',
    'bounty',
    'bountyEntry',
    'clubPost',
  ]),
});

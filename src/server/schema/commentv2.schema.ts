import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { ThreadSort } from '~/server/common/enums';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

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
    'challenge',
  ]),
  hidden: z.boolean().nullish(),
  parentThreadId: z.number().optional(),
  excludedUserIds: z.array(z.number()).optional(),
});

export type UpsertCommentV2Input = z.infer<typeof upsertCommentv2Schema>;
export const upsertCommentv2Schema = commentConnectorSchema.extend({
  id: z.number().optional(),
  content: getSanitizedStringSchema({
    allowedTags: ['div', 'strong', 'p', 'em', 'u', 's', 'a', 'br', 'span'],
  })
    .refine((data) => {
      return data && data.length > 0 && data !== '<p></p>';
    }, 'Cannot be empty')
    .refine((data) => data.length <= constants.comments.maxLength, 'Comment content too long'),
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
    'challenge',
  ]),
});

export type GetCommentsInfiniteInput = z.infer<typeof getCommentsInfiniteSchema>;
export const getCommentsInfiniteSchema = commentConnectorSchema.extend({
  limit: z.number().min(1).max(100).default(20),
  sort: z.enum(ThreadSort).default(ThreadSort.Oldest),
  cursor: z.number().optional(),
});

import * as z from 'zod';
import { CacheTTL, constants } from '~/server/common/constants';
import { ThreadSort } from '~/server/common/enums';
import type { RateLimit } from '~/server/middleware.trpc';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { surfaceMayContainStickers } from '~/shared/utils/sticker-token';
import { CommentEntityType } from '~/shared/utils/prisma/enums';
import { COMMENT_ALLOWED_TAGS } from '~/utils/html-sanitize-helpers';
import { usageLimits } from '~/shared/constants/usage-limits';

export const commentRateLimits = usageLimits('comments.hourly', 'comments.daily');
/** Shared by every comment write surface and the usage-limits read. */
export const COMMENT_V3_RATE_LIMIT_KEY = 'commentv3:write';

/** What a comment can be written against: a section's entity, or the comment it replies to. */
export type CommentTargetType = CommentEntityType | 'comment';

const sort = z.enum(ThreadSort).default(ThreadSort.Oldest);
// Opaque keyset cursors from a previous page; the read service validates their contents.
const cursor = z.string().max(64).optional();

export type GetCommentSectionInput = z.infer<typeof getCommentSectionSchema>;
export const getCommentSectionSchema = z.object({
  entityType: z.enum(CommentEntityType),
  entityId: z.number().int().positive(),
  sort,
  cursor,
  /** Only the hidden top-level comments, on a surface whose section leaves them out. */
  hidden: z.boolean().optional(),
});

export type GetCommentRepliesInput = z.infer<typeof getCommentRepliesSchema>;
export const getCommentRepliesSchema = z.object({
  parentId: z.number().int().positive(),
  sort,
  cursor,
});

export type GetCommentThreadInput = z.infer<typeof getCommentThreadSchema>;
export const getCommentThreadSchema = z.object({
  commentId: z.number().int().positive(),
  // The page asking; a comment on any other entity is not found.
  entityType: z.enum(CommentEntityType),
  entityId: z.number().int().positive(),
  sort,
  /** The comment a link marks, which a model-page link may name by its old id. */
  highlight: z.number().int().positive().optional(),
});

export const commentContentSchema = getSanitizedStringSchema({
  allowedTags: COMMENT_ALLOWED_TAGS,
  // From STICKER_SURFACES, so "may contain a sticker" and "charges for one" cannot drift apart.
  allowStickers: surfaceMayContainStickers('comment'),
})
  .refine((data) => data && data.length > 0 && data !== '<p></p>', 'Cannot be empty')
  .refine((data) => data.length <= constants.comments.maxLength, 'Comment content too long');
const content = commentContentSchema;

export type CreateCommentV3Input = z.infer<typeof createCommentV3Schema>;
export const createCommentV3Schema = z.object({
  entityType: z.enum(CommentEntityType),
  entityId: z.number().int().positive(),
  /** A reply; its own row then decides the section, not `entityType`/`entityId`. */
  parentId: z.number().int().positive().optional(),
  content,
});

export type UpdateCommentV3Input = z.infer<typeof updateCommentV3Schema>;
export const updateCommentV3Schema = z.object({ id: z.number().int().positive(), content });

export type CommentV3IdInput = z.infer<typeof commentV3IdSchema>;
export const commentV3IdSchema = z.object({ id: z.number().int().positive() });

export type CommentSectionInput = z.infer<typeof commentSectionSchema>;
export const commentSectionSchema = z.object({
  entityType: z.enum(CommentEntityType),
  entityId: z.number().int().positive(),
});

export type CommentMuteInput = z.infer<typeof commentMuteSchema>;
export const commentMuteSchema = z.object({ commentId: z.number().int().positive() });

/** Generous: bounds enumeration, not muting. Shared by both mutes. */
export const muteRateLimits: RateLimit[] = [
  { limit: 60, period: CacheTTL.hour },
  { limit: 300, period: CacheTTL.day },
];

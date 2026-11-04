import * as z from 'zod';
import { ThreadSort } from '~/server/common/enums';
import { upsertCommentv2Schema } from '~/server/schema/commentv2.schema';
import { CommentEntityType } from '~/shared/utils/prisma/enums';

const sort = z.enum(ThreadSort).default(ThreadSort.Oldest);
// Opaque keyset cursors from a previous page; the read service validates their contents.
const cursor = z.string().max(64).optional();

export type GetCommentSectionInput = z.infer<typeof getCommentSectionSchema>;
export const getCommentSectionSchema = z.object({
  entityType: z.enum(CommentEntityType),
  entityId: z.number().int().positive(),
  sort,
  cursor,
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
});

const content = upsertCommentv2Schema.shape.content;

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

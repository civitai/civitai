import * as z from 'zod';
import { throwBadRequestError } from '~/server/utils/errorHandling';

// Both comment actions span two tables (`Comment` and `CommentV2`) and take the same pair of id lists,
// so the schema and the "at least one" rule live here rather than being written twice and drifting.

const idList = z.array(z.coerce.number().int().positive()).max(500);

export const commentIdSchema = z.object({
  commentIds: idList.optional().describe('Ids from the legacy `Comment` table (model threads).'),
  commentV2Ids: idList
    .optional()
    .describe('Ids from `CommentV2` (image, article, post, bounty threads).'),
});

/** Enforced in the handler, not the schema: `.refine()` returns a ZodEffects, and `specToDoc` needs a
 *  ZodObject to project the params for the docs page. */
export function ensureAtLeastOneList(input: { commentIds?: number[]; commentV2Ids?: number[] }) {
  if ((input.commentIds?.length ?? 0) + (input.commentV2Ids?.length ?? 0) === 0) {
    throw throwBadRequestError('At least one of commentIds or commentV2Ids must be non-empty');
  }
}

export const commentAffected = (input: { commentIds?: number[]; commentV2Ids?: number[] }) => ({
  commentIds: input.commentIds ?? [],
  commentV2Ids: input.commentV2Ids ?? [],
});

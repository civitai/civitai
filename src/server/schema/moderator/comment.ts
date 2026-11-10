import * as z from 'zod';

const idList = z.array(z.coerce.number().int().positive()).max(500);

export const commentIdSchema = z.object({
  commentIds: idList.min(1).describe('Comment ids.'),
});

export const commentAffected = (input: { commentIds: number[] }) => ({
  commentIds: input.commentIds,
});

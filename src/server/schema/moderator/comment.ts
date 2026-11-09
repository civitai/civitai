import * as z from 'zod';

const idList = z.array(z.coerce.number().int().positive()).max(500);

// Shared by the comment actions, so the contract is written once.
export const commentIdSchema = z.object({
  commentV2Ids: idList
    .min(1)
    .describe('Comment ids. CommentV3 shares its ids with CommentV2, whose name this field keeps.'),
});

export const commentAffected = (input: { commentV2Ids: number[] }) => ({
  commentV2Ids: input.commentV2Ids,
});

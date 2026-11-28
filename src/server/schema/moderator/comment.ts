import * as z from 'zod';

const idList = z.array(z.coerce.number().int().positive()).max(500);

export const commentIdSchema = z.object({
  commentIds: idList.min(1).describe('Comment ids.'),
});

export const commentAffected = (input: { commentIds: number[] }) => ({
  commentIds: input.commentIds,
});

/** A moderator's hide or unhide of one Feature Pages comment, bound to what they saw. */
export const fpVisibilitySchema = z.discriminatedUnion('hidden', [
  z.object({
    commentId: z.number().int().positive().describe('A Feature Pages comment id.'),
    hidden: z.literal(true),
    seenVersion: z.number().int().positive().describe('The text version the moderator saw.'),
  }),
  z.object({
    commentId: z.number().int().positive(),
    hidden: z.literal(false),
    seenVersion: z.number().int().positive(),
    seenHiddenAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/)
      .describe('The hide the moderator saw: `hiddenAt::text`.'),
    exceptReportId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('The open report the moderator is ruling on, which does not hold the unhide.'),
  }),
]);

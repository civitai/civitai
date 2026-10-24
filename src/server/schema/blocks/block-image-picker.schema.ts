import * as z from 'zod';

/**
 * Earliest "jump to date" accepted. A year still being typed reads as 0002, 0020, 0202; the picker
 * does not apply those (the grid would flash empty for a date nobody meant), and this keeps the
 * procedure's input to the same dates.
 */
export const PICKER_JUMP_MIN_DATE = new Date('2000-01-01T00:00:00.000Z');

export const getBlockPickablePostedImagesSchema = z.object({
  limit: z.number().int().min(1).max(100).default(40),
  cursor: z.number().int().positive().optional(),
  /** List only images created at or before this moment: the picker's "jump to date". */
  toDate: z.date().min(PICKER_JUMP_MIN_DATE).optional(),
  /** List only images whose post is not Private: the app asked `OPEN_IMAGE_PICKER` for `publicOnly`. */
  publicOnly: z.boolean().optional(),
});
export type GetBlockPickablePostedImagesInput = z.infer<typeof getBlockPickablePostedImagesSchema>;

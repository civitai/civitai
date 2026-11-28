import * as z from 'zod';

/** The query of the moderator and owner retracted-media routes: one image id. */
export const retractedMediaQuerySchema = z.object({
  imageId: z.coerce.number().int().positive().max(2_147_483_647),
});

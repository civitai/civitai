import * as z from 'zod';

/** The query of the routes that stream a stored image by id: held media and retracted media. */
export const storedMediaQuerySchema = z.object({
  imageId: z.coerce.number().int().positive().max(2_147_483_647),
});

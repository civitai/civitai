import * as z from 'zod/v4';

export const getModelByAirSchema = z.object({
  air: z.string(),
});

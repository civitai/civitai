import { z } from 'zod';

export const getModelByAirSchema = z.object({
  air: z.string(),
});

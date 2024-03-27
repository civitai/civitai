import { z } from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';

export type GetPaginatedCosmeticsInput = z.infer<typeof getPaginatedCosmeticsSchema>;
export const getPaginatedCosmeticsSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
  })
);

import { CosmeticType } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';

export type GetPaginatedCosmeticShopItemInput = z.infer<typeof getPaginatedCosmeticShopItemInput>;
export const getPaginatedCosmeticShopItemInput = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    name: z.string().optional(),
    types: z.array(z.nativeEnum(CosmeticType)).optional(),
    minPrice: z.number().optional(),
    maxPrice: z.number().optional(),
  })
);

import { CosmeticType, CosmeticEntity } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';

export type GetPaginatedCosmeticsInput = z.infer<typeof getPaginatedCosmeticsSchema>;
export const getPaginatedCosmeticsSchema = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    name: z.string().optional(),
    types: z.array(z.nativeEnum(CosmeticType)).optional(),
  })
);

export type EquipCosmeticInput = z.infer<typeof equipCosmeticSchema>;
export const equipCosmeticSchema = z.object({
  cosmeticId: z.number(),
  equippedToId: z.number(),
  claimKey: z.string().min(1),
  equippedToType: z.nativeEnum(CosmeticEntity),
});

export type CosmeticInputSchema = z.infer<typeof cosmeticInputSchema>;
export const cosmeticInputSchema = z.object({
  id: z.number(),
  claimKey: z.string(),
  // data: z.object({}).passthrough().nullable(),
});

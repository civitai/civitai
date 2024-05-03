import { CosmeticType } from '@prisma/client';
import { z } from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';
import { comfylessImageSchema } from '~/server/schema/image.schema';

export type GetPaginatedCosmeticShopItemInput = z.infer<typeof getPaginatedCosmeticShopItemInput>;
export const getPaginatedCosmeticShopItemInput = paginationSchema.merge(
  z.object({
    limit: z.coerce.number().min(1).max(200).default(60),
    name: z.string().optional(),
    types: z.array(z.nativeEnum(CosmeticType)).optional(),
    minPrice: z.number().optional(),
    maxPrice: z.number().optional(),
    archived: z.boolean().optional(),
  })
);

export type CosmeticShopItemMeta = z.infer<typeof cosmeticShopItemMeta>;
export const cosmeticShopItemMeta = z.object({
  paidToUserIds: z.array(z.number()).optional(),
});

export type UpsertCosmeticShopItemInput = z.infer<typeof upsertCosmeticShopItemInput>;
export const upsertCosmeticShopItemInput = z.object({
  id: z.number().optional(),
  title: z.string().max(255),
  description: z.string().nullish(),
  cosmeticId: z.number(),
  unitAmount: z.number(),
  availableFrom: z.date().nullish(),
  availableTo: z.date().nullish(),
  availableQuantity: z.number().nullish(),
  archived: z.boolean().optional(),
  meta: cosmeticShopItemMeta.optional(),
  addToSectionIds: z.array(z.number()).optional(),
});

export type GetAllCosmeticShopSections = z.infer<typeof getAllCosmeticShopSections>;
export const getAllCosmeticShopSections = z.object({
  title: z.string().optional(),
  withItems: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export type CosmeticShopSectionMeta = z.infer<typeof cosmeticShopSectionMeta>;
export const cosmeticShopSectionMeta = z.object({
  hideTitle: z.boolean().optional(),
});

export type UpsertCosmeticShopSectionInput = z.infer<typeof upsertCosmeticShopSectionInput>;
export const upsertCosmeticShopSectionInput = z.object({
  id: z.number().optional(),
  title: z.string().max(255),
  description: z.string().nullish(),
  placement: z.number().optional(),
  items: z.array(z.number()).optional(),
  image: comfylessImageSchema.nullish(),
  published: z.boolean().optional(),
  meta: cosmeticShopSectionMeta.optional(),
});

export type UpdateCosmeticShopSectionsOrderInput = z.infer<
  typeof updateCosmeticShopSectionsOrderInput
>;
export const updateCosmeticShopSectionsOrderInput = z.object({
  sortedSectionIds: z.array(z.number()),
});

export type PurchaseCosmeticShopItemInput = z.infer<typeof purchaseCosmeticShopItemInput>;
export const purchaseCosmeticShopItemInput = z.object({
  shopItemId: z.number(),
});

export type GetPreviewImagesInput = z.infer<typeof getPreviewImagesInput>;
export const getPreviewImagesInput = z.object({
  browsingLevel: z.number(),
  limit: z.number().optional(),
});

export type GetShopInput = z.infer<typeof getShopInput>;
export const getShopInput = z.object({
  cosmeticTypes: z.array(z.nativeEnum(CosmeticType)).optional(),
});

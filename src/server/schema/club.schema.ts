import { z } from 'zod';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { comfylessImageSchema } from '~/server/schema/image.schema';
import { Currency } from '@prisma/client';

export type UpsetClubTiersInput = z.infer<typeof upsertClubTiersInput>;
export const upsertClubTiersInput = z.object({
  id: z.number().optional(),
  name: z.string().trim().nonempty(),
  description: getSanitizedStringSchema().refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  unitAmount: z.number().min(0),
  currency: z.nativeEnum(Currency).default(Currency.BUZZ),
  coverImage: comfylessImageSchema.nullish(),
  unlisted: z.boolean().optional(),
  joinable: z.boolean().default(true),
});

export type UpsertClubInput = z.infer<typeof upsertClubInput>;
export const upsertClubInput = z.object({
  id: z.number().optional(),
  name: z.string().trim().nonempty(),
  description: getSanitizedStringSchema().refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  nsfw: z.boolean().optional(),
  billing: z.boolean().optional(),
  unlisted: z.boolean().optional(),
  coverImage: comfylessImageSchema.nullish(),
  headerImage: comfylessImageSchema.nullish(),
  avatar: comfylessImageSchema.nullish(),
  tiers: z.array(upsertClubTiersInput).optional(),
  deleteTierIds: z.array(z.number()).optional(),
});

export type GetClubTiersInput = z.infer<typeof getClubTiersInput>;

export const getClubTiersInput = z.object({
  clubId: z.number(),
  listedOnly: z.boolean().default(true),
  joinableOnly: z.boolean().default(true),
  include: z.array(z.enum(['membershipsCount'])).optional(),
});

import { Currency } from '@prisma/client';
import { z } from 'zod';
import { imageGenerationSchema, imageSchema } from '~/server/schema/image.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { baseFileSchema } from './file.schema';

export type BountyEntryFileMeta = z.infer<typeof bountyEntryFileMeta>;

const bountyEntryFileMeta = z
  .object({
    unlockAmount: z.number(),
    currency: z.nativeEnum(Currency),
    benefactorsOnly: z.boolean(),
  })
  .partial();

export type UpsertBountyEntryInput = z.infer<typeof upsertBountyEntryInputSchema>;

export const bountyEntryFileSchema = baseFileSchema.extend({
  metadata: bountyEntryFileMeta,
});
export const upsertBountyEntryInputSchema = z.object({
  id: z.number().optional(),
  bountyId: z.number(),
  files: z.array(bountyEntryFileSchema).min(1),
  ownRights: z.boolean().optional(),
  images: z
    .array(imageSchema.extend({ meta: imageGenerationSchema.omit({ comfy: true }).nullish() }))
    .min(1, 'At least one example image must be uploaded'),
  description: getSanitizedStringSchema().nullish(),
});

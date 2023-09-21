import { z } from 'zod';
import { baseFileSchema } from './file.schema';
import { imageSchema } from '~/server/schema/image.schema';
import { Currency } from '@prisma/client';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';

export type BountyEntryFileMeta = z.infer<typeof bountyEntryFileMeta>;

const bountyEntryFileMeta = z
  .object({
    unlockAmount: z.number(),
    currency: z.nativeEnum(Currency),
    benefactorsOnly: z.boolean(),
  })
  .partial();

export type UpsertBountyEntryInput = z.infer<typeof upsertBountyEntryInputSchema>;

const bountyEntryFileSchema = baseFileSchema.extend({
  metadata: bountyEntryFileMeta,
});
export const upsertBountyEntryInputSchema = z.object({
  id: z.number().optional(),
  bountyId: z.number(),
  files: z.array(bountyEntryFileSchema).min(1),
  images: z.array(imageSchema).min(1, 'At least one example image must be uploaded'),
  description: getSanitizedStringSchema().nullish(),
});

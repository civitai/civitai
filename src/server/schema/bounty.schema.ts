import { BountyType, BountyMode } from '@prisma/client';
import { z } from 'zod';
import { baseFileSchema } from './file.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { tagSchema } from './tag.schema';

export type UpsertBountyInput = z.infer<typeof upsertBountyInputSchema>;
export const upsertBountyInputSchema = z.object({
  id: z.number().optional(),
  name: z.string().trim().nonempty(),
  description: getSanitizedStringSchema().refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  details: z.object({}).passthrough().optional(),
  expiresAt: z.date().min(new Date(), 'Expiration date must be in the future'),
  type: z.nativeEnum(BountyType),
  mode: z.nativeEnum(BountyMode),
  minBenefactorBuzzAmount: z.number().min(1),
  maxBenefactorBuzzAmount: z.number().optional(),
  entryLimit: z.number().min(1).optional(),
  tags: z.array(tagSchema).optional(),
  files: z.array(baseFileSchema).optional(),
});

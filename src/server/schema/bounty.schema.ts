import dayjs from 'dayjs';
import { BountyType, BountyMode, MetricTimeframe, Currency, BountyEntryMode } from '@prisma/client';
import { z } from 'zod';
import { baseFileSchema } from './file.schema';
import { getSanitizedStringSchema } from '~/server/schema/utils.schema';
import { tagSchema } from './tag.schema';
import { infiniteQuerySchema } from './base.schema';
import { BountySort, BountyStatus } from '../common/enums';
import { imageSchema } from '~/server/schema/image.schema';
import { constants } from '~/server/common/constants';

export type GetInfiniteBountySchema = z.infer<typeof getInfiniteBountySchema>;
export const getInfiniteBountySchema = infiniteQuerySchema.merge(
  z.object({
    query: z.string().optional(),
    types: z.nativeEnum(BountyType).array().optional(),
    mode: z.nativeEnum(BountyMode).optional(),
    status: z.nativeEnum(BountyStatus).optional(),
    nsfw: z.boolean().optional(),
    period: z.nativeEnum(MetricTimeframe).default(MetricTimeframe.AllTime),
    sort: z.nativeEnum(BountySort).default(BountySort.Newest),
  })
);

export type BountyDetailsSchema = z.infer<typeof bountyDetailsSchema>;
export const bountyDetailsSchema = z.object({
  baseModel: z.enum(constants.baseModels),
});

export type CreateBountyInput = z.infer<typeof createBountyInputSchema>;
export const createBountyInputSchema = z.object({
  name: z.string().trim().nonempty(),
  description: getSanitizedStringSchema().refine((data) => {
    return data && data.length > 0 && data !== '<p></p>';
  }, 'Cannot be empty'),
  unitAmount: z.number().min(5000),
  currency: z.nativeEnum(Currency),
  expiresAt: z
    .date()
    .min(dayjs().add(1, 'day').startOf('day').toDate(), 'Expiration date must be in the future'),
  startsAt: z.date().min(dayjs().startOf('day').toDate(), 'Start date must be in the future'),
  mode: z.nativeEnum(BountyMode),
  type: z.nativeEnum(BountyType),
  details: bountyDetailsSchema.passthrough().optional(),
  entryMode: z.nativeEnum(BountyEntryMode),
  minBenefactorUnitAmount: z.number().min(1),
  maxBenefactorUnitAmount: z.number().optional(),
  entryLimit: z.number().min(1).optional(),
  tags: z.array(tagSchema).optional(),
  nsfw: z.boolean().optional(),
  files: z.array(baseFileSchema).optional(),
  images: z.array(imageSchema).min(1, 'At least one example image must be uploaded'),
});

export type UpdateBountyInput = z.infer<typeof updateBountyInputSchema>;
export const updateBountyInputSchema = createBountyInputSchema
  .pick({
    description: true,
    tags: true,
    files: true,
  })
  .merge(z.object({ id: z.number(), startsAt: z.date(), expiresAt: z.date() }));

export type AddBenefactorUnitAmountInputSchema = z.infer<typeof addBenefactorUnitAmountInputSchema>;
export const addBenefactorUnitAmountInputSchema = z.object({
  unitAmount: z.number().min(1),
  bountyId: z.number(),
});

export type GetBountyEntriesInputSchema = z.infer<typeof getBountyEntriesInputSchema>;
export const getBountyEntriesInputSchema = z.object({
  id: z.number(),
  owned: z.boolean().optional(),
});

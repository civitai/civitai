import {
  BountyEntryMode,
  BountyMode,
  BountyType,
  Currency,
  MetricTimeframe,
} from '~/shared/utils/prisma/enums';
import dayjs from '~/shared/utils/dayjs';
import * as z from 'zod';
import { constants } from '~/server/common/constants';
import { imageGenerationSchema, imageSchema } from '~/server/schema/image.schema';
import { BountySort, BountyStatus } from '../common/enums';
import { infiniteQuerySchema } from './base.schema';
import { baseFileSchema } from './file.schema';
import { tagSchema } from './tag.schema';
import { stripTime } from '~/utils/date-helpers';
import { stringToDate } from '~/utils/zod-helpers';
import { baseModels } from '~/shared/constants/base-model.constants';

export type GetInfiniteBountySchema = z.infer<typeof getInfiniteBountySchema>;
export const getInfiniteBountySchema = infiniteQuerySchema.merge(
  z.object({
    query: z.string().optional(),
    types: z.enum(BountyType).array().optional(),
    mode: z.enum(BountyMode).optional(),
    status: z.enum(BountyStatus).optional(),
    nsfw: z.boolean().optional(),
    period: z.enum(MetricTimeframe).default(MetricTimeframe.AllTime),
    sort: z.enum(BountySort).default(BountySort.Newest),
    engagement: z.enum(constants.bounties.engagementTypes).optional(),
    userId: z.number().optional(),
    baseModels: z.enum(baseModels).array().optional(),
    limit: z.coerce.number().min(1).max(200).default(60),
    excludedUserIds: z.number().array().optional(),
  })
);

export type BountyDetailsSchema = z.infer<typeof bountyDetailsSchema>;
export const bountyDetailsSchema = z.object({
  baseModel: z.enum(baseModels),
  modelSize: z.enum(constants.modelFileSizes),
  modelFormat: z.enum(constants.modelFileFormats),
});

export type CreateBountyInput = z.infer<typeof createBountyInputSchema>;
export const createBountyInputSchema = z.object({
  name: z.string().trim().nonempty(),
  description: z.string().nonempty(),
  unitAmount: z
    .number()
    .min(constants.bounties.minCreateAmount)
    .max(constants.bounties.maxCreateAmount),
  currency: z.enum(Currency),
  expiresAt: stringToDate(
    z
      .date()
      .min(
        dayjs.utc(stripTime(new Date())).add(1, 'day').toDate(),
        'Expiration date must come after the start date'
      )
  ),
  startsAt: z.coerce
    .date()
    .min(dayjs.utc(stripTime(new Date())).toDate(), 'Start date must be in the future'),
  mode: z.enum(BountyMode),
  type: z.enum(BountyType),
  details: bountyDetailsSchema.passthrough().partial().optional(),
  entryMode: z.enum(BountyEntryMode),
  minBenefactorUnitAmount: z.number().min(1),
  maxBenefactorUnitAmount: z.number().optional(),
  entryLimit: z.number().min(1).optional(),
  tags: z.array(tagSchema).optional(),
  nsfw: z.boolean().optional(),
  poi: z.boolean().optional(),
  ownRights: z.boolean().optional(),
  files: z.array(baseFileSchema).optional(),
  images: z
    .array(imageSchema.extend({ meta: imageGenerationSchema.omit({ comfy: true }).nullish() }))
    .min(1, 'At least one example image must be uploaded'),
});

export type UpdateBountyInput = z.infer<typeof updateBountyInputSchema>;
export const updateBountyInputSchema = createBountyInputSchema
  .pick({
    name: true,
    description: true,
    tags: true,
    files: true,
    type: true,
    details: true,
    poi: true,
    nsfw: true,
    ownRights: true,
    images: true,
    entryLimit: true,
  })
  .extend({
    id: z.number(),
    startsAt: z.coerce.date(),
    expiresAt: stringToDate(
      z
        .date()
        .min(dayjs().add(1, 'day').startOf('day').toDate(), 'Expiration date must be in the future')
    ),
    lockedProperties: z.string().array().optional(),
  });

export type UpsertBountyInput = z.infer<typeof upsertBountyInputSchema>;
export const upsertBountyInputSchema = createBountyInputSchema.extend({
  id: z.number().optional(),
  startsAt: z.string(),
  expiresAt: z.string(),
  lockedProperties: z.string().array().optional(),
});

export type AddBenefactorUnitAmountInputSchema = z.infer<typeof addBenefactorUnitAmountInputSchema>;
export const addBenefactorUnitAmountInputSchema = z.object({
  unitAmount: z.number().min(1),
  bountyId: z.number(),
});

export type GetBountyEntriesInputSchema = z.infer<typeof getBountyEntriesInputSchema>;
export const getBountyEntriesInputSchema = infiniteQuerySchema.extend({
  id: z.number(),
  owned: z.boolean().optional(),
});

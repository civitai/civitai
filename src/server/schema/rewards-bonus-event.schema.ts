import * as z from 'zod';
import { paginationSchema } from '~/server/schema/base.schema';

export const REWARDS_BONUS_MULTIPLIER_OPTIONS = [15, 20, 30, 40] as const;
export type RewardsBonusMultiplier = (typeof REWARDS_BONUS_MULTIPLIER_OPTIONS)[number];

export function formatRewardsBonusMultiplierLabel(multiplier: number): string {
  const value = multiplier / 10;
  if (value < 2) return `${Math.round((value - 1) * 100)}% MORE BUZZ`;
  if (multiplier % 10 === 0) return `${value}x BUZZ`;
  return `${value.toFixed(1)}x BUZZ`;
}

export const multiplierSchema = z
  .number()
  .int()
  .refine((v) => (REWARDS_BONUS_MULTIPLIER_OPTIONS as readonly number[]).includes(v), {
    message: `Multiplier must be one of: ${REWARDS_BONUS_MULTIPLIER_OPTIONS.join(', ')}`,
  });

export type UpsertRewardsBonusEventSchema = z.infer<typeof upsertRewardsBonusEventSchema>;
export const upsertRewardsBonusEventSchema = z
  .object({
    id: z.number().int().optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(5000).nullish(),
    multiplier: multiplierSchema,
    articleId: z.number().int().positive().nullish(),
    bannerLabel: z.string().trim().max(60).nullish(),
    enabled: z.boolean().default(false),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
  })
  .refine((v) => !v.startsAt || !v.endsAt || v.startsAt <= v.endsAt, {
    message: 'Start date must be before end date',
    path: ['endsAt'],
  });

export type GetRewardsBonusEventsPagedSchema = z.infer<typeof getRewardsBonusEventsPagedSchema>;
export const getRewardsBonusEventsPagedSchema = paginationSchema;

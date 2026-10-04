import * as z from 'zod';
import { PrizeSourceType } from '~/shared/utils/prisma/enums';

export const prizeBuzzTypes = ['green', 'yellow'] as const;
export type PrizeBuzzType = (typeof prizeBuzzTypes)[number];

export const getPrizeSchema = z.object({ id: z.number().int().positive() });
export type GetPrizeSchema = z.infer<typeof getPrizeSchema>;

export const claimPrizeSchema = z.object({
  id: z.number().int().positive(),
  buzzType: z.enum(prizeBuzzTypes).optional(),
});
export type ClaimPrizeSchema = z.infer<typeof claimPrizeSchema>;

export const getMyPrizesSchema = z
  .object({ sourceType: z.nativeEnum(PrizeSourceType), sourceId: z.number().int().positive() })
  .optional();
export type GetMyPrizesSchema = z.infer<typeof getMyPrizesSchema>;

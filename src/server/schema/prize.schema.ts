import * as z from 'zod';
import type { PurchasableBuzzType } from '~/shared/constants/buzz.constants';
import { PrizeSourceType } from '~/shared/utils/prisma/enums';

// A prize pays in the currencies Buzz can be bought in.
export const prizeBuzzTypes = ['green', 'yellow'] as const satisfies readonly PurchasableBuzzType[];
export type PrizeBuzzType = PurchasableBuzzType;

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

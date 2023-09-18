import { z } from 'zod';

export type GetUserReferralCodesSchema = z.infer<typeof getUserReferralCodesSchema>;
export const getUserReferralCodesSchema = z.object({ userId: z.number().optional() });

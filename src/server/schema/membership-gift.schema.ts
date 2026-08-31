import * as z from 'zod';

export const giftableTierSchema = z.enum(['bronze', 'silver', 'gold']);
export type GiftableTier = z.infer<typeof giftableTierSchema>;

export const giftMonthsOptions = [1, 3, 6] as const;
const giftMonthsSchema = z.union([z.literal(1), z.literal(3), z.literal(6)]);

export type CreateMembershipGiftCheckoutInput = z.infer<typeof createMembershipGiftCheckoutSchema>;
export const createMembershipGiftCheckoutSchema = z.object({
  recipientUserId: z.number(),
  tier: giftableTierSchema,
  months: giftMonthsSchema,
  message: z.string().trim().max(500).optional(),
  anonymous: z.boolean().default(false),
});

export type GetRecipientGiftabilityInput = z.infer<typeof getRecipientGiftabilitySchema>;
export const getRecipientGiftabilitySchema = z.object({
  recipientUserId: z.number(),
});

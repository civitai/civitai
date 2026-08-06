import * as z from 'zod';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { booleanString } from '~/utils/zod-helpers';

export type GetPlansSchema = z.infer<typeof getPlansSchema>;
export const getPlansSchema = z.object({
  paymentProvider: z.enum(PaymentProvider).optional(),
  interval: z.enum(['month', 'year']).optional(),
  buzzType: z.string().optional(),
  // Buzz-purchased (perks-only) products are a separate catalog: they're excluded from
  // the cash plans unless this is set, and they're the ONLY thing returned when it is.
  buzzPurchase: z.boolean().optional(),
});

export type GetUserSubscriptionInput = z.infer<typeof getUserSubscriptionSchema>;
export const getUserSubscriptionSchema = z.object({
  userId: z.number(),
  buzzType: z.string().optional(),
  includeBadState: z.boolean().optional(),
  // Opt in to falling back to the Buzz-membership slot when `buzzType` turns up empty.
  // Off by default: callers that probe a SPECIFIC colour to answer "do you also have a
  // membership over there?" must not be told yes because of a Buzz one.
  includeBuzzPurchase: z.boolean().optional(),
  includeCanceled: z.boolean().optional(),
});

export type ProductTier = z.infer<typeof productTierSchema>;
const productTierSchema = z.enum(['free', 'founder', 'bronze', 'silver', 'gold']);
export type SubscriptionProductMetadata = z.infer<typeof subscriptionProductMetadataSchema>;
export const subscriptionProductMetadataSchema = z.looseObject({
  vaultSizeKb: z.coerce.number().nonnegative().optional(),
  badge: z.string().optional(),
  monthlyBuzz: z.coerce.number().nonnegative().optional(),
  animatedBadge: booleanString().optional(),
  badgeType: z.enum(['none', 'static', 'animated']).default('none'),
  tier: productTierSchema,
  generationLimit: z.coerce.number().nonnegative().optional(),
  quantityLimit: z.coerce.number().nonnegative().optional(),
  queueLimit: z.coerce.number().nonnegative().optional(),
  rewardsMultiplier: z.coerce.number().positive().default(1),
  purchasesMultiplier: z.coerce.number().positive().default(1),
  buzzType: z.enum(['green', 'yellow', 'blue', 'red']).default('yellow'),

  // Makes it so that we include it when creating a paddle transaction.
  // Used for Save Details only.
  includeWithTransaction: booleanString().optional(),
  maxPrivateModels: z.coerce.number().nonnegative().optional(),
  supportLevel: z.string().optional(),

  // Perks-only membership bought with Buzz instead of money. Grants the tier's UI/limit
  // perks but no monthly Buzz, no purchase bonus, and no Creator Program eligibility.
  buzzPurchase: booleanString().optional(),
  // Per-month Buzz price override; falls back to the cash price plus the standard premium.
  buzzPrice: z.coerce.number().nonnegative().optional(),
});

export const prepaidTokenStatusSchema = z.enum(['locked', 'unlocked', 'claimed']);
export type PrepaidTokenStatus = z.infer<typeof prepaidTokenStatusSchema>;

export const prepaidTokenSchema = z.object({
  id: z.string(),
  tier: productTierSchema,
  status: prepaidTokenStatusSchema,
  buzzAmount: z.number(),
  codeId: z.string().optional(),
  unlockedAt: z.string().optional(), // ISO date — when the token was actually unlocked
  claimedAt: z.string().optional(), // ISO date — when the user claimed it
  buzzTransactionId: z.string().optional(),
  // Human-readable label for historical virtual tokens (e.g. "Annual · Aug 2025",
  // "Membership · Sep 2025", or the original support-ticket description).
  description: z.string().optional(),
});
export type PrepaidToken = z.infer<typeof prepaidTokenSchema>;

export const claimPrepaidTokenSchema = z.object({
  tokenId: z.string(),
});
export type ClaimPrepaidTokenInput = z.infer<typeof claimPrepaidTokenSchema>;

export const purchaseMembershipWithBuzzSchema = z.object({
  priceId: z.string(),
  // No buzzType here on purpose: the account debited is the domain's currency
  // (getAllowedAccountTypes at the router), not something the caller gets to pick.
});
export type PurchaseMembershipWithBuzzInput = z.infer<typeof purchaseMembershipWithBuzzSchema>;

export function getMembershipBuzzTransactionId({
  date,
  userId,
  productId,
}: {
  date: string;
  userId: number;
  productId: string;
}) {
  return `civitai-membership:${date}:${userId}:${productId}:v3`;
}

export type SubscriptionMetadata = z.infer<typeof subscriptionMetadata>;

export const subscriptionMetadata = z.looseObject({
  renewalEmailSent: z.boolean().optional(),
  renewalBonus: z.number().optional(),
  // Legacy fields — kept for backwards compatibility during migration
  prepaids: z.partialRecord(productTierSchema, z.number()).optional(),
  proratedDays: z.partialRecord(productTierSchema, z.number()).optional(),
  buzzTransactionIds: z.array(z.string()).optional(),
  // New token-based prepaid system
  tokens: z.array(prepaidTokenSchema).optional(),
  cancellationReason: z.string().optional(),
});

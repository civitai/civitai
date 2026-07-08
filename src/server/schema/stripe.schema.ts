import * as z from 'zod';
import { Currency } from '~/shared/utils/prisma/enums';
import { constants } from '~/server/common/constants';
import { buzzConstants } from '~/shared/constants/buzz.constants';
import { blockAttributionSchema } from '~/server/schema/blocks/attribution.schema';

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export const createCustomerSchema = z.object({ id: z.number(), email: z.string().email() });

export type CreateSubscribeSessionInput = z.infer<typeof createSubscribeSessionSchema>;
export const createSubscribeSessionSchema = z.object({
  priceId: z.string(),
  refCode: z.string().optional(),
  // W3 flow C — App Blocks MEMBERSHIP attribution. Populated only when the
  // membership purchase was initiated from inside a block (the block's
  // "Buy membership" CTA). UNTRUSTED client input: the server re-derives
  // every field server-side (FIN-1) in createSubscribeSession before
  // stamping it onto the Stripe subscription metadata. A forged appId/scope
  // is corrected or stripped; an instance that doesn't resolve for the
  // buyer is dropped (purchase proceeds un-attributed). Never trusted to
  // mint earnings.
  blockAttribution: blockAttributionSchema.optional(),
});

export type CreateDonateSessionInput = z.infer<typeof createDonateSessionSchema>;
export const createDonateSessionSchema = z.object({ returnUrl: z.string() });

export type CreateBuzzSessionInput = z.infer<typeof createBuzzSessionSchema>;
export const createBuzzSessionSchema = z.object({
  priceId: z.string(),
  returnUrl: z.string(),
  customAmount: z.number().min(buzzConstants.minStripeChargeAmount).optional(),
});

export type BuzzPriceMetadata = z.infer<typeof buzzPriceMetadataSchema>;
export const buzzPriceMetadataSchema = z.object({
  buzzAmount: z.coerce.number().positive().optional(),
  bonusDescription: z.coerce.string().optional(),
});

const buzzPurchaseMetadataSchema = z
  .object({
    type: z.enum(['buzzPurchase']),
    buzzAmount: z.coerce.number().positive(),
    unitAmount: z.coerce.number().positive(),
    userId: z.coerce.number().positive(),
    transactionId: z.string().optional(),
    buzzType: z.enum(['green', 'yellow', 'blue', 'red']).default('yellow').optional(),
    blueBuzzGranted: z.coerce.boolean().optional(),
    cosmeticsGranted: z.coerce.boolean().optional(),
    // App Blocks attribution — populated only when the buzz purchase
    // was initiated from inside a block iframe. See
    // src/server/schema/blocks/attribution.schema.ts. The .passthrough()
    // below already lets these flow through unmodified, but listing
    // them explicitly gives downstream metadata-builders a typed shape.
    blockAppId: z.string().optional(),
    blockAppBlockId: z.string().optional(),
    blockInstanceId: z.string().optional(),
    blockScope: z.string().optional(),
    blockModelId: z.coerce.number().int().positive().optional(),
    // Slot id carried for FIN-1 server-side re-validation. Untrusted; the
    // server re-derives every block field from the resolved install row.
    blockSlotId: z.string().optional(),
  })
  .passthrough();

export type PaymentIntentMetadataSchema = z.infer<typeof paymentIntentMetadataSchema>;

export const paymentIntentMetadataSchema = z.discriminatedUnion('type', [
  buzzPurchaseMetadataSchema,
]);

export type PaymentIntentCreationSchema = z.infer<typeof paymentIntentCreationSchema>;
export const paymentIntentCreationSchema = z.object({
  unitAmount: z
    .number()
    .min(constants.buzz.minChargeAmount, {
      message: `The minimum transaction amount is $${(constants.buzz.minChargeAmount / 100).toFixed(
        2
      )} USD`,
    })
    .max(constants.buzz.maxChargeAmount, {
      message: `The maximum transaction amount is $${(constants.buzz.maxChargeAmount / 100).toFixed(
        2
      )} USD`,
    }),
  currency: z.enum(Currency),
  metadata: paymentIntentMetadataSchema,
  paymentMethodTypes: z.array(z.string()).nullish(),
  recaptchaToken: z.string(),
  setupFuturePayment: z.boolean().default(true),
});

export type GetPaymentIntentsForBuzzSchema = z.infer<typeof getPaymentIntentsForBuzzSchema>;
export const getPaymentIntentsForBuzzSchema = z.object({
  userId: z.coerce.number().optional(),
  startingAt: z.coerce.date().min(buzzConstants.cutoffDate).optional(),
  endingAt: z.coerce.date().min(buzzConstants.cutoffDate).optional(),
});

export type SetupIntentCreateSchema = z.infer<typeof setupIntentCreateSchema>;
export const setupIntentCreateSchema = z.object({
  paymentMethodTypes: z.array(z.string()).nullish(),
});

export type PaymentMethodDeleteInput = z.infer<typeof paymentMethodDeleteInput>;
export const paymentMethodDeleteInput = z.object({
  paymentMethodId: z.string(),
});

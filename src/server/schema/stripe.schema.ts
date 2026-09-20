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
    // UNTRUSTED. `getPaymentIntent` overwrites this with the currency derived from the
    // request's domain before it reaches Stripe, so whatever the client sends is inert.
    // Do not reintroduce a `.default()` here: `.optional()` after it re-admits `undefined`,
    // which made the old default never apply and hid that nothing re-derived the value.
    buzzType: z.enum(['green', 'yellow', 'blue', 'red']).optional(),
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
    // Stripe amounts are in the currency's MINOR unit and must be whole: `amount: 1000.4`
    // comes back as `Invalid integer: 1000.4`, which surfaced as a 500. A fraction arrives
    // honestly — the purchase form derives cents from the Buzz amount by dividing by 10, so
    // any Buzz amount that is not a multiple of 10 lands here — and the service-side tamper
    // guard (`unitAmount === metadata.buzzAmount / 10`) agrees with it, so nothing further
    // down the Stripe path looks at whether the number is whole.
    //
    // Scope, per SCHEMA and not per file — the distinction is load-bearing, because two of
    // these files hold more than one schema with a `unitAmount`. Carrying the same `.int()`:
    // coinbase's `createBuzzChargeSchema`, emerchantpay's `createBuzzChargeSchema` and
    // paddle's `transactionCreateSchema`. So the whole-minor-unit rule is no longer
    // Stripe-only on the ROUTE inputs. Their other bounds still differ and this route remains
    // the tightest — coinbase's declares no lower or upper bound at all, so it accepts a
    // negative or a 1e15 `unitAmount` where the `.min`/`.max` below reject both.
    //
    // 🔴 STILL UNBOUNDED, and recorded here because deleting the stale table that used to say
    // so left it written down nowhere: paddle's `buzzPurchaseMetadataSchema.unitAmount` is
    // `z.coerce.number().positive()` — no `.int()`, no `.max()` — and it is NESTED inside the
    // bounded `transactionCreateSchema`, so "paddle is covered" is true of the route input and
    // false of the metadata. `paymentIntentMetadataSchema` in THIS file has the same shape.
    // Both are inert only because the services rebuild metadata server-side
    // (`paddle.service.ts` via `getBuzzTransactionMetadata`) rather than forwarding the
    // client's. Forward it instead — a one-line refactor — and a fractional
    // `metadata.unitAmount` reaches the provider. Do not read the shared `.int()` as parity.
    //
    // No line numbers, deliberately: this repo DOES pin doc-vs-tree claims in places
    // (`no-lint-rules-script-drift.test.ts` pins literal sentences and asserts referenced
    // paths exist; `no-stale-moderator-route-probe.test.ts` pins route paths), but nothing
    // checks a `file:LINE` reference written inside a source comment — and the four that
    // stood here were falsified inside this same PR.
    .int({ message: 'The transaction amount must be a whole number of cents' })
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

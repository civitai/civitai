import type Stripe from 'stripe';
import { dbWrite } from '~/server/db/client';
import { getServerStripe } from '~/server/utils/get-server-stripe';

/**
 * Removes from Stripe what Stripe lets us remove for an account that has been deleted on
 * civitai.com, and drops our userId from purchase metadata so a Stripe record can no longer be
 * walked back to an account.
 *
 * What survives, and why this must not be described as erasure: `receipt_email` on a charge and
 * `customer_email` on an invoice are immutable — no API clears them — and are retained under the
 * GDPR Art 17(3)(b)/(e) legal/tax carve-out.
 *
 * Every write here was verified against the live API during the one-time backfill of already-
 * deleted accounts (2026-09-18); the notes below record the results that are not obvious from
 * Stripe's docs.
 */

/** Stripe keeps `address[country]`, so asking for it again on every pass would never converge. */
const clearableAddressFields = ['line1', 'line2', 'city', 'state', 'postal_code'] as const;

/**
 * Sent whole and unconditionally, without reading the customer first: the write is idempotent and
 * a read would answer a question whose answer is almost always yes.
 *
 * `shipping: ''` unsets the whole object. It must never become `shipping[name]` or
 * `shipping[phone]`: a shipping SUBFIELD without `shipping[address]` makes Stripe reject the
 * ENTIRE update, which silently wrote nothing for 400 accounts during the backfill.
 */
const customerClear: Stripe.CustomerUpdateParams = {
  email: '',
  name: '',
  phone: '',
  description: '',
  address: { line1: '', line2: '', city: '', state: '', postal_code: '', country: '' },
  shipping: '',
};

const billingDetailsClear = () => ({
  email: '',
  name: '',
  phone: '',
  address: Object.fromEntries(clearableAddressFields.map((f) => [f, ''])),
});

/** Bounds every Stripe call. The shared client sets neither, so one blip would fail a step. */
const requestOptions: Stripe.RequestOptions = { maxNetworkRetries: 2, timeout: 10_000 };

export const CUSTOMER_ID_SHAPE = /^cus_[A-Za-z0-9]+$/;

export type ScrubOutcome = {
  /** True only when every step reached a terminal state, so the caller may drop the pointer. */
  complete: boolean;
  customerGone: boolean;
  cleared: { paymentMethods: number; charges: number; paymentIntents: number };
  /** Payment methods that could not be scrubbed and were detached instead. Still hold PII. */
  blocked: { id: string; code: string | null; detached: boolean }[];
  canceledSubscriptions: string[];
  errors: { step: string; message: string }[];
};

const isStripeError = (err: unknown): err is Stripe.StripeRawError & { type?: string } =>
  !!err && typeof err === 'object' && ('type' in err || 'code' in err);

/**
 * Errors that will never succeed on a later pass. Treating one as transient means the account is
 * retried forever and never has its pointer dropped.
 *
 * Classified on `type`/`code`, never on message text: a declined card has at least three distinct
 * messages and the wording is Stripe's to change.
 */
const isCardError = (err: unknown) =>
  isStripeError(err) && (err.type === 'card_error' || err.type === 'StripeCardError');
const isMissing = (err: unknown) => isStripeError(err) && err.code === 'resource_missing';

/** `billing_details[name]` on a us_bank_account, and name AND email on sepa_debit. */
const missingParam = (err: unknown) => {
  if (!isStripeError(err) || err.code !== 'parameter_missing') return null;
  const match = /^billing_details\[(\w+)\]$/.exec(err.param ?? '');
  return match ? (match[1] as 'name' | 'email' | 'phone') : null;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Stripe caps `limit` at 100. The page cap is what stops a bad cursor spinning forever. */
async function listAll<T extends { id: string }>(
  fetchPage: (startingAfter?: string) => Promise<Stripe.ApiList<T>>
) {
  const items: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await fetchPage(startingAfter);
    items.push(...result.data);
    if (!result.has_more || !result.data.length) return items;
    startingAfter = result.data[result.data.length - 1].id;
  }
  return items;
}

const pmIsDirty = (pm: Stripe.PaymentMethod) => {
  const { email, name, phone, address } = pm.billing_details ?? {};
  return (
    !!email ||
    !!name ||
    !!phone ||
    clearableAddressFields.some((field) => !!address?.[field as keyof Stripe.Address])
  );
};

export async function scrubStripeAccount({
  userId,
  customerId,
}: {
  userId: number;
  customerId: string;
}): Promise<ScrubOutcome> {
  const outcome: ScrubOutcome = {
    complete: false,
    customerGone: false,
    cleared: { paymentMethods: 0, charges: 0, paymentIntents: 0 },
    blocked: [],
    canceledSubscriptions: [],
    errors: [],
  };

  if (!CUSTOMER_ID_SHAPE.test(customerId)) {
    // Five prod rows hold a value that is not a usable Stripe id (four with a `_MERGED` suffix,
    // one empty string). The suffix must never be stripped: the base id resolves to a customer
    // whose ownership could not be established, so scrubbing it would hit someone else's record.
    outcome.errors.push({ step: 'customerId', message: 'customerId is not a Stripe customer id' });
    return outcome;
  }

  const stripe = await getServerStripe();
  if (!stripe) {
    outcome.errors.push({ step: 'stripe', message: 'Stripe is not available' });
    return outcome;
  }

  // Subscriptions first, and read from STRIPE rather than our rows: this is what recovers a
  // deletion whose inline cancel failed, and our row is exactly what might be wrong.
  try {
    const subscriptions = await listAll<Stripe.Subscription>((startingAfter) =>
      stripe.subscriptions.list({ customer: customerId, limit: 100, starting_after: startingAfter })
    );
    for (const subscription of subscriptions) {
      if (subscription.status === 'canceled') continue;
      await stripe.subscriptions.del(subscription.id, {}, requestOptions);
      await dbWrite.customerSubscription.deleteMany({ where: { id: subscription.id } });
      outcome.canceledSubscriptions.push(subscription.id);
    }
  } catch (error) {
    if (isMissing(error)) outcome.customerGone = true;
    else outcome.errors.push({ step: 'subscriptions', message: message(error) });
  }

  try {
    await stripe.customers.update(customerId, customerClear, requestOptions);
  } catch (error) {
    // The customer is gone from Stripe. Permanent, and nothing else can be reached through it,
    // so this is a finished account rather than a failed one.
    if (isMissing(error)) outcome.customerGone = true;
    else outcome.errors.push({ step: 'customer', message: message(error) });
  }

  if (outcome.customerGone) {
    outcome.complete = outcome.errors.length === 0;
    return outcome;
  }

  try {
    // No `type` filter: omitting it returns every type, and a card filter would skip link, paypal
    // and sepa payment methods that carry billing_details too.
    const paymentMethods = await listAll<Stripe.PaymentMethod>((startingAfter) =>
      stripe.paymentMethods.list({
        customer: customerId,
        limit: 100,
        starting_after: startingAfter,
      })
    );
    for (const pm of paymentMethods) {
      if (!pmIsDirty(pm)) continue;
      await clearPaymentMethod(stripe, pm, outcome);
    }
  } catch (error) {
    outcome.errors.push({ step: 'paymentMethods', message: message(error) });
  }

  await clearMetadata(stripe, customerId, outcome);

  outcome.complete = outcome.errors.length === 0;
  return outcome;
}

/**
 * Updating `billing_details` makes Stripe RE-VALIDATE the card, so a dead card can never be
 * cleared this way, and some payment-method types refuse to clear a field they require.
 *
 * Where a field cannot be cleared we clear the rest and DETACH, which is the only action those
 * payment methods accept. Detach does NOT scrub — measured, it nulls `customer` and leaves
 * `billing_details` intact — so these are reported as blocked, never as cleared. It is worth
 * something only because we persist no route back to a payment method: there is no `pm_` column
 * in the schema.
 */
async function clearPaymentMethod(
  stripe: Stripe,
  pm: Stripe.PaymentMethod,
  outcome: ScrubOutcome
) {
  const details = billingDetailsClear() as Record<string, unknown>;

  // At most two fields can be required (sepa_debit requires name AND email), so this terminates.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await stripe.paymentMethods.update(
        pm.id,
        { billing_details: details as Stripe.PaymentMethodUpdateParams.BillingDetails },
        requestOptions
      );
      outcome.cleared.paymentMethods++;
      return;
    } catch (error) {
      const required = missingParam(error);
      if (required && required in details) {
        delete details[required];
        continue;
      }
      if (isCardError(error) || required) {
        outcome.blocked.push({
          id: pm.id,
          code: isStripeError(error) ? error.code ?? null : null,
          detached: await detach(stripe, pm.id),
        });
        return;
      }
      if (isMissing(error)) return;
      outcome.errors.push({ step: 'paymentMethod', message: message(error) });
      return;
    }
  }
  outcome.blocked.push({ id: pm.id, code: 'parameter_missing', detached: await detach(stripe, pm.id) });
}

async function detach(stripe: Stripe, paymentMethodId: string) {
  try {
    await stripe.paymentMethods.detach(paymentMethodId, {}, requestOptions);
    return true;
  } catch {
    return false;
  }
}

/**
 * `metadata.userId` is the only self-asserted link from a Stripe record back to an account. It is
 * load-bearing at purchase time (Buzz crediting, the spender-spoof guard), so it is removed only
 * from settled records: an intent that has not reached a terminal status is left for a later pass.
 */
async function clearMetadata(stripe: Stripe, customerId: string, outcome: ScrubOutcome) {
  try {
    const charges = await listAll<Stripe.Charge>((startingAfter) =>
      stripe.charges.list({ customer: customerId, limit: 100, starting_after: startingAfter })
    );
    for (const charge of charges) {
      if (!charge.metadata?.userId) continue;
      await stripe.charges.update(charge.id, { metadata: { userId: '' } }, requestOptions);
      outcome.cleared.charges++;
    }
  } catch (error) {
    outcome.errors.push({ step: 'charges', message: message(error) });
  }

  try {
    const intents = await listAll<Stripe.PaymentIntent>((startingAfter) =>
      stripe.paymentIntents.list({
        customer: customerId,
        limit: 100,
        starting_after: startingAfter,
      })
    );
    for (const intent of intents) {
      if (!intent.metadata?.userId) continue;
      if (intent.status !== 'succeeded' && intent.status !== 'canceled') continue;
      await stripe.paymentIntents.update(intent.id, { metadata: { userId: '' } }, requestOptions);
      outcome.cleared.paymentIntents++;
    }
  } catch (error) {
    outcome.errors.push({ step: 'paymentIntents', message: message(error) });
  }
}

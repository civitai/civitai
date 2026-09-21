import type Stripe from 'stripe';
import { dbWrite } from '~/server/db/client';
import { cancelSubscription } from '~/server/services/stripe.service';
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

/**
 * How long a settled payment intent keeps its userId, so a purchase webhook still being retried
 * can credit the Buzz. Past Stripe's ~3-day retry horizon, not one day: inside that horizon a
 * stripped userId makes every remaining retry fail permanently.
 *
 * `metadata.transactionId` is the fast path out of the wait — `completeStripeBuzzTransaction`
 * writes it once the Buzz is granted, so its presence means crediting is finished. Its ABSENCE
 * proves nothing (not every intent is a Buzz purchase), which is why it cannot be the gate.
 */
const CREDIT_SETTLE_MS = 4 * 24 * 60 * 60 * 1000;

export const CUSTOMER_ID_SHAPE = /^cus_[A-Za-z0-9]+$/;

export type ScrubOutcome = {
  /** True only when every step reached a terminal state, so the caller may drop the pointer. */
  complete: boolean;
  customerGone: boolean;
  cleared: { paymentMethods: number; charges: number; paymentIntents: number };
  /** Payment methods that could not be scrubbed and were detached instead. Still hold PII. */
  blocked: { id: string; code: string | null; detached: boolean }[];
  /** Work that is not failing but is not finishable yet, e.g. a payment still in flight. */
  pending: boolean;
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
  isStripeError(err) &&
  // stripe-node reports the raw `card_error` on a thrown error's `type`, and its own class name
  // on an instance; both spellings reach here.
  ((err.type as string) === 'card_error' || (err.type as string) === 'StripeCardError') &&
  // Stripe documents `processing_error` as retryable, and it arrives as a card error. Detaching on
  // it would unlink a payment method whose details a later pass could have cleared properly.
  err.code !== 'processing_error';
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
  // Returning what we have would let the account complete over records nobody enumerated. The
  // cap exists to stop a bad cursor looping; hitting it is a fact the caller has to hear.
  throw new Error('list exceeded the page cap');
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
  customerId,
}: {
  customerId: string;
}): Promise<ScrubOutcome> {
  const outcome: ScrubOutcome = {
    complete: false,
    customerGone: false,
    pending: false,
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
      stripe.subscriptions.list(
        { customer: customerId, status: 'all', limit: 100, starting_after: startingAfter },
        requestOptions
      )
    );
    for (const subscription of subscriptions) {
      // `status: 'all'` so a subscription already canceled at Stripe is seen: our row for it is
      // cleaned up by the webhook only when its buzzType is green, so the other rows would
      // otherwise sit `active` forever against an account that stopped billing long ago.
      if (subscription.status !== 'canceled') {
        try {
          // Through the service, so the cancel, the row delete and the retry/timeout options have
          // ONE definition. Passing the id read from Stripe skips the service's own lookup, which
          // is the part that could not be trusted here.
          // removeRecord deletes our row too, so nothing more is owed for this one.
          // 🔴 Deliberately WITHOUT userId, and a future review will correctly suggest adding it.
          // Read this first. Passing it runs invalidateSubscriptionCaches, whose vault step
          // re-queries active subscriptions, finds none — this call just deleted the row — and
          // throws. That is one error-level log per cancelled subscription, forever, with nothing
          // to act on, which is how an alert channel gets muted.
          // What it costs: the caches that helper busts go stale for this account. Measured, not
          // assumed: the account's SESSION is already invalidated by deleteUser, so nothing can
          // authenticate as them; the creator-membership-validity key is the only one another
          // person's read can reach, and it expires in 10 minutes (CacheTTL.md). Ten minutes of a
          // stale flag on a deleted account is worth less than a permanently noisy channel.
          await cancelSubscription({ subscriptionId: subscription.id, removeRecord: true });
          outcome.canceledSubscriptions.push(subscription.id);
          continue;
        } catch (error) {
          // A cancel of something already gone is done, not missing-customer: this catch is
          // per-subscription precisely so `resource_missing` here cannot be read as "the customer
          // does not exist" and end the whole scrub as complete.
          if (!isMissing(error)) {
            outcome.errors.push({ step: 'subscription', message: message(error) });
            continue;
          }
        }
      }
      await dbWrite.customerSubscription.deleteMany({ where: { id: subscription.id } });
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

  // A deleted customer has no payment methods to list, but its charges and payment intents
  // survive it and still carry our userId, so the metadata pass below still runs.
  if (!outcome.customerGone) await clearPaymentMethods(stripe, customerId, outcome);
  await clearMetadata(stripe, customerId, outcome);

  outcome.complete = outcome.errors.length === 0 && !outcome.pending;
  return outcome;
}

async function clearPaymentMethods(stripe: Stripe, customerId: string, outcome: ScrubOutcome) {
  try {
    // No `type` filter: omitting it returns every type, and a card filter would skip link, paypal
    // and sepa payment methods that carry billing_details too.
    const paymentMethods = await listAll<Stripe.PaymentMethod>((startingAfter) =>
      stripe.paymentMethods.list(
        { customer: customerId, limit: 100, starting_after: startingAfter },
        requestOptions
      )
    );
    for (const pm of paymentMethods) {
      if (!pmIsDirty(pm)) continue;
      await clearPaymentMethod(stripe, pm, outcome);
    }
  } catch (error) {
    outcome.errors.push({ step: 'paymentMethods', message: message(error) });
  }
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
async function clearPaymentMethod(stripe: Stripe, pm: Stripe.PaymentMethod, outcome: ScrubOutcome) {
  const details = billingDetailsClear() as Record<string, unknown>;
  const kept: string[] = [];

  // At most two fields can be required (sepa_debit requires name AND email), so this terminates.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await stripe.paymentMethods.update(
        pm.id,
        { billing_details: details as Stripe.PaymentMethodUpdateParams.BillingDetails },
        requestOptions
      );
      // A clear that had to drop a required field is not a clear: that field's value is still on
      // the record. It counts as blocked, with the rest removed, and is detached like any other
      // payment method we cannot finish — reporting it cleared would overstate the erasure.
      if (kept.length) {
        await block(stripe, pm.id, 'parameter_missing', outcome);
        return;
      }
      outcome.cleared.paymentMethods++;
      return;
    } catch (error) {
      const required = missingParam(error);
      if (required && required in details) {
        delete details[required];
        kept.push(required);
        continue;
      }
      // Gone between the list and the update: nothing left to clear.
      if (isMissing(error)) return;
      // A declined card, or a required field we cannot drop, can never be cleared. Both take the
      // detach route; left in the error bucket they would retry for the life of the account.
      if (isCardError(error) || isRequiredField(error)) {
        await block(stripe, pm.id, isStripeError(error) ? error.code ?? null : null, outcome);
        return;
      }
      outcome.errors.push({ step: 'paymentMethod', message: message(error) });
      return;
    }
  }
  // The loop bound reached. Only possible if Stripe named a third required field.
  await block(stripe, pm.id, 'parameter_missing', outcome);
}

const isRequiredField = (err: unknown) => isStripeError(err) && err.code === 'parameter_missing';

/** Records a payment method we could not scrub, and unlinks it as the nearest thing available. */
async function block(
  stripe: Stripe,
  paymentMethodId: string,
  code: string | null,
  outcome: ScrubOutcome
) {
  let detached = true;
  try {
    await stripe.paymentMethods.detach(paymentMethodId, {}, requestOptions);
  } catch (detachError) {
    // Already unlinked is unlinked. Anything else may work later, so the account stays in the
    // queue rather than being declared finished over a payment method that still holds PII.
    detached = isMissing(detachError);
    if (!detached)
      outcome.errors.push({ step: 'paymentMethod.detach', message: message(detachError) });
  }
  outcome.blocked.push({ id: paymentMethodId, code, detached });
}

/**
 * `metadata.userId` is the only self-asserted link from a Stripe record back to an account. It is
 * load-bearing at purchase time (Buzz crediting, the spender-spoof guard), so it is removed only
 * from settled records: an intent that has not reached a terminal status is left for a later pass.
 */
async function clearMetadata(stripe: Stripe, customerId: string, outcome: ScrubOutcome) {
  // When a charge settled, keyed by the intent it belongs to. An intent's own `created` is when
  // it was OPENED, and for ACH or SEPA that is days before it settles — measuring the credit
  // window from it would strip a userId while the purchase webhook was still minutes into its
  // retries. The charges are listed here anyway, so this costs nothing.
  const settledAt = new Map<string, number>();
  try {
    const charges = await listAll<Stripe.Charge>((startingAfter) =>
      stripe.charges.list(
        {
          customer: customerId,
          limit: 100,
          starting_after: startingAfter,
          // The charge's own `created` is when it was OPENED. For ACH and SEPA that is days before
          // the money settles, and `created` does not move when the status flips to succeeded. The
          // balance transaction is the object that appears at settlement.
          expand: ['data.balance_transaction'],
        },
        requestOptions
      )
    );
    for (const charge of charges) {
      const intentId =
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id;
      if (intentId && charge.status === 'succeeded') {
        const balance = charge.balance_transaction;
        // Only an EXPANDED balance transaction is a settle time. Unexpanded it is an id string,
        // and using the charge's own `created` there would be the confirmation time — days early
        // for ACH or SEPA. A missing settle time is missing, not zero: leave the entry unset and
        // let the caller hold the intent.
        if (typeof balance === 'object' && balance)
          settledAt.set(intentId, Math.max(settledAt.get(intentId) ?? 0, balance.created));
      }
      if (!charge.metadata?.userId) continue;
      await stripe.charges.update(charge.id, { metadata: { userId: '' } }, requestOptions);
      outcome.cleared.charges++;
    }
  } catch (error) {
    // A deleted customer may not be listable at all; nothing is reachable, so nothing is owed.
    if (!isMissing(error)) outcome.errors.push({ step: 'charges', message: message(error) });
  }

  try {
    const intents = await listAll<Stripe.PaymentIntent>((startingAfter) =>
      stripe.paymentIntents.list(
        { customer: customerId, limit: 100, starting_after: startingAfter },
        requestOptions
      )
    );
    for (const intent of intents) {
      if (!intent.metadata?.userId) continue;
      // Not terminal yet, or terminal so recently that our own purchase webhook may still be
      // retrying: that handler reads metadata.userId to credit the Buzz and throws without it, so
      // stripping it here would strand the payment. Left pending, which keeps the account in the
      // queue instead of finishing it with work outstanding.
      if (intent.status !== 'succeeded' && intent.status !== 'canceled') {
        // An abandoned buy-Buzz flow leaves an intent parked forever: these are created directly,
        // not through a Checkout Session, so Stripe never expires them. Cancelling is what makes
        // the account finishable — nobody is going to complete a payment for a deleted account.
        // `processing` cannot be cancelled and may still succeed. `requires_capture` is a money
        // action: cancelling it RELEASES an authorised-but-uncaptured payment. Nothing sets
        // capture_method today, so nothing reaches that status — and a cleanup job must not be
        // what discovers it if someone ever does.
        if (intent.status === 'processing' || intent.status === 'requires_capture') {
          outcome.pending = true;
          continue;
        }
        try {
          await stripe.paymentIntents.cancel(intent.id, {}, requestOptions);
        } catch (error) {
          if (!isMissing(error)) {
            outcome.errors.push({ step: 'paymentIntent.cancel', message: message(error) });
            continue;
          }
        }
      } else if (intent.status === 'succeeded' && !intent.metadata.transactionId) {
        // From the SETTLE time, not the intent's own `created`.  A `canceled` intent never had a
        // purchase webhook to strand, so it skips the wait entirely.
        const settled = settledAt.get(intent.id);
        // No settle time to read — the enumeration failed, or the balance transaction was not
        // expanded. Either way nothing here can say when the money landed, and the intent's own
        // timestamp is the wrong clock for exactly the payment types this protects.
        if (settled === undefined) {
          outcome.pending = true;
          continue;
        }
        if (settled * 1000 > Date.now() - CREDIT_SETTLE_MS) {
          outcome.pending = true;
          continue;
        }
      }
      await stripe.paymentIntents.update(intent.id, { metadata: { userId: '' } }, requestOptions);
      outcome.cleared.paymentIntents++;
    }
  } catch (error) {
    if (!isMissing(error)) outcome.errors.push({ step: 'paymentIntents', message: message(error) });
  }
}

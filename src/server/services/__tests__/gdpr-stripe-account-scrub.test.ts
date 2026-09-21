import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';

/**
 * The Stripe half of a deleted account's scrub. Each assertion stands for something measured
 * against the live API during the 2026-09-18 backfill and not obvious from the docs: shipping
 * rejects the whole update unless sent whole, a declined card can never have its billing details
 * cleared, some payment-method types refuse to drop a field they require, and detach unlinks
 * without scrubbing.
 *
 * The caller drops `User.customerId` when `complete` is true, and that pointer is the only route
 * back to these records — so every test below is really about when `complete` may be true.
 */

const { stripe, getServerStripe } = vi.hoisted(() => {
  const stripe = {
    subscriptions: { list: vi.fn(), del: vi.fn() },
    customers: { update: vi.fn() },
    paymentMethods: { list: vi.fn(), update: vi.fn(), detach: vi.fn() },
    charges: { list: vi.fn(), update: vi.fn() },
    paymentIntents: { list: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  };
  return { stripe, getServerStripe: vi.fn(async () => stripe) };
});

vi.mock('~/server/utils/get-server-stripe', () => ({ getServerStripe }));

import { scrubStripeAccount } from '~/server/services/gdpr/stripe-account-scrub';

const CUSTOMER = 'cus_live1';
const OPTIONS = { maxNetworkRetries: 2, timeout: 10_000 };
const DAY = 24 * 60 * 60 * 1000;
const secondsAgo = (ms: number) => Math.floor((Date.now() - ms) / 1000);

const page = <T>(data: T[], has_more = false) => ({ data, has_more });
const stripeError = (fields: Record<string, unknown>) => Object.assign(new Error('stripe'), fields);
const paymentMethod = (id: string, billing_details: Record<string, unknown>) => ({
  id,
  billing_details,
});

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: an unconsumed `mockRejectedValueOnce` survives clearAllMocks
  // and fires in the NEXT test, which is how three tests here first failed. resetAllMocks also
  // strips the shared mocks' registered defaults, so they are restored right after.
  vi.resetAllMocks();
  resetHybridNodes();
  getServerStripe.mockResolvedValue(stripe);
  stripe.subscriptions.list.mockResolvedValue(page([]));
  stripe.customers.update.mockResolvedValue({});
  stripe.paymentMethods.list.mockResolvedValue(page([]));
  stripe.paymentMethods.update.mockResolvedValue({});
  stripe.paymentMethods.detach.mockResolvedValue({});
  stripe.charges.list.mockResolvedValue(page([]));
  stripe.charges.update.mockResolvedValue({});
  stripe.paymentIntents.list.mockResolvedValue(page([]));
  stripe.paymentIntents.update.mockResolvedValue({});
  stripe.paymentIntents.cancel.mockResolvedValue({});
  dbMock.dbWrite.customerSubscription.deleteMany.mockResolvedValue({ count: 0 });
});

const scrub = () => scrubStripeAccount({ customerId: CUSTOMER });

describe('scrubStripeAccount — the customer object', () => {
  it('clears every PII field, and sends shipping WHOLE', async () => {
    const outcome = await scrub();

    const [id, params, options] = stripe.customers.update.mock.calls[0];
    expect(id).toBe(CUSTOMER);
    expect(params).toEqual({
      email: '',
      name: '',
      phone: '',
      description: '',
      address: { line1: '', line2: '', city: '', state: '', postal_code: '', country: '' },
      // A shipping SUBFIELD without shipping[address] makes Stripe reject the ENTIRE update,
      // which is how a 400-account run wrote nothing while reporting success. Sent whole, as a
      // string, it unsets the object.
      shipping: '',
    });
    expect(typeof params.shipping).toBe('string');
    expect(options).toEqual(OPTIONS);
    expect(outcome.complete).toBe(true);
  });

  it('is incomplete when Stripe is not configured at all', async () => {
    getServerStripe.mockResolvedValue(undefined as never);

    const outcome = await scrub();

    // Without this the job would null every pointer on its first pass in an environment with no
    // Stripe key, having scrubbed nothing, and the pointer is the only way back.
    expect(outcome.complete).toBe(false);
    expect(outcome.errors[0].step).toBe('stripe');
  });

  it('treats a customer that is gone from Stripe as finished, not failed', async () => {
    stripe.customers.update.mockRejectedValue(stripeError({ code: 'resource_missing' }));

    const outcome = await scrub();

    expect(outcome.customerGone).toBe(true);
    expect(outcome.complete).toBe(true);
    expect(stripe.paymentMethods.list).not.toHaveBeenCalled();
  });

  it('still strips metadata when the customer is gone — charges outlive it', async () => {
    stripe.customers.update.mockRejectedValue(stripeError({ code: 'resource_missing' }));
    stripe.charges.list.mockResolvedValue(page([{ id: 'ch_1', metadata: { userId: '42' } }]));

    const outcome = await scrub();

    // Deleting a customer at Stripe does not delete its charges, and metadata.userId is the link
    // this job exists to remove.
    expect(stripe.charges.update).toHaveBeenCalledTimes(1);
    expect(outcome.cleared.charges).toBe(1);
  });

  it('reports a transient customer failure as incomplete', async () => {
    stripe.customers.update.mockRejectedValue(stripeError({ type: 'api_error' }));

    const outcome = await scrub();

    expect(outcome.complete).toBe(false);
    expect(outcome.errors[0].step).toBe('customer');
  });

  it.each([['cus_NL1pYvDpkPS6fN_MERGED'], [''], ['cus_'], ['nope']])(
    'refuses the malformed customerId %s without calling Stripe',
    async (customerId) => {
      const outcome = await scrubStripeAccount({ customerId });

      // The `_MERGED` suffix must never be stripped: the base id resolves to a customer whose
      // ownership could not be established, so scrubbing it would hit someone else's record.
      expect(stripe.customers.update).not.toHaveBeenCalled();
      expect(outcome.complete).toBe(false);
    }
  );
});

describe('scrubStripeAccount — payment methods', () => {
  it('clears billing details, leaving address country alone', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_1', { email: 'a@b.c', address: { postal_code: '90210' } })])
    );

    const outcome = await scrub();

    const [id, params] = stripe.paymentMethods.update.mock.calls[0];
    expect(id).toBe('pm_1');
    expect(params.billing_details).toEqual({
      email: '',
      name: '',
      phone: '',
      address: { line1: '', line2: '', city: '', state: '', postal_code: '' },
    });
    // Stripe keeps country. Asking for it would report the same pending change on every pass.
    expect(params.billing_details.address).not.toHaveProperty('country');
    expect(outcome.cleared.paymentMethods).toBe(1);
    expect(outcome.blocked).toEqual([]);
  });

  it('skips a payment method that is already clean', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_clean', { address: { country: 'US' } })])
    );

    await scrub();

    expect(stripe.paymentMethods.update).not.toHaveBeenCalled();
  });

  it('detaches a declined card and reports it blocked, never cleared', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_dead', { email: 'a@b.c' })])
    );
    stripe.paymentMethods.update.mockRejectedValue(
      // Classified on type/code. The wording is Stripe's to change and has at least three forms,
      // one of which reads nothing like a decline.
      stripeError({ type: 'card_error', code: 'card_declined', message: 'Your card was declined' })
    );

    const outcome = await scrub();

    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith('pm_dead', {}, OPTIONS);
    // Detach only unlinks; this payment method still holds billing PII.
    expect(outcome.blocked).toEqual([{ id: 'pm_dead', code: 'card_declined', detached: true }]);
    expect(outcome.cleared.paymentMethods).toBe(0);
    expect(outcome.complete).toBe(true);
  });

  it('retries a processing_error later instead of detaching it', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_busy', { email: 'a@b.c' })])
    );
    stripe.paymentMethods.update.mockRejectedValue(
      stripeError({ type: 'card_error', code: 'processing_error' })
    );

    const outcome = await scrub();

    // Stripe documents this one as retryable, so detaching would unlink a payment method a later
    // pass could have cleared properly.
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
    expect(outcome.complete).toBe(false);
  });

  it('needs nothing from a payment method that vanished mid-run', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_gone', { email: 'a@b.c' })])
    );
    stripe.paymentMethods.update.mockRejectedValue(stripeError({ code: 'resource_missing' }));

    const outcome = await scrub();

    expect(outcome.complete).toBe(true);
    expect(outcome.blocked).toEqual([]);
    expect(outcome.cleared.paymentMethods).toBe(0);
  });

  it('retries without the field a payment-method type requires', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_bank', { email: 'a@b.c', name: 'A B' })])
    );
    stripe.paymentMethods.update
      .mockRejectedValueOnce(
        stripeError({ code: 'parameter_missing', param: 'billing_details[name]' })
      )
      .mockResolvedValueOnce({});

    const outcome = await scrub();

    const second = stripe.paymentMethods.update.mock.calls[1][1].billing_details;
    expect(second).not.toHaveProperty('name');
    expect(second.email).toBe('');
    expect(outcome.cleared.paymentMethods).toBe(1);
    expect(stripe.paymentMethods.detach).not.toHaveBeenCalled();
  });

  it('stops at the attempt bound when every field is required in turn', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_sepa', { email: 'a@b.c', name: 'A B' })])
    );
    // Would go forever if the loop were unbounded: each attempt names another required field, so
    // the in-loop exit is never reached and only the bound stops it.
    const required = ['name', 'email', 'phone', 'name', 'email'];
    let call = 0;
    stripe.paymentMethods.update.mockImplementation(async () => {
      throw stripeError({
        code: 'parameter_missing',
        param: `billing_details[${required[call++ % required.length]}]`,
      });
    });

    const outcome = await scrub();

    expect(stripe.paymentMethods.update).toHaveBeenCalledTimes(3);
    expect(outcome.blocked[0]).toMatchObject({ id: 'pm_sepa', detached: true });
    expect(outcome.cleared.paymentMethods).toBe(0);
  });

  it('detaches on a required field it cannot name, rather than retrying forever', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_odd', { email: 'a@b.c' })])
    );
    stripe.paymentMethods.update.mockRejectedValue(
      stripeError({ code: 'parameter_missing', param: 'something_else' })
    );

    const outcome = await scrub();

    expect(stripe.paymentMethods.update).toHaveBeenCalledTimes(1);
    expect(outcome.blocked[0]).toMatchObject({ id: 'pm_odd', detached: true });
    expect(outcome.complete).toBe(true);
  });

  it('stays incomplete when a blocked payment method cannot even be detached', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_stuck', { email: 'a@b.c' })])
    );
    stripe.paymentMethods.update.mockRejectedValue(stripeError({ type: 'card_error' }));
    stripe.paymentMethods.detach.mockRejectedValue(stripeError({ type: 'api_error' }));

    const outcome = await scrub();

    // Still attached, still holding billing PII: finishing here would drop the pointer over it.
    expect(outcome.blocked[0]).toMatchObject({ id: 'pm_stuck', detached: false });
    expect(outcome.complete).toBe(false);
  });

  it('pages through payment methods and stops at the page cap', async () => {
    let calls = 0;
    stripe.paymentMethods.list.mockImplementation(async () => {
      calls++;
      // Would never end on its own — the cap is the only thing that stops it — but hard-stops far
      // past the bound so an unbounded loop FAILS in a second instead of hanging the runner.
      if (calls > 150) return page([]);
      return page([paymentMethod(`pm_${calls}`, {})], true);
    });

    await scrub();

    expect(calls).toBe(100);
    expect(stripe.paymentMethods.list.mock.calls[1][0].starting_after).toBe('pm_1');
  });
});

describe('scrubStripeAccount — metadata and subscriptions', () => {
  it('removes metadata.userId from charges and long-settled intents', async () => {
    stripe.charges.list.mockResolvedValue(page([{ id: 'ch_1', metadata: { userId: '42' } }]));
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_1',
          status: 'succeeded',
          created: secondsAgo(5 * DAY),
          metadata: { userId: '42' },
        },
      ])
    );

    const outcome = await scrub();

    expect(stripe.charges.update).toHaveBeenCalledWith(
      'ch_1',
      { metadata: { userId: '' } },
      OPTIONS
    );
    expect(stripe.charges.update).toHaveBeenCalledTimes(1);
    expect(stripe.paymentIntents.update).toHaveBeenCalledWith(
      'pi_1',
      { metadata: { userId: '' } },
      OPTIONS
    );
    expect(outcome.cleared).toMatchObject({ charges: 1, paymentIntents: 1 });
    expect(outcome.complete).toBe(true);
  });

  it('cancels an abandoned intent, then strips it, so the account can finish', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_abandoned',
          status: 'requires_payment_method',
          created: secondsAgo(5 * DAY),
          metadata: { userId: '42' },
        },
      ])
    );

    const outcome = await scrub();

    // Buy-Buzz intents are created directly, not through a Checkout Session, so Stripe never
    // expires them: an abandoned one would keep this account in the queue forever. Nobody is
    // going to finish paying for a deleted account.
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith('pi_abandoned', {}, OPTIONS);
    expect(stripe.paymentIntents.update).toHaveBeenCalledTimes(1);
    expect(outcome.complete).toBe(true);
  });

  it('never cancels an authorised-but-uncaptured payment', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_auth',
          status: 'requires_capture',
          created: secondsAgo(5 * DAY),
          metadata: { userId: '42' },
        },
      ])
    );

    const outcome = await scrub();

    // Cancelling this RELEASES the authorisation — a money action. Unreachable today (nothing
    // sets capture_method), and a cleanup job must not be what finds out if that changes.
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.update).not.toHaveBeenCalled();
    expect(outcome.pending).toBe(true);
  });

  it('waits on an intent that is genuinely in flight', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_processing',
          status: 'processing',
          created: secondsAgo(5 * DAY),
          metadata: { userId: '42' },
        },
      ])
    );

    const outcome = await scrub();

    // `processing` cannot be cancelled and may still succeed, so the money question is open.
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stripe.paymentIntents.update).not.toHaveBeenCalled();
    expect(outcome.pending).toBe(true);
    expect(outcome.complete).toBe(false);
    expect(outcome.errors).toEqual([]);
  });

  it('holds a recently settled intent, because the credit webhook may still be retrying', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_fresh',
          status: 'succeeded',
          created: secondsAgo(60_000),
          metadata: { userId: '42' },
        },
      ])
    );

    const outcome = await scrub();

    // The Buzz-crediting webhook reads metadata.userId and throws without it. Stripe retries a
    // failing endpoint for about three days, so stripping it early strands a real payment.
    expect(stripe.paymentIntents.update).not.toHaveBeenCalled();
    expect(outcome.pending).toBe(true);
    expect(outcome.complete).toBe(false);
  });

  it('strips a recently settled intent once the credit is recorded', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_credited',
          status: 'succeeded',
          created: secondsAgo(60_000),
          metadata: { userId: '42', transactionId: 'tx_1' },
        },
      ])
    );

    const outcome = await scrub();

    // transactionId is written when the Buzz is granted, so there is nothing left to retry. Its
    // absence proves nothing — not every intent is a Buzz purchase — which is why the wait above
    // is the default and this is only a fast path out of it.
    expect(stripe.paymentIntents.update).toHaveBeenCalledTimes(1);
    expect(outcome.complete).toBe(true);
  });

  it('cancels a live subscription at Stripe and drops our row', async () => {
    stripe.subscriptions.list.mockResolvedValue(
      page([
        { id: 'sub_live', status: 'active' },
        { id: 'sub_old', status: 'canceled' },
      ])
    );

    const outcome = await scrub();

    // Read from Stripe, not from our rows: this is what recovers a deletion whose inline cancel
    // failed, and our row is exactly the thing that might be wrong.
    expect(stripe.subscriptions.list.mock.calls[0][0].status).toBe('all');
    expect(stripe.subscriptions.del).toHaveBeenCalledWith('sub_live', {}, OPTIONS);
    expect(stripe.subscriptions.del).toHaveBeenCalledTimes(1);
    // Both rows go: a subscription already canceled at Stripe still leaves our row behind unless
    // its buzzType is green, because only green is cleaned up by the webhook.
    expect(dbMock.dbWrite.customerSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: 'sub_live' },
    });
    expect(dbMock.dbWrite.customerSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: 'sub_old' },
    });
    expect(outcome.canceledSubscriptions).toEqual(['sub_live']);
  });

  it('does not read a missing SUBSCRIPTION as a missing customer', async () => {
    stripe.subscriptions.list.mockResolvedValue(page([{ id: 'sub_gone', status: 'active' }]));
    stripe.subscriptions.del.mockRejectedValue(stripeError({ code: 'resource_missing' }));

    const outcome = await scrub();

    // Cancelled already — by deleteUser, by Stripe, or by an earlier run. Reading it as "customer
    // gone" would end the scrub as complete with the customer, payment methods and metadata
    // untouched, and drop the only pointer back to them.
    expect(outcome.customerGone).toBe(false);
    expect(stripe.customers.update).toHaveBeenCalled();
    expect(dbMock.dbWrite.customerSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: 'sub_gone' },
    });
  });

  it('keeps our row when a LIVE subscription fails to cancel', async () => {
    stripe.subscriptions.list.mockResolvedValue(page([{ id: 'sub_live', status: 'active' }]));
    stripe.subscriptions.del.mockRejectedValue(stripeError({ type: 'api_error' }));

    const outcome = await scrub();

    // Deleting the row here would stop us reconciling a subscription that is still billing.
    expect(dbMock.dbWrite.customerSubscription.deleteMany).not.toHaveBeenCalled();
    expect(outcome.errors[0].step).toBe('subscription');
    expect(outcome.complete).toBe(false);
  });

  it.each([
    ['subscriptions', () => stripe.subscriptions.list],
    ['paymentMethods', () => stripe.paymentMethods.list],
    ['charges', () => stripe.charges.list],
    ['paymentIntents', () => stripe.paymentIntents.list],
  ])('is incomplete when the %s list cannot be read', async (step, list) => {
    list().mockRejectedValue(stripeError({ type: 'api_error' }));

    const outcome = await scrub();

    // Nothing was enumerated, so nothing can be claimed scrubbed — and the pointer is what the
    // next pass needs to try again.
    expect(outcome.complete).toBe(false);
    expect(outcome.errors.map((e) => e.step)).toContain(step);
  });

  it('clears a payment intent once it is older than the credit window', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_day_old',
          status: 'succeeded',
          created: secondsAgo(5 * DAY),
          metadata: { userId: '42' },
        },
      ])
    );

    const outcome = await scrub();

    // No charge accompanies this intent, so there is no settle time to read: this is the fallback
    // to the intent's own `created`. The window itself is bracketed by the 3.5/4.5-day pair above.
    expect(stripe.paymentIntents.update).toHaveBeenCalledTimes(1);
    expect(outcome.complete).toBe(true);
  });

  it('never strips an intent whose cancel failed', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_abandoned',
          status: 'requires_payment_method',
          created: secondsAgo(5 * DAY),
          metadata: { userId: '42' },
        },
      ])
    );
    stripe.paymentIntents.cancel.mockRejectedValue(stripeError({ type: 'api_error' }));

    const outcome = await scrub();

    // Falling through here would strip the userId off a LIVE intent — the link the crediting
    // webhook reads — and then finish the account over it.
    expect(stripe.paymentIntents.update).not.toHaveBeenCalled();
    expect(outcome.errors[0].step).toBe('paymentIntent.cancel');
    expect(outcome.complete).toBe(false);
  });

  it.each([
    ['3.5 days after settling, inside the webhook retry horizon', 3.5, false],
    ['4.5 days after settling', 4.5, true],
  ])('%s', async (_, days, stripped) => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        {
          id: 'pi_x',
          status: 'succeeded',
          created: secondsAgo(30 * DAY),
          metadata: { userId: '42' },
        },
      ])
    );
    // The SETTLE time, from the charge — an intent's own `created` is when it was opened, and for
    // ACH that is days earlier, which would strip the link while the webhook was still retrying.
    stripe.charges.list.mockResolvedValue(
      page([
        {
          id: 'ch_x',
          payment_intent: 'pi_x',
          status: 'succeeded',
          created: secondsAgo(days * DAY),
          metadata: {},
        },
      ])
    );

    const outcome = await scrub();

    expect(stripe.paymentIntents.update).toHaveBeenCalledTimes(stripped ? 1 : 0);
    expect(outcome.complete).toBe(stripped);
  });

  it('strips a canceled intent immediately — no webhook was ever owed', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([
        { id: 'pi_c', status: 'canceled', created: secondsAgo(60_000), metadata: { userId: '42' } },
      ])
    );

    const outcome = await scrub();

    expect(stripe.paymentIntents.update).toHaveBeenCalledTimes(1);
    expect(outcome.complete).toBe(true);
  });

  it.each([
    ['charges', () => stripe.charges.list],
    ['paymentIntents', () => stripe.paymentIntents.list],
  ])('treats a missing %s list as nothing to do, not a failure', async (_, list) => {
    list().mockRejectedValue(stripeError({ code: 'resource_missing' }));

    const outcome = await scrub();

    // Nothing is reachable through a customer that does not exist, so the account is finished.
    expect(outcome.complete).toBe(true);
    expect(outcome.errors).toEqual([]);
  });

  it('refuses to finish an account whose list never ended', async () => {
    let calls = 0;
    stripe.charges.list.mockImplementation(async () => {
      calls++;
      if (calls > 150) return page([]);
      return page([{ id: `ch_${calls}`, metadata: {} }], true);
    });

    const outcome = await scrub();

    // Returning the first 10,000 quietly would let the account complete over records nobody
    // enumerated.
    expect(calls).toBe(100);
    expect(outcome.complete).toBe(false);
    expect(outcome.errors[0].step).toBe('charges');
  });

  it('is incomplete when a metadata write fails', async () => {
    stripe.charges.list.mockResolvedValue(page([{ id: 'ch_1', metadata: { userId: '42' } }]));
    stripe.charges.update.mockRejectedValue(stripeError({ type: 'api_error' }));

    const outcome = await scrub();

    expect(outcome.complete).toBe(false);
  });
});

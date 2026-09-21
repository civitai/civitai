import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The Stripe half of a deleted account's scrub. Every assertion below stands for something that
 * was measured against the live API during the 2026-09-18 backfill and is not obvious from the
 * docs: shipping rejects the whole update unless it is sent whole, a declined card can never have
 * its billing details cleared, some payment-method types refuse to drop a field they require, and
 * detach unlinks without scrubbing.
 */

const stripe = vi.hoisted(() => ({
  subscriptions: { list: vi.fn(), del: vi.fn() },
  customers: { update: vi.fn() },
  paymentMethods: { list: vi.fn(), update: vi.fn(), detach: vi.fn() },
  charges: { list: vi.fn(), update: vi.fn() },
  paymentIntents: { list: vi.fn(), update: vi.fn() },
}));

vi.mock('~/server/utils/get-server-stripe', () => ({ getServerStripe: async () => stripe }));

import { scrubStripeAccount } from '~/server/services/gdpr/stripe-account-scrub';

const USER_ID = 42;
const CUSTOMER = 'cus_live1';

const page = <T>(data: T[], has_more = false) => ({ data, has_more });
const stripeError = (fields: Record<string, unknown>) => Object.assign(new Error('stripe'), fields);

const paymentMethod = (id: string, billing_details: Record<string, unknown>) => ({
  id,
  billing_details,
});

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: a `mockRejectedValueOnce` left unconsumed by one test
  // survives clearAllMocks and fires in the next one, which is how three tests here first failed.
  vi.resetAllMocks();
  stripe.subscriptions.list.mockResolvedValue(page([]));
  stripe.customers.update.mockResolvedValue({});
  stripe.paymentMethods.list.mockResolvedValue(page([]));
  stripe.paymentMethods.update.mockResolvedValue({});
  stripe.paymentMethods.detach.mockResolvedValue({});
  stripe.charges.list.mockResolvedValue(page([]));
  stripe.charges.update.mockResolvedValue({});
  stripe.paymentIntents.list.mockResolvedValue(page([]));
  stripe.paymentIntents.update.mockResolvedValue({});
  dbMock.dbWrite.customerSubscription.deleteMany.mockResolvedValue({ count: 0 });
});

const scrub = () => scrubStripeAccount({ userId: USER_ID, customerId: CUSTOMER });

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
      shipping: '',
    });
    // A shipping SUBFIELD without shipping[address] makes Stripe reject the ENTIRE update, which
    // is how a 400-account run wrote nothing while reporting success.
    expect(Object.keys(params).filter((k) => k.startsWith('shipping['))).toEqual([]);
    expect(options).toEqual({ maxNetworkRetries: 2, timeout: 10_000 });
    expect(outcome.complete).toBe(true);
  });

  it('treats a customer that is gone from Stripe as finished, not failed', async () => {
    stripe.customers.update.mockRejectedValue(stripeError({ code: 'resource_missing' }));

    const outcome = await scrub();

    expect(outcome.customerGone).toBe(true);
    expect(outcome.complete).toBe(true);
    // Nothing else is reachable through a customer that does not exist.
    expect(stripe.paymentMethods.list).not.toHaveBeenCalled();
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
      const outcome = await scrubStripeAccount({ userId: USER_ID, customerId });

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
      // Classified on type/code. The message wording is Stripe's to change and has at least three
      // forms, including one that reads nothing like a decline.
      stripeError({ type: 'card_error', code: 'card_declined', message: 'Your card was declined' })
    );

    const outcome = await scrub();

    expect(stripe.paymentMethods.detach).toHaveBeenCalledWith(
      'pm_dead',
      {},
      { maxNetworkRetries: 2, timeout: 10_000 }
    );
    // Detach only unlinks; this payment method still holds billing PII.
    expect(outcome.blocked).toEqual([{ id: 'pm_dead', code: 'card_declined', detached: true }]);
    expect(outcome.cleared.paymentMethods).toBe(0);
    expect(outcome.complete).toBe(true);
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

  it('gives up and detaches when two fields are required, as SEPA does', async () => {
    stripe.paymentMethods.list.mockResolvedValue(
      page([paymentMethod('pm_sepa', { email: 'a@b.c', name: 'A B' })])
    );
    stripe.paymentMethods.update
      .mockRejectedValueOnce(
        stripeError({ code: 'parameter_missing', param: 'billing_details[name]' })
      )
      .mockRejectedValueOnce(
        stripeError({ code: 'parameter_missing', param: 'billing_details[email]' })
      )
      .mockRejectedValueOnce(
        stripeError({ code: 'parameter_missing', param: 'billing_details[name]' })
      );

    const outcome = await scrub();

    // Bounded: at most one attempt per clearable field, so a stubborn payment method cannot loop.
    expect(stripe.paymentMethods.update.mock.calls.length).toBeLessThanOrEqual(3);
    expect(outcome.blocked[0]).toMatchObject({ id: 'pm_sepa', detached: true });
    expect(outcome.cleared.paymentMethods).toBe(0);
  });

  it('pages through payment methods and stops at the end', async () => {
    let calls = 0;
    stripe.paymentMethods.list.mockImplementation(async () => {
      calls++;
      // Terminates on its own: a fake that never ends would hang the runner rather than fail,
      // and vitest's timeout cannot fire inside a pure microtask loop.
      if (calls > 3) return page([]);
      return page([paymentMethod(`pm_${calls}`, { email: 'a@b.c' })], calls < 2);
    });

    const outcome = await scrub();

    expect(calls).toBeLessThan(5);
    expect(outcome.cleared.paymentMethods).toBe(2);
    expect(stripe.paymentMethods.list.mock.calls[1][0].starting_after).toBe('pm_1');
  });
});

describe('scrubStripeAccount — metadata and subscriptions', () => {
  it('removes metadata.userId from charges and settled intents', async () => {
    stripe.charges.list.mockResolvedValue(page([{ id: 'ch_1', metadata: { userId: '42' } }]));
    stripe.paymentIntents.list.mockResolvedValue(
      page([{ id: 'pi_1', status: 'succeeded', metadata: { userId: '42' } }])
    );

    const outcome = await scrub();

    expect(stripe.charges.update).toHaveBeenCalledWith(
      'ch_1',
      { metadata: { userId: '' } },
      { maxNetworkRetries: 2, timeout: 10_000 }
    );
    expect(stripe.paymentIntents.update).toHaveBeenCalledWith(
      'pi_1',
      { metadata: { userId: '' } },
      { maxNetworkRetries: 2, timeout: 10_000 }
    );
    expect(outcome.cleared).toMatchObject({ charges: 1, paymentIntents: 1 });
  });

  it('leaves an in-flight payment intent for a later pass', async () => {
    stripe.paymentIntents.list.mockResolvedValue(
      page([{ id: 'pi_open', status: 'requires_payment_method', metadata: { userId: '42' } }])
    );

    await scrub();

    // userId is load-bearing at purchase time: Buzz crediting and the spender-spoof guard read it.
    expect(stripe.paymentIntents.update).not.toHaveBeenCalled();
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
    expect(stripe.subscriptions.del).toHaveBeenCalledWith(
      'sub_live',
      {},
      { maxNetworkRetries: 2, timeout: 10_000 }
    );
    expect(stripe.subscriptions.del).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.customerSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: 'sub_live' },
    });
    expect(outcome.canceledSubscriptions).toEqual(['sub_live']);
  });

  it('is incomplete when a metadata write fails', async () => {
    stripe.charges.list.mockResolvedValue(page([{ id: 'ch_1', metadata: { userId: '42' } }]));
    stripe.charges.update.mockRejectedValue(stripeError({ type: 'api_error' }));

    const outcome = await scrub();

    expect(outcome.complete).toBe(false);
  });
});

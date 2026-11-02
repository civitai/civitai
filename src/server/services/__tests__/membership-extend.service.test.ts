import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stripe } from 'stripe';
import { dbMock, loggingMock, redisMock, resetSharedMocks, setEnv } from '~/__tests__/mocks';

/**
 * A moderator gives a Stripe member N free days (membership-extend.service). Money and auth, so:
 * every guard has a test that a passing base goes red when that one guard is broken; the stale
 * preview (compare-and-swap) and a test-mode key each refuse with nothing written; and the audit
 * holds ids, dates, states and the reason only.
 */

const { trackModActivity, refreshSession, invalidateSubscriptionCaches, delIfValue, stripeRef } =
  vi.hoisted(() => ({
    trackModActivity: vi.fn(async () => undefined),
    refreshSession: vi.fn(async () => undefined),
    invalidateSubscriptionCaches: vi.fn(async () => undefined),
    delIfValue: vi.fn(async () => 1),
    stripeRef: { current: null as unknown },
  }));

vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.mock('~/server/auth/session-invalidation', () => ({ refreshSession }));
vi.mock('~/server/utils/subscription.utils', () => ({ invalidateSubscriptionCaches }));
vi.mock('~/server/redis/atomic', () => ({ delIfValue }));
vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: async () => stripeRef.current,
}));

import {
  checkExtension,
  extendMembership,
  previewMembershipExtension,
  updateParams,
  verifyExtension,
  type ExtensionGuardInput,
} from '~/server/services/membership-extend.service';

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 10, 3, 12, 0) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 10, 22, 2, 22) / 1000);
const T3 = PERIOD_END + 3 * DAY; // 2026-11-25T02:22Z
const USER = 10495685;
const MOD = 5;
const SUB_ID = 'sub_case';

const paidInvoice = { id: 'in_oct', object: 'invoice', amount_due: 5000, amount_paid: 5000 };

function liveSub(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: SUB_ID,
    object: 'subscription',
    livemode: true,
    status: 'active',
    customer: 'cus_case',
    current_period_end: PERIOD_END,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    discount: null,
    metadata: {},
    latest_invoice: paidInvoice,
    ...over,
  } as unknown as Stripe.Subscription;
}
const customer = {
  id: 'cus_case',
  object: 'customer',
  metadata: { userId: String(USER) },
} as unknown as Stripe.Customer;

const base = (over: Partial<ExtensionGuardInput> = {}): ExtensionGuardInput => ({
  userId: USER,
  days: 3,
  now: NOW,
  row: { id: SUB_ID, provider: 'Stripe', userCustomerId: 'cus_case' },
  sub: liveSub(),
  customer,
  recentExtensions: 0,
  ...over,
});
const problemsOf = (over: Partial<ExtensionGuardInput>) =>
  checkExtension(base(over)).problems.join('; ');
const withSub = (over: Partial<Record<string, unknown>>) => problemsOf({ sub: liveSub(over) });

describe('checkExtension: the passing base, then each guard broken on its own', () => {
  it('base: renewing member, 3 days -> 2026-11-25T02:22Z, no problems', () => {
    expect(checkExtension(base())).toEqual({ problems: [], trialEnd: T3, mode: 'renewing' });
  });
  it('base: a cancelling member keeps cancelling', () => {
    expect(
      checkExtension(base({ sub: liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END }) }))
    ).toEqual({
      problems: [],
      trialEnd: T3,
      mode: 'cancelling',
    });
    expect(checkExtension(base({ sub: liveSub({ cancel_at_period_end: true }) })).mode).toBe(
      'cancelling'
    );
  });
  it('days: 1 and 31 pass; 0, 32 and 1.5 refuse', () => {
    expect(problemsOf({ days: 1 })).toBe('');
    expect(problemsOf({ days: 31 })).toBe('');
    for (const days of [0, 32, 1.5]) expect(problemsOf({ days })).toMatch(/days must be/);
  });
  it('cooldown: an extension in the last 25 days refuses', () => {
    expect(problemsOf({ recentExtensions: 1 })).toMatch(/already extended in the last 25 days/);
  });
  it('no subscription row, or not Stripe, or Stripe has none', () => {
    expect(problemsOf({ row: null })).toMatch(/no green membership subscription/);
    expect(
      problemsOf({ row: { id: SUB_ID, provider: 'Paddle', userCustomerId: 'cus_case' }, sub: null })
    ).toMatch(/billed by Paddle/);
    expect(
      problemsOf({ row: { id: SUB_ID, provider: 'Paddle', userCustomerId: 'cus_case' }, sub: null })
    ).not.toMatch(/Stripe has no such/);
    expect(problemsOf({ sub: null })).toMatch(/Stripe has no such subscription/);
  });
  it('Stripe returned another subscription', () => {
    expect(withSub({ id: 'sub_other' })).toMatch(/Stripe returned sub_other/);
  });
  it.each(['past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'])(
    'status %s refuses (active/trialing only)',
    (status) => expect(withSub({ status })).toMatch(/not active or trialing/)
  );
  it('a trialing sub whose trial is over passes', () => {
    expect(withSub({ status: 'trialing', trial_end: NOW - DAY })).toBe('');
  });
  it("the subscription's customer is not the user's", () => {
    expect(
      problemsOf({ row: { id: SUB_ID, provider: 'Stripe', userCustomerId: 'cus_other' } })
    ).toMatch(/not this user's Stripe customer/);
    expect(problemsOf({ row: { id: SUB_ID, provider: 'Stripe', userCustomerId: null } })).toMatch(
      /not this user's Stripe customer/
    );
  });
  it('customer missing, deleted, or stamped for another user; the sub stamped for another user', () => {
    expect(problemsOf({ customer: null })).toMatch(/customer was not found/);
    expect(
      problemsOf({ customer: { id: 'cus_case', deleted: true } as Stripe.DeletedCustomer })
    ).toMatch(/is deleted/);
    expect(
      problemsOf({ customer: { ...customer, metadata: { userId: '42' } } as Stripe.Customer })
    ).toMatch(/metadata.userId is another user/);
    expect(problemsOf({ customer: { ...customer, metadata: {} } as Stripe.Customer })).toBe('');
    expect(withSub({ metadata: { userId: '42' } })).toMatch(/subscription's metadata.userId/);
  });
  it('a schedule refuses', () => {
    expect(withSub({ schedule: 'sub_sched_1' })).toMatch(/on a schedule/);
  });
  it('a live trial refuses (no stacking)', () => {
    expect(withSub({ status: 'trialing', trial_end: NOW + DAY })).toMatch(
      /already in a trial until/
    );
  });
  it('a discount (an armed gift month) refuses', () => {
    expect(withSub({ discount: { coupon: { id: 'gift_x_m1' } } })).toMatch(/carries a discount/);
  });
  it('a custom cancel date refuses: cancel_at without cancel_at_period_end, or off the period end', () => {
    expect(withSub({ cancel_at: PERIOD_END + DAY })).toMatch(/custom cancel date/);
    expect(withSub({ cancel_at_period_end: true, cancel_at: PERIOD_END - DAY })).toMatch(
      /custom cancel date/
    );
  });
  it('no current_period_end refuses', () => {
    expect(withSub({ current_period_end: null })).toMatch(/no current_period_end/);
  });
});

describe('the update and its post-check', () => {
  it('one update: trial_end, no proration, the cancel state as it was, the audit stamp', () => {
    expect(updateParams({ trialEnd: T3, mode: 'renewing', stamp: 's' })).toEqual({
      trial_end: T3,
      proration_behavior: 'none',
      cancel_at_period_end: false,
      metadata: { modExtension: 's' },
    });
    expect(
      updateParams({ trialEnd: T3, mode: 'cancelling', stamp: 's' }).cancel_at_period_end
    ).toBe(true);
  });

  const extended = (over: Partial<Record<string, unknown>> = {}) =>
    liveSub({ status: 'trialing', trial_end: T3, current_period_end: T3, ...over });
  const v = (
    mode: 'renewing' | 'cancelling',
    over: Partial<Record<string, unknown>> = {},
    before = liveSub()
  ) => verifyExtension({ before, after: extended(over), trialEnd: T3, mode }).problems.join('; ');

  it('passes when the trial reaches the target and the cancel state held', () => {
    expect(v('renewing')).toBe('');
    expect(v('cancelling', { cancel_at_period_end: true, cancel_at: T3 })).toBe('');
    expect(v('cancelling', { cancel_at_period_end: true, cancel_at: null })).toBe('');
  });
  it('fails on the wrong end, status, or cancel state', () => {
    expect(v('renewing', { trial_end: T3 - 1 })).toMatch(/trial_end is/);
    expect(v('renewing', { current_period_end: PERIOD_END })).toMatch(/current_period_end is/);
    expect(v('renewing', { status: 'active' })).toMatch(/status is active/);
    expect(v('renewing', { cancel_at_period_end: true })).toMatch(/turned on/);
    expect(v('renewing', { cancel_at: T3 })).toMatch(/expected none/);
    expect(v('cancelling', { cancel_at_period_end: false })).toMatch(/was lost/);
    expect(v('cancelling', { cancel_at_period_end: true, cancel_at: PERIOD_END })).toMatch(
      /cancel_at is 2026-11-22/
    );
  });
  it('a new $0 invoice passes; one with money due or paid, or unexpanded, fails', () => {
    const zero = { id: 'in_zero', amount_due: 0, amount_paid: 0 };
    expect(
      verifyExtension({
        before: liveSub(),
        after: extended({ latest_invoice: zero }),
        trialEnd: T3,
        mode: 'renewing',
      })
    ).toEqual({
      problems: [],
      newInvoiceId: 'in_zero',
    });
    expect(
      v('renewing', { latest_invoice: { id: 'in_due', amount_due: 5000, amount_paid: 0 } })
    ).toMatch(/money due or paid/);
    expect(
      v('renewing', { latest_invoice: { id: 'in_paid', amount_due: 0, amount_paid: 5000 } })
    ).toMatch(/money due or paid/);
    expect(v('renewing', { latest_invoice: 'in_str' })).toMatch(/not expanded/);
  });
});

/** Stripe for the flow: trial_end moves the period; options misbehave the ways the code must catch. */
function fakeStripe(
  sub: Stripe.Subscription,
  opts: { dropCancel?: boolean; invoiceOnUpdate?: unknown; failRetrieveAfterWrite?: boolean } = {}
) {
  const state = { sub: structuredClone(sub) as unknown as Record<string, unknown> };
  const updates: [string, Record<string, unknown>, unknown][] = [];
  const stripe = {
    subscriptions: {
      retrieve: vi.fn(async (id: string) => {
        if (opts.failRetrieveAfterWrite && updates.length) throw new Error('stripe 503');
        return id === state.sub.id
          ? structuredClone(state.sub)
          : Promise.reject(Object.assign(new Error('nf'), { statusCode: 404 }));
      }),
      update: vi.fn(async (id: string, params: Record<string, unknown>, options: unknown) => {
        updates.push([id, params, options]);
        const s = state.sub;
        if ('trial_end' in params) {
          s.trial_end = params.trial_end;
          s.current_period_end = params.trial_end;
          s.status = 'trialing';
          if (opts.invoiceOnUpdate) s.latest_invoice = opts.invoiceOnUpdate;
        }
        if ('cancel_at_period_end' in params && !(opts.dropCancel && 'trial_end' in params)) {
          s.cancel_at_period_end = params.cancel_at_period_end;
          s.cancel_at = params.cancel_at_period_end ? s.current_period_end : null;
        }
        if (opts.dropCancel && 'trial_end' in params) {
          s.cancel_at_period_end = false;
          s.cancel_at = null;
        }
        return structuredClone(s);
      }),
    },
    customers: { retrieve: vi.fn(async () => customer) },
  };
  return { stripe, state, updates };
}

function seedDb({ recent = 0, provider = 'Stripe' } = {}) {
  dbMock.dbWrite.customerSubscription.findUnique.mockResolvedValue({
    id: SUB_ID,
    product: { provider },
  });
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ customerId: 'cus_case' });
  dbMock.dbWrite.modActivity.count.mockResolvedValue(recent);
}

const axiomRecords = () =>
  loggingMock.logToAxiom.mock.calls
    .map((c: unknown[]) => c[0] as Record<string, unknown>)
    .filter((r) => r.name === 'mod-membership-extend');

const input = (over: Partial<Parameters<typeof extendMembership>[0]> = {}) => ({
  userId: USER,
  days: 3,
  reason: 'Support case 123: 3 days instead of a refund',
  expectedCurrentPeriodEnd: PERIOD_END,
  actorId: MOD,
  ...over,
});

describe('extendMembership: the flow', () => {
  beforeEach(() => {
    resetSharedMocks();
    vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
    trackModActivity.mockClear();
    refreshSession.mockClear();
    invalidateSubscriptionCaches.mockClear();
    delIfValue.mockClear();
    setEnv({ STRIPE_SECRET_KEY: 'sk_live_00000000000000000000' });
    redisMock.sysRedis.set.mockResolvedValue('OK');
    seedDb();
  });

  it('renewing: exactly one update, the stated params and key; ok; audit written once', async () => {
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    const r = await extendMembership(input());
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.trialEnd).toBe('2026-11-25T02:22:00.000Z');
    expect(f.updates).toEqual([
      [
        SUB_ID,
        {
          trial_end: T3,
          proration_behavior: 'none',
          cancel_at_period_end: false,
          metadata: { modExtension: `${MOD}:3d:2026-11-03T12:00:00.000Z` },
        },
        { idempotencyKey: `mod-extend:${SUB_ID}:${T3}` },
      ],
    ]);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(MOD, {
      entityType: 'user',
      entityId: USER,
      activity: 'extendMembership',
    });
    expect(invalidateSubscriptionCaches).toHaveBeenCalledWith(USER);
    expect(delIfValue).toHaveBeenCalledTimes(1);
  });

  it('cancelling: still cancels, at the new end', async () => {
    const f = fakeStripe(liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END }));
    stripeRef.current = f.stripe;
    const r = await extendMembership(input());
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('cancelling');
    expect(f.state.sub.cancel_at).toBe(T3);
    expect(f.updates).toHaveLength(1);
  });

  it('cancelling: if Stripe drops cancel_at_period_end, it is restored from the response, even when the re-read then fails; the audit is still written', async () => {
    const f = fakeStripe(liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END }), {
      dropCancel: true,
      failRetrieveAfterWrite: true,
    });
    stripeRef.current = f.stripe;
    const r = await extendMembership(input());
    expect(r.ok).toBe(false);
    expect(r.cancelRestored).toBe(true);
    expect(f.updates.map((u) => u[1])).toEqual([
      expect.objectContaining({ trial_end: T3 }),
      { cancel_at_period_end: true },
    ]);
    expect(f.state.sub.cancel_at_period_end).toBe(true);
    expect(r.problems.join()).toMatch(/stopped after the update: stripe 503/);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
    expect(axiomRecords().at(-1)?.type).toBe('extended-with-problems');
  });

  it('a new invoice with money due comes back ok: false (never undone automatically)', async () => {
    const f = fakeStripe(liveSub(), {
      invoiceOnUpdate: { id: 'in_new', amount_due: 5000, amount_paid: 0 },
    });
    stripeRef.current = f.stripe;
    const r = await extendMembership(input());
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/in_new with money due or paid/);
    expect(f.updates).toHaveLength(1);
  });

  it('CAS: a stale expectedCurrentPeriodEnd refuses (409), nothing written, no audit row', async () => {
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    await expect(
      extendMembership(input({ expectedCurrentPeriodEnd: PERIOD_END - DAY }))
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.updates).toEqual([]);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('CAS: a double submit with the same preview value refuses the second (the first moved the period end)', async () => {
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    expect((await extendMembership(input())).ok).toBe(true);
    // The cooldown would also stop it; take it away so the CAS is what is tested.
    dbMock.dbWrite.modActivity.count.mockResolvedValue(0);
    await expect(extendMembership(input())).rejects.toThrow();
    expect(f.updates).toHaveLength(1);
  });

  it('a test-mode key refuses on the write path, before any read or write; the same flow passes with a live key', async () => {
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    for (const key of ['sk_test_00000000000000000000', 'rk_test_00000000000000000000']) {
      setEnv({ STRIPE_SECRET_KEY: key });
      await expect(extendMembership(input())).rejects.toThrow(/live Stripe only/);
    }
    expect(f.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(f.updates).toEqual([]);
    expect(trackModActivity).not.toHaveBeenCalled();
    setEnv({ STRIPE_SECRET_KEY: 'rk_live_00000000000000000000' });
    expect((await extendMembership(input())).ok).toBe(true);
  });

  it('a test-mode subscription (livemode false) refuses even under a live-looking key', async () => {
    const f = fakeStripe(liveSub({ livemode: false }));
    stripeRef.current = f.stripe;
    await expect(extendMembership(input())).rejects.toThrow(/not a live-mode subscription/);
    expect(f.updates).toEqual([]);
  });

  it('a refused guard writes nothing to Stripe and no ModActivity, but logs the refusal', async () => {
    const f = fakeStripe(liveSub({ status: 'past_due' }));
    stripeRef.current = f.stripe;
    await expect(extendMembership(input())).rejects.toThrow(/not active or trialing/);
    expect(f.updates).toEqual([]);
    expect(trackModActivity).not.toHaveBeenCalled();
    expect(axiomRecords().at(-1)?.type).toBe('refused');
  });

  it('the cooldown, read from ModActivity, refuses', async () => {
    seedDb({ recent: 1 });
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    await expect(extendMembership(input())).rejects.toThrow(/last 25 days/);
    expect(f.updates).toEqual([]);
  });

  it('extending yourself is FORBIDDEN, before anything is read', async () => {
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    await expect(extendMembership(input({ actorId: USER }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      previewMembershipExtension({ userId: USER, days: 3, actorId: USER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('a held lock refuses (409) and writes nothing', async () => {
    redisMock.sysRedis.set.mockResolvedValue(null);
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    await expect(extendMembership(input())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('the audit holds ids, dates, states and the reason only: no amounts, card or payment method', async () => {
    const f = fakeStripe(liveSub(), {
      invoiceOnUpdate: {
        id: 'in_zero',
        amount_due: 0,
        amount_paid: 0,
        payment_intent: 'pi_x',
        charge: 'ch_x',
      },
    });
    stripeRef.current = f.stripe;
    await extendMembership(input());
    const rec = axiomRecords().at(-1) as Record<string, unknown>;
    expect(rec.type).toBe('extended');
    expect(rec.reason).toBe('Support case 123: 3 days instead of a refund');
    const text = JSON.stringify(rec);
    for (const banned of [
      'amount',
      'card',
      'payment_method',
      'payment_intent',
      'pi_',
      'ch_',
      'last4',
      'brand',
      'default_payment_method',
    ])
      expect(text).not.toContain(banned);
    expect(Object.keys(rec.after as object).sort()).toEqual([
      'cancelAt',
      'cancelAtPeriodEnd',
      'currentPeriodEnd',
      'id',
      'latestInvoiceId',
      'status',
      'trialEnd',
    ]);
  });

  it('preview: read-only, shows the target and the CAS value; a test key is allowed to preview', async () => {
    setEnv({ STRIPE_SECRET_KEY: 'sk_test_00000000000000000000' });
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    const p = await previewMembershipExtension({ userId: USER, days: 3, actorId: MOD });
    expect(p).toMatchObject({
      problems: [],
      trialEnd: T3,
      trialEndIso: '2026-11-25T02:22:00.000Z',
      expectedCurrentPeriodEnd: PERIOD_END,
      mode: 'renewing',
      keyMode: 'test',
    });
    expect(f.updates).toEqual([]);
    expect(trackModActivity).not.toHaveBeenCalled();
  });
});

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
    items: { data: [{ price: { id: 'price_gold', recurring: { interval: 'month' } } }] },
    // Payment fields the audit must never carry.
    default_payment_method: 'pm_secret_card',
    latest_invoice: paidInvoice,
    ...over,
  } as unknown as Stripe.Subscription;
}
const customer = {
  id: 'cus_case',
  object: 'customer',
  metadata: { userId: String(USER) },
  invoice_settings: { default_payment_method: 'pm_secret_card' },
  sources: { data: [{ id: 'card_secret', last4: '4242', brand: 'visa' }] },
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
  it('only a single monthly plan: yearly, or more than one item, refuses', () => {
    const yearly = { data: [{ price: { id: 'p', recurring: { interval: 'year' } } }] };
    expect(withSub({ items: yearly })).toMatch(/single monthly plan/);
    const two = {
      data: [
        { price: { recurring: { interval: 'month' } } },
        { price: { recurring: { interval: 'month' } } },
      ],
    };
    expect(withSub({ items: two })).toMatch(/single monthly plan/);
  });
  it('pending invoice items refuse (the trial invoice would charge them)', () => {
    expect(problemsOf({ pendingInvoiceItems: 1 })).toMatch(/pending invoice items/);
  });
  it('a moderator as the member refuses', () => {
    expect(
      problemsOf({
        row: { id: SUB_ID, provider: 'Stripe', userCustomerId: 'cus_case', userIsModerator: true },
      })
    ).toMatch(/the member is a moderator/);
  });
  it('the Stripe stamp names no moderator (the member can read sub metadata)', () => {
    expect(updateParams({ trialEnd: T3, mode: 'renewing', stamp: '3d:x' }).metadata).toEqual({
      modExtension: '3d:x',
    });
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
  opts: {
    dropCancel?: boolean;
    loseCancelAfterResponse?: boolean;
    invoiceOnUpdate?: unknown;
    failRetrieveAfterWrite?: boolean;
    rejectUpdate?: string;
    pendingItems?: number;
  } = {}
) {
  const state = { sub: structuredClone(sub) as unknown as Record<string, unknown> };
  const updates: [string, Record<string, unknown>, unknown][] = [];
  const stripe = {
    subscriptions: {
      retrieve: vi.fn(async (id: string, params?: { expand?: string[] }) => {
        if (opts.failRetrieveAfterWrite && updates.length) throw new Error('stripe 503');
        if (id !== state.sub.id) throw Object.assign(new Error('nf'), { statusCode: 404 });
        const out = structuredClone(state.sub);
        // As Stripe: latest_invoice is a bare id unless expanded.
        const inv = out.latest_invoice as { id?: string } | string | null;
        if (!params?.expand?.includes('latest_invoice') && inv && typeof inv !== 'string')
          out.latest_invoice = inv.id;
        return out;
      }),
      update: vi.fn(async (id: string, params: Record<string, unknown>, options: unknown) => {
        if (opts.rejectUpdate)
          throw Object.assign(new Error('invalid'), { type: opts.rejectUpdate, statusCode: 400 });
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
        const reply = structuredClone(s);
        // The response still shows the cancel; the subscription lost it right after.
        if (opts.loseCancelAfterResponse && 'trial_end' in params) {
          s.cancel_at_period_end = false;
          s.cancel_at = null;
        }
        return reply;
      }),
    },
    customers: { retrieve: vi.fn(async () => customer) },
    invoiceItems: {
      list: vi.fn(async () => ({
        data: Array.from({ length: opts.pendingItems ?? 0 }, (_, i) => ({ id: `ii_${i}` })),
      })),
    },
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

/** The lock released is exactly ours: the key set with NX, and the owner value that set wrote. */
function expectOwnLockReleased() {
  const [key, owner] = redisMock.sysRedis.set.mock.calls[0] as [string, string];
  expect(key).toBe(`membership-extend:lock:${USER}`);
  expect(delIfValue).toHaveBeenCalledWith(redisMock.sysRedis, key, owner);
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
          metadata: { modExtension: '3d:to:2026-11-25T02:22:00.000Z' },
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
    expect(refreshSession).toHaveBeenCalledWith(USER, { caller: 'subscription' });
    expect(delIfValue).toHaveBeenCalledTimes(1);
    expectOwnLockReleased();
    expect(redisMock.sysRedis.set).toHaveBeenCalledWith(
      `membership-extend:lock:${USER}`,
      expect.any(String),
      { NX: true, EX: 600 }
    );
    expect(dbMock.dbWrite.modActivity.count).toHaveBeenCalledWith({
      where: {
        entityType: 'user',
        entityId: USER,
        activity: 'extendMembership',
        createdAt: { gte: new Date((NOW - 25 * DAY) * 1000) },
      },
    });
    expect(f.stripe.invoiceItems.list).toHaveBeenCalledWith({
      customer: 'cus_case',
      pending: true,
      limit: 1,
    });
  });

  it('cancelling: the response kept the cancel but the re-read lost it: restored with its own key, ok', async () => {
    const f = fakeStripe(liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END }), {
      loseCancelAfterResponse: true,
    });
    stripeRef.current = f.stripe;
    const r = await extendMembership(input());
    expect(r.ok).toBe(true);
    expect(r.cancelRestored).toBe(true);
    expect(f.updates).toHaveLength(2);
    expect(f.updates[1]).toEqual([
      SUB_ID,
      { cancel_at_period_end: true },
      { idempotencyKey: `mod-extend:${SUB_ID}:${T3}:cancel` },
    ]);
    expect(f.state.sub.cancel_at_period_end).toBe(true);
    expect(f.state.sub.cancel_at).toBe(T3);
  });

  it('a new $0 invoice is read expanded after the update, so the extension is ok', async () => {
    const f = fakeStripe(liveSub(), {
      invoiceOnUpdate: { id: 'in_zero', amount_due: 0, amount_paid: 0 },
    });
    stripeRef.current = f.stripe;
    const r = await extendMembership(input());
    expect(r.ok).toBe(true);
    expect(r.newInvoiceId).toBe('in_zero');
  });

  it('Stripe rejecting the update outright (4xx): ok false, no ModActivity row (no cooldown), Axiom says so', async () => {
    for (const type of ['StripeInvalidRequestError', 'StripeCardError']) {
      trackModActivity.mockClear();
      const f = fakeStripe(liveSub(), { rejectUpdate: type });
      stripeRef.current = f.stripe;
      const r = await extendMembership(input());
      expect(r.ok).toBe(false);
      expect(trackModActivity).not.toHaveBeenCalled();
      expect(axiomRecords().at(-1)?.type).toBe('rejected-by-stripe');
    }
    // Control: an error of unknown outcome (a timeout, a 5xx) still starts the cooldown.
    trackModActivity.mockClear();
    stripeRef.current = fakeStripe(liveSub(), { rejectUpdate: 'StripeAPIError' }).stripe;
    expect((await extendMembership(input())).ok).toBe(false);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('the stamp is deterministic: a retry later sends identical params under the same key (Stripe replays its stored error; no cooldown)', async () => {
    const f = fakeStripe(liveSub(), { rejectUpdate: 'StripeInvalidRequestError' });
    stripeRef.current = f.stripe;
    expect((await extendMembership(input())).ok).toBe(false);
    vi.setSystemTime((NOW + 3600) * 1000);
    expect((await extendMembership(input())).ok).toBe(false);
    const calls = f.stripe.subscriptions.update.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('a failing ModActivity write is logged as audit-failed and the result still returns', async () => {
    trackModActivity.mockRejectedValueOnce(new Error('db down'));
    stripeRef.current = fakeStripe(liveSub()).stripe;
    expect((await extendMembership(input())).ok).toBe(true);
    expect(axiomRecords().some((r) => r.type === 'audit-failed')).toBe(true);
  });

  it('pending invoice items on the customer refuse, nothing written', async () => {
    const f = fakeStripe(liveSub(), { pendingItems: 1 });
    stripeRef.current = f.stripe;
    await expect(extendMembership(input())).rejects.toThrow(/pending invoice items/);
    expect(f.updates).toEqual([]);
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
    expect(delIfValue).toHaveBeenCalledTimes(1);
    expectOwnLockReleased();
    expect(axiomRecords().at(-1)).toMatchObject({
      type: 'refused',
      problems: ['current_period_end changed since the preview'],
    });
  });

  it('CAS: a later expectedCurrentPeriodEnd refuses too (equality, not an ordering)', async () => {
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    await expect(
      extendMembership(input({ expectedCurrentPeriodEnd: PERIOD_END + DAY }))
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.updates).toEqual([]);
  });

  it('a double submit: the second is refused (the cooldown and the live-trial guard stop it before the CAS)', async () => {
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    expect((await extendMembership(input())).ok).toBe(true);
    dbMock.dbWrite.modActivity.count.mockResolvedValue(1);
    await expect(extendMembership(input())).rejects.toThrow(/last 25 days.*already in a trial/);
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
    expect(delIfValue).toHaveBeenCalledTimes(1);
    expectOwnLockReleased();
  });

  it('a moderator member, read from the User row, refuses with nothing written', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ customerId: 'cus_case', isModerator: true });
    const f = fakeStripe(liveSub());
    stripeRef.current = f.stripe;
    await expect(extendMembership(input())).rejects.toThrow(/the member is a moderator/);
    expect(f.updates).toEqual([]);
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
      'pm_',
      'secret',
      'last4',
      'brand',
      '4242',
      'visa',
      'invoice_settings',
      'sources',
    ])
      expect(text).not.toContain(banned);
    expect(Object.keys(rec).sort()).toEqual([
      'actorId',
      'after',
      'before',
      'cancelRestored',
      'days',
      'mode',
      'name',
      'newInvoiceId',
      'problems',
      'reason',
      'response',
      'subscriptionId',
      'trialEnd',
      'type',
      'userId',
    ]);
    for (const k of ['before', 'response'] as const)
      expect(Object.keys(rec[k] as object).sort()).toEqual(Object.keys(rec.after as object).sort());
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

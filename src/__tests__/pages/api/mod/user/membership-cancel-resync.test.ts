import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { Stripe } from 'stripe';
import { dbMock, redisMock, resetSharedMocks, setEnv } from '~/__tests__/mocks';

/**
 * `/api/mod/user/membership-cancel*` and `/api/mod/user/membership-resync*`. Drives the REAL
 * endpoints, the REAL role-grant check and the REAL services (the re-sync through the webhook's real
 * `upsertSubscription`). Only the edges are faked: the session, the grant row, Stripe, the database.
 */

const NOW = Math.floor(Date.UTC(2026, 10, 3, 12, 0) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 10, 22, 2, 22) / 1000);
const CANCELED_AT = NOW - 86_400;
const MEMBER = 10495685;
const MOD = 5;
const SUB_ID = 'sub_case';
const GRANTED_ROLE = 'moderator:support';

const { session, grantRow, trackModActivity, stripeRef, mockAudit } = vi.hoisted(() => ({
  session: { user: {} as Record<string, unknown> },
  grantRow: { path: null as string | null, roles: [] as string[] },
  trackModActivity: vi.fn(async () => undefined),
  stripeRef: { current: null as unknown },
  mockAudit: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => {
    const status = e instanceof TRPCError ? getHTTPStatusCodeFromError(e) : 500;
    return res
      .status(status)
      .json({ error: (e as { code?: string }).code ?? 'error', message: (e as Error).message });
  },
}));
// The grant store: one `AppPageAccess` row, keyed by the path the check asks for.
vi.mock('~/server/db/kyselyDb', () => {
  let path: unknown;
  const query = {
    select: () => query,
    where: (col: string, _op: string, value: unknown) => {
      if (col === 'path') path = value;
      return query;
    },
    executeTakeFirst: async () => (path === grantRow.path ? { roles: grantRow.roles } : undefined),
  };
  return { kyselyWrite: { selectFrom: () => query } };
});
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.mock('~/server/auth/session-invalidation', () => ({ refreshSession: vi.fn(async () => 1) }));
vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: vi.fn(async () => undefined),
}));
vi.mock('~/server/redis/atomic', () => ({ delIfValue: vi.fn(async () => 1) }));
vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: async () => stripeRef.current,
}));

import cancelHandler from '~/pages/api/mod/user/membership-cancel';
import cancelPreviewHandler from '~/pages/api/mod/user/membership-cancel-preview';
import resyncHandler from '~/pages/api/mod/user/membership-resync';
import resyncPreviewHandler from '~/pages/api/mod/user/membership-resync-preview';

type Handler = typeof cancelHandler;

function liveSub(over: Record<string, unknown> = {}) {
  return {
    id: SUB_ID,
    object: 'subscription',
    livemode: true,
    status: 'active',
    customer: 'cus_case',
    created: NOW - 90 * 86_400,
    current_period_start: PERIOD_END - 30 * 86_400,
    current_period_end: PERIOD_END,
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    schedule: null,
    discount: null,
    metadata: {},
    items: {
      data: [
        { price: { id: 'price_gold', product: 'prod_gold', recurring: { interval: 'month' } } },
      ],
    },
    latest_invoice: 'in_oct',
    ...over,
  } as unknown as Stripe.Subscription;
}

/**
 * Stripe as these endpoints see it. Every method outside `allowed` is recorded in `writes` (and
 * throws), so "no Stripe write" is an assertion on that list, whatever the method is called.
 */
function fakeStripe(sub = liveSub(), list: Stripe.Subscription[] = []) {
  const state = structuredClone(sub) as unknown as Record<string, unknown>;
  const writes: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const resource = (name: string, allowed: Record<string, unknown>) =>
    new Proxy(allowed, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          writes.push(`${name}.${prop}`);
          void args;
          throw new Error(`unexpected Stripe call ${name}.${prop}`);
        };
      },
    });
  const subscriptions = {
    retrieve: vi.fn(async () => structuredClone(state)),
    list: vi.fn(async () => ({ data: list })),
    update: vi.fn(async (_id: string, params: Record<string, unknown>) => {
      writes.push('subscriptions.update');
      updates.push(params);
      state.cancel_at_period_end = params.cancel_at_period_end;
      state.canceled_at = params.cancel_at_period_end ? NOW : null;
      state.cancel_at = params.cancel_at_period_end ? state.current_period_end : null;
      return structuredClone(state);
    }),
  };
  const stripe = {
    subscriptions: resource('subscriptions', subscriptions),
    customers: resource('customers', {
      retrieve: vi.fn(async () => ({ id: 'cus_case', metadata: { userId: String(MEMBER) } })),
    }),
    invoices: resource('invoices', {}),
    invoiceItems: resource('invoiceItems', {}),
    paymentIntents: resource('paymentIntents', {}),
    refunds: resource('refunds', {}),
    checkout: { sessions: resource('checkout.sessions', {}) },
  };
  stripeRef.current = stripe;
  return { stripe, subscriptions, writes, updates };
}

function call(handler: Handler, method: 'GET' | 'POST', input: Record<string, unknown>) {
  const req = {
    method,
    headers: {},
    body: method === 'POST' ? input : {},
    query: method === 'GET' ? input : {},
  } as unknown as Parameters<Handler>[0];
  let status = 200;
  let body: unknown;
  const res = {
    status(c: number) {
      status = c;
      return res;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
  } as unknown as Parameters<Handler>[1];
  return Promise.resolve(handler(req, res)).then(() => ({
    status,
    body: body as Record<string, unknown>,
  }));
}

const asModerator = (roles: string[], id = MOD) => {
  session.user = { id, isModerator: true, roles, permissions: [], bannedAt: null };
};

const REASON = 'Support case 123: member asked by email';
const setCancel = (cancelAtPeriodEnd: boolean, over: Record<string, unknown> = {}) =>
  call(cancelHandler, 'POST', { userId: MEMBER, cancelAtPeriodEnd, reason: REASON, ...over });
const previewCancel = (cancelAtPeriodEnd: boolean) =>
  call(cancelPreviewHandler, 'GET', {
    userId: String(MEMBER),
    cancelAtPeriodEnd: String(cancelAtPeriodEnd),
  });
const resync = (over: Record<string, unknown> = {}) =>
  call(resyncHandler, 'POST', { userId: MEMBER, reason: REASON, ...over });
const previewResync = () => call(resyncPreviewHandler, 'GET', { userId: String(MEMBER) });

const ROW = {
  id: SUB_ID,
  status: 'active',
  priceId: 'price_gold',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  currentPeriodEnd: new Date(PERIOD_END * 1000),
  product: { provider: 'Stripe' },
};
const BUZZ_MEMBERSHIP = {
  id: 'buzz_sub_1',
  status: 'active',
  currentPeriodEnd: new Date(PERIOD_END * 1000),
};

beforeEach(() => {
  resetSharedMocks();
  vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
  trackModActivity.mockClear();
  setEnv({ STRIPE_SECRET_KEY: 'sk_live_00000000000000000000' });
  grantRow.path = 'grant:user.membership.cancel';
  grantRow.roles = [GRANTED_ROLE];
  asModerator([GRANTED_ROLE]);
  redisMock.sysRedis.set.mockResolvedValue('OK');
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  dbMock.dbWrite.customerSubscription.findUnique.mockResolvedValue(ROW);
  dbMock.dbWrite.customerSubscription.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.user.findUnique.mockResolvedValue({
    customerId: 'cus_case',
    isModerator: false,
    bannedAt: null,
    muted: false,
  });
  dbMock.dbWrite.user.findFirst.mockResolvedValue({
    id: MEMBER,
    customerId: 'cus_case',
    subscriptions: [{ id: SUB_ID, updatedAt: new Date(), status: 'active' }],
  });
  dbMock.dbWrite.customerSubscription.updateMany.mockResolvedValue({ count: 0 });
  dbMock.dbRead.vault.findFirst.mockResolvedValue({ userId: MEMBER, storageKb: 0 });
});

describe('cancel-at-period-end: the grant', () => {
  it('control: a moderator in a role on `user.membership.cancel` sets it; one field is sent', async () => {
    const { updates } = fakeStripe();
    const { status, body } = await setCancel(true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, changed: true, written: true });
    expect(updates).toEqual([{ cancel_at_period_end: true }]);
    expect(trackModActivity).toHaveBeenCalledWith(MOD, {
      entityType: 'user',
      entityId: MEMBER,
      activity: 'setMembershipCancel',
    });
  });

  it('holding only the extend grant is refused (403): undoing a cancel is granted apart', async () => {
    const { writes, subscriptions } = fakeStripe();
    grantRow.path = 'grant:user.membership.extend';
    const { status, body } = await setCancel(false);
    expect(status).toBe(403);
    expect(body.message).toMatch(/user\.membership\.cancel/);
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('a role not on the grant is refused (403), the preview too', async () => {
    const { writes, subscriptions } = fakeStripe();
    asModerator(['moderator:mod-medium-access']);
    expect((await setCancel(true)).status).toBe(403);
    expect((await previewCancel(true)).status).toBe(403);
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe('cancel-at-period-end: the rules', () => {
  it('re-running to the state it already has writes nothing and answers changed: false', async () => {
    const { writes } = fakeStripe();
    const first = await setCancel(true);
    expect(first.body).toMatchObject({ ok: true, changed: true });
    const again = await setCancel(true);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, changed: false, written: null });
    expect(writes).toEqual(['subscriptions.update']);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('control: undoing a member’s own cancel clears it', async () => {
    const { updates } = fakeStripe(
      liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END, canceled_at: CANCELED_AT })
    );
    const { status, body } = await setCancel(false);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, changed: true });
    expect(updates).toEqual([{ cancel_at_period_end: false }]);
  });

  it.each([
    [
      'a ban/mute cancel (the moderation mark)',
      liveSub({
        cancel_at_period_end: true,
        canceled_at: CANCELED_AT,
        metadata: { civitai_moderation_cancel: String(CANCELED_AT) },
      }),
      /ban or mute/,
    ],
    [
      'a membership gift',
      liveSub({ cancel_at_period_end: true, metadata: { membershipGiftId: '7' } }),
      /gift/,
    ],
    [
      'a custom cancel date (a gift end)',
      liveSub({ cancel_at: PERIOD_END + 60 * 86_400 }),
      /custom cancel date/,
    ],
    [
      'a past_due subscription',
      liveSub({ status: 'past_due', cancel_at_period_end: true }),
      /not active or trialing/,
    ],
    ['a schedule', liveSub({ cancel_at_period_end: true, schedule: 'sub_sched_1' }), /schedule/],
  ])('undo is refused (400) for %s, nothing written', async (_label, sub, message) => {
    const { writes } = fakeStripe(sub);
    const { status, body } = await setCancel(false);
    expect(status).toBe(400);
    expect(body.message).toMatch(message);
    expect(writes).toEqual([]);
  });

  it('undo is refused for a banned member', async () => {
    const { writes } = fakeStripe(liveSub({ cancel_at_period_end: true }));
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      customerId: 'cus_case',
      isModerator: false,
      bannedAt: new Date(),
      muted: false,
    });
    expect((await setCancel(false)).status).toBe(400);
    expect(writes).toEqual([]);
  });

  it('a non-Stripe membership is refused (400) without reading Stripe', async () => {
    const { subscriptions, writes } = fakeStripe();
    dbMock.dbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...ROW,
      product: { provider: 'Paddle' },
    });
    const { status, body } = await setCancel(true);
    expect(status).toBe(400);
    expect(body.message).toMatch(/billed by Paddle/);
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('your own membership is refused (403)', async () => {
    const { writes } = fakeStripe();
    asModerator([GRANTED_ROLE], MEMBER);
    expect((await setCancel(true)).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('another change holding the member lock is refused (409)', async () => {
    const { writes } = fakeStripe();
    redisMock.sysRedis.set.mockResolvedValue(null as never);
    expect((await setCancel(true)).status).toBe(409);
    expect(writes).toEqual([]);
  });

  it('the preview reads the verdict and writes nothing', async () => {
    const { writes } = fakeStripe();
    const { status, body } = await previewCancel(true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ problems: [], changed: true });
    expect(writes).toEqual([]);
  });
});

describe('re-sync: no Stripe writes, ever', () => {
  beforeEach(() => {
    grantRow.path = 'grant:user.membership.extend';
  });

  it('control: an out-of-date row is rewritten from Stripe, and Stripe is only read', async () => {
    const { writes, subscriptions } = fakeStripe(
      liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END })
    );
    const { status, body } = await resync();
    expect(status).toBe(200);
    expect(subscriptions.retrieve).toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(dbMock.dbWrite.customerSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_buzzType: { userId: MEMBER, buzzType: 'green' } },
        update: expect.objectContaining({ id: SUB_ID, cancelAtPeriodEnd: true }),
      })
    );
    expect(body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'cancelAtPeriodEnd', ours: false, stripe: true }),
      ])
    );
    expect(trackModActivity).toHaveBeenCalledWith(MOD, {
      entityType: 'user',
      entityId: MEMBER,
      activity: 'resyncMembership',
    });
  });

  it('with no row, the one live subscription on the customer is synced, still read-only', async () => {
    const { writes } = fakeStripe(liveSub(), [liveSub({ id: 'sub_missed' })]);
    dbMock.dbWrite.customerSubscription.findUnique.mockResolvedValue(null);
    const { status } = await resync();
    expect(status).toBe(200);
    expect(writes).toEqual([]);
    expect(dbMock.dbWrite.customerSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ id: 'sub_missed' }) })
    );
  });

  it('with no row and two live subscriptions, it is refused (400) and nothing is written', async () => {
    const { writes } = fakeStripe(liveSub(), [liveSub({ id: 'sub_a' }), liveSub({ id: 'sub_b' })]);
    dbMock.dbWrite.customerSubscription.findUnique.mockResolvedValue(null);
    const { status, body } = await resync();
    expect(status).toBe(400);
    expect(body.message).toMatch(/2 live subscriptions/);
    expect(writes).toEqual([]);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
  });

  it('a Paddle membership is refused (400)', async () => {
    const { subscriptions } = fakeStripe();
    dbMock.dbWrite.customerSubscription.findUnique.mockResolvedValue({
      ...ROW,
      product: { provider: 'Paddle' },
    });
    expect((await resync()).status).toBe(400);
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('is held to the extend grant: a role off it is refused (403)', async () => {
    const { subscriptions } = fakeStripe();
    asModerator(['moderator:mod-medium-access']);
    expect((await resync()).status).toBe(403);
    expect((await previewResync()).status).toBe(403);
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('a reason is required', async () => {
    fakeStripe();
    expect((await resync({ reason: 'short' })).status).toBe(400);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
  });
});

describe('re-sync: ending a Buzz-bought membership needs a confirm', () => {
  beforeEach(() => {
    grantRow.path = 'grant:user.membership.extend';
    dbMock.dbWrite.customerSubscription.findFirst.mockResolvedValue(BUZZ_MEMBERSHIP);
  });

  it('the preview names the Buzz membership it would end', async () => {
    fakeStripe();
    const { body } = await previewResync();
    expect(body).toMatchObject({ problems: [], endsBuzzMembership: { id: 'buzz_sub_1' } });
  });

  it('without the confirm it is refused (400) and nothing is written', async () => {
    fakeStripe();
    const { status, body } = await resync();
    expect(status).toBe(400);
    expect(body.message).toMatch(/Buzz-bought membership buzz_sub_1/);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.customerSubscription.updateMany).not.toHaveBeenCalled();
  });

  it('control: with the confirm it syncs and the webhook path ends the Buzz membership', async () => {
    const { writes } = fakeStripe();
    dbMock.dbWrite.customerSubscription.updateMany.mockResolvedValue({ count: 1 });
    const { status, body } = await resync({ confirmEndBuzzMembership: true });
    expect(status).toBe(200);
    expect(body.endedBuzzMembership).toMatchObject({ id: 'buzz_sub_1' });
    expect(dbMock.dbWrite.customerSubscription.updateMany).toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('a past_due Stripe membership ends nothing, so no confirm is asked', async () => {
    fakeStripe(liveSub({ status: 'past_due' }));
    const { status, body } = await resync();
    expect(status).toBe(200);
    expect(body.endedBuzzMembership).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { Stripe } from 'stripe';
import { dbMock, redisMock, resetSharedMocks, setEnv } from '~/__tests__/mocks';
import { delIfValue } from '~/server/redis/atomic';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { toDateTime } from '~/server/services/stripe.service';

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
// Only the third-party call; the Buzz supersede the upsert reaches stays real.
vi.mock('~/server/services/subscriptions.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncFreshdeskMembership: vi.fn(async () => undefined),
}));
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
 * Stripe as these endpoints see it. Any method outside the allowed reads, on any resource at any
 * depth, is recorded in `writes` (and throws), so "no Stripe write" is an assertion on that list.
 */
function fakeStripe(
  sub = liveSub(),
  list: Stripe.Subscription[] = [],
  hooks: { updateError?: Error; retrieveErrorAfterUpdate?: Error; invoiceOnUpdate?: string } = {}
) {
  const state = structuredClone(sub) as unknown as Record<string, unknown>;
  const writes: string[] = [];
  const updates: Record<string, unknown>[] = [];
  let updated = false;
  const recorder = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === 'then' ? undefined : recorder(`${path}.${String(prop)}`)),
      apply: () => {
        writes.push(path);
        throw new Error(`unexpected Stripe call ${path}`);
      },
    });
  const reads = <T extends object>(name: string, allowed: T) =>
    new Proxy(allowed, {
      get: (target, prop) =>
        prop in target ? target[prop as keyof T] : recorder(`${name}.${String(prop)}`),
    });
  const subscriptions = {
    retrieve: vi.fn(async () => {
      if (updated && hooks.retrieveErrorAfterUpdate) throw hooks.retrieveErrorAfterUpdate;
      return structuredClone(state);
    }),
    list: vi.fn(async () => ({ data: list })),
    update: vi.fn(async (_id: string, params: Record<string, unknown>) => {
      writes.push('subscriptions.update');
      updates.push(params);
      if (hooks.updateError) throw hooks.updateError;
      updated = true;
      state.cancel_at_period_end = params.cancel_at_period_end;
      state.canceled_at = params.cancel_at_period_end ? NOW : null;
      state.cancel_at = params.cancel_at_period_end ? state.current_period_end : null;
      if (hooks.invoiceOnUpdate) state.latest_invoice = hooks.invoiceOnUpdate;
      return structuredClone(state);
    }),
  };
  const stripe = reads('stripe', {
    subscriptions: reads('subscriptions', subscriptions),
    customers: reads('customers', {
      retrieve: vi.fn(async () => ({ id: 'cus_case', metadata: { userId: String(MEMBER) } })),
    }),
    then: undefined,
  });
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
  // As the upsert stores it (toDateTime is offset from the epoch).
  currentPeriodEnd: toDateTime(PERIOD_END),
  product: { provider: 'Stripe' },
};
const BUZZ_MEMBERSHIP = {
  id: 'buzz_sub_1',
  status: 'active',
  currentPeriodEnd: toDateTime(PERIOD_END),
};
// What the preview hands back for the panel's checkbox to send.
const BUZZ_CONFIRM = `buzz_sub_1|active|${toDateTime(PERIOD_END).toISOString()}`;

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
    expect(trackModActivity).toHaveBeenCalledWith(MOD, {
      entityType: 'user',
      entityId: MEMBER,
      activity: 'undoMembershipCancel',
    });
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

  it.each([
    ['banned', { bannedAt: new Date(), muted: false }],
    ['muted', { bannedAt: null, muted: true }],
  ])('undo is refused for a %s member', async (_label, user) => {
    const { writes } = fakeStripe(liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END }));
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      customerId: 'cus_case',
      isModerator: false,
      ...user,
    });
    const { status, body } = await setCancel(false);
    expect(status).toBe(400);
    expect(body.message).toMatch(/banned or muted/);
    expect(writes).toEqual([]);
  });

  it.each([
    [
      'a custom cancel date (a gift end)',
      liveSub({ cancel_at: PERIOD_END + 60 * 86_400 }),
      /custom cancel date/,
    ],
    ['a past_due subscription', liveSub({ status: 'past_due' }), /not active or trialing/],
    ['a schedule', liveSub({ schedule: 'sub_sched_1' }), /schedule/],
    ['another customer', liveSub({ customer: 'cus_other' }), /not this user's Stripe customer/],
    ['a test-mode subscription', liveSub({ livemode: false }), /not a live-mode subscription/],
  ])('set is refused (400) for %s, nothing written', async (_label, sub, message) => {
    const { writes } = fakeStripe(sub);
    const { status, body } = await setCancel(true);
    expect(status).toBe(400);
    expect(body.message).toMatch(message);
    expect(writes).toEqual([]);
  });

  it('a moderator member is refused (400)', async () => {
    const { writes } = fakeStripe();
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      customerId: 'cus_case',
      isModerator: true,
      bannedAt: null,
      muted: false,
    });
    const { status, body } = await setCancel(true);
    expect(status).toBe(400);
    expect(body.message).toMatch(/is a moderator/);
    expect(writes).toEqual([]);
  });

  it('a test Stripe key is refused (400) before Stripe is read, and the preview says so', async () => {
    const { writes, subscriptions } = fakeStripe();
    setEnv({ STRIPE_SECRET_KEY: 'sk_test_00000000000000000000' });
    expect((await setCancel(true)).status).toBe(400);
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
    const pv = await previewCancel(true);
    expect(pv.body).toMatchObject({ changed: null });
    expect(String(pv.body.problems)).toMatch(/key is not live/);
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

  it("takes extend's per-member lock with NX, and releases it with its owner token", async () => {
    fakeStripe();
    await setCancel(true);
    const lockKey = `${REDIS_SYS_KEYS.MEMBERSHIP_EXTEND.LOCK}:${MEMBER}`;
    expect(redisMock.sysRedis.set).toHaveBeenCalledWith(
      lockKey,
      expect.any(String),
      expect.objectContaining({ NX: true })
    );
    const owner = redisMock.sysRedis.set.mock.calls.find((c) => c[0] === lockKey)?.[1];
    expect(delIfValue).toHaveBeenCalledWith(redisMock.sysRedis, lockKey, owner);
  });

  it('the lock is released after a refusal too', async () => {
    fakeStripe(liveSub({ schedule: 'sub_sched_1' }));
    vi.mocked(delIfValue).mockClear();
    expect((await setCancel(true)).status).toBe(400);
    expect(delIfValue).toHaveBeenCalledTimes(1);
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

  it('the preview names the Buzz membership it would end, with the confirm to send back', async () => {
    fakeStripe();
    const { body } = await previewResync();
    expect(body).toMatchObject({
      problems: [],
      endsBuzzMembership: { id: 'buzz_sub_1', confirm: BUZZ_CONFIRM },
    });
  });

  it('a confirm from before a repeat Buzz purchase (same row, new period) is refused (400)', async () => {
    fakeStripe();
    dbMock.dbWrite.customerSubscription.findFirst.mockResolvedValue({
      ...BUZZ_MEMBERSHIP,
      currentPeriodEnd: toDateTime(PERIOD_END + 30 * 86_400),
    });
    const { status, body } = await resync({ confirmEndBuzzMembership: BUZZ_CONFIRM });
    expect(status).toBe(400);
    expect(body.message).toMatch(/confirm it from a fresh preview/);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
  });

  it('a bare `true` is not a confirm', async () => {
    fakeStripe();
    expect((await resync({ confirmEndBuzzMembership: true })).status).toBe(400);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
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
    const { status, body } = await resync({ confirmEndBuzzMembership: BUZZ_CONFIRM });
    expect(status).toBe(200);
    expect(body.endedBuzzMembership).toMatchObject({ id: 'buzz_sub_1' });
    expect(dbMock.dbWrite.customerSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: MEMBER,
          buzzType: 'buzzPurchase',
          status: { notIn: ['canceled', 'incomplete_expired'] },
        }),
        data: expect.objectContaining({ status: 'canceled' }),
      })
    );
    expect(writes).toEqual([]);
  });

  it('a past_due Stripe membership ends nothing, so no confirm is asked', async () => {
    fakeStripe(liveSub({ status: 'past_due' }));
    const { status, body } = await resync();
    expect(status).toBe(200);
    expect(body.endedBuzzMembership).toBeNull();
  });
});

describe('cancel-at-period-end: after the write', () => {
  it('a new invoice after the update comes back ok: false, and is audited', async () => {
    fakeStripe(liveSub(), [], { invoiceOnUpdate: 'in_new' });
    const { status, body } = await setCancel(true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, written: true });
    expect(String(body.problems)).toMatch(/made invoice in_new/);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('Stripe refusing the update: written false, no ModActivity row', async () => {
    fakeStripe(liveSub(), [], {
      updateError: Object.assign(new Error('No such subscription'), {
        type: 'StripeInvalidRequestError',
      }),
    });
    const { status, body } = await setCancel(true);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: false, written: false });
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('the re-read failing after the update: written true, ok false, still audited', async () => {
    fakeStripe(liveSub(), [], { retrieveErrorAfterUpdate: new Error('socket hang up') });
    const { body } = await setCancel(true);
    expect(body).toMatchObject({ ok: false, written: true, after: null });
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });
});

describe('re-sync: what it refuses', () => {
  beforeEach(() => {
    grantRow.path = 'grant:user.membership.extend';
  });

  it('control: a row that matches Stripe previews as no changes (the stored-date offset is not a diff)', async () => {
    fakeStripe();
    const { body } = await previewResync();
    expect(body).toMatchObject({ problems: [], changes: [] });
  });

  it('an ended subscription is refused (400): its deleted event settles gifted months', async () => {
    const { writes } = fakeStripe(liveSub({ status: 'canceled', ended_at: NOW }));
    const { status, body } = await resync();
    expect(status).toBe(400);
    expect(body.message).toMatch(/has ended \(canceled\)/);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.customerSubscription.delete).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('a lapsed row the customer has replaced with a live subscription is refused (400)', async () => {
    fakeStripe(liveSub({ status: 'unpaid' }), [liveSub({ id: 'sub_new' })]);
    const { status, body } = await resync();
    expect(status).toBe(400);
    expect(body.message).toMatch(/customer has live sub_new/);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
  });

  it('a row whose subscription Stripe no longer has is refused (400)', async () => {
    const { subscriptions } = fakeStripe();
    subscriptions.retrieve.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { statusCode: 404 })
    );
    const { status, body } = await resync();
    expect(status).toBe(400);
    expect(body.message).toMatch(/Stripe has no subscription sub_case/);
  });

  it('a user with no Stripe customer is refused (400) without reading Stripe', async () => {
    const { subscriptions } = fakeStripe();
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ customerId: null });
    const { status, body } = await resync();
    expect(status).toBe(400);
    expect(body.message).toMatch(/no Stripe customer/);
    expect(subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('your own membership is refused (403)', async () => {
    fakeStripe();
    asModerator([GRANTED_ROLE], MEMBER);
    expect((await resync()).status).toBe(403);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
  });

  it('the upsert failing part-way still leaves a ModActivity row, and the error surfaces', async () => {
    fakeStripe(liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END }));
    dbMock.dbWrite.customerSubscription.upsert.mockRejectedValueOnce(new Error('deadlock'));
    const { status } = await resync();
    expect(status).toBe(500);
    expect(trackModActivity).toHaveBeenCalledWith(MOD, {
      entityType: 'user',
      entityId: MEMBER,
      activity: 'resyncMembership',
    });
  });
});

describe('races the lanes found', () => {
  it('undo is refused when the member was banned after the read, before the write', async () => {
    const { writes } = fakeStripe(liveSub({ cancel_at_period_end: true, cancel_at: PERIOD_END }));
    dbMock.dbWrite.user.findUnique
      .mockResolvedValueOnce({
        customerId: 'cus_case',
        isModerator: false,
        bannedAt: null,
        muted: false,
      })
      .mockResolvedValueOnce({ bannedAt: new Date(), muted: false });
    const { status, body } = await setCancel(false);
    expect(status).toBe(400);
    expect(body.message).toMatch(/banned or muted/);
    expect(writes).toEqual([]);
  });

  it('re-sync is refused (409) when the Buzz membership changed after the confirm was decided', async () => {
    grantRow.path = 'grant:user.membership.extend';
    fakeStripe();
    dbMock.dbWrite.customerSubscription.findFirst
      .mockResolvedValueOnce(BUZZ_MEMBERSHIP)
      .mockResolvedValueOnce({ ...BUZZ_MEMBERSHIP, id: 'buzz_sub_2' });
    const { status } = await resync({ confirmEndBuzzMembership: BUZZ_CONFIRM });
    expect(status).toBe(409);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
  });

  it('re-sync takes the member lock: another change in progress is refused (409)', async () => {
    grantRow.path = 'grant:user.membership.extend';
    fakeStripe();
    redisMock.sysRedis.set.mockResolvedValue(null as never);
    expect((await resync()).status).toBe(409);
    expect(dbMock.dbWrite.customerSubscription.upsert).not.toHaveBeenCalled();
  });
});

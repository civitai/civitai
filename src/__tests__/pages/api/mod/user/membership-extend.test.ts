import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { Stripe } from 'stripe';
import { dbMock, redisMock, resetSharedMocks, setEnv } from '~/__tests__/mocks';

/**
 * `/api/mod/user/membership-extend` and `-preview`: the moderator app's door to the membership
 * extension. Drives the REAL endpoint, the REAL role-grant check and the REAL extension service, so
 * each refusal here is the rule itself answering through this path. Only the edges are faked: the
 * session, the grant row, Stripe and the side effects after the write.
 */

const NOW = Math.floor(Date.UTC(2026, 10, 3, 12, 0) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 10, 22, 2, 22) / 1000);
const T3 = PERIOD_END + 3 * 86_400;
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

import extendHandler from '~/pages/api/mod/user/membership-extend';
import previewHandler from '~/pages/api/mod/user/membership-extend-preview';

function liveSub(over: Record<string, unknown> = {}) {
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
    latest_invoice: { id: 'in_oct', object: 'invoice', amount_due: 5000, amount_paid: 5000 },
    ...over,
  } as unknown as Stripe.Subscription;
}

/** Stripe as the extension sees it: a trial_end update moves the period and may issue an invoice. */
function fakeStripe(newInvoice: Record<string, unknown> | null = null) {
  const state = structuredClone(liveSub()) as unknown as Record<string, unknown>;
  const updates: Record<string, unknown>[] = [];
  const stripe = {
    subscriptions: {
      retrieve: vi.fn(async () => structuredClone(state)),
      update: vi.fn(async (_id: string, params: Record<string, unknown>) => {
        updates.push(params);
        if ('trial_end' in params) {
          state.trial_end = params.trial_end;
          state.current_period_end = params.trial_end;
          state.status = 'trialing';
          if (newInvoice) state.latest_invoice = newInvoice;
        }
        return structuredClone(state);
      }),
    },
    customers: {
      retrieve: vi.fn(async () => ({ id: 'cus_case', metadata: { userId: String(MEMBER) } })),
    },
    invoiceItems: { list: vi.fn(async () => ({ data: [] })) },
  };
  stripeRef.current = stripe;
  return { stripe, updates };
}

function call(
  handler: typeof extendHandler,
  method: 'GET' | 'POST',
  input: Record<string, unknown>
) {
  const req = {
    method,
    headers: {},
    body: method === 'POST' ? input : {},
    query: method === 'GET' ? input : {},
  } as unknown as Parameters<typeof handler>[0];
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
  } as unknown as Parameters<typeof handler>[1];
  return Promise.resolve(handler(req, res)).then(() => ({
    status,
    body: body as Record<string, unknown>,
  }));
}

const EXTEND = {
  userId: MEMBER,
  days: 3,
  reason: 'Support case 123: 3 days instead of a refund',
  expectedCurrentPeriodEnd: PERIOD_END,
};
const extend = (over: Record<string, unknown> = {}) =>
  call(extendHandler, 'POST', { ...EXTEND, ...over });
const preview = (over: Record<string, unknown> = {}) =>
  call(previewHandler, 'GET', { userId: String(MEMBER), days: '3', ...over });

const asModerator = (roles: string[], id = MOD) => {
  session.user = { id, isModerator: true, roles, permissions: [], bannedAt: null };
};

beforeEach(() => {
  resetSharedMocks();
  vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
  trackModActivity.mockClear();
  setEnv({ STRIPE_SECRET_KEY: 'sk_live_00000000000000000000' });
  grantRow.path = 'grant:user.membership.extend';
  grantRow.roles = [GRANTED_ROLE];
  asModerator([GRANTED_ROLE]);
  redisMock.sysRedis.set.mockResolvedValue('OK');
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  dbMock.dbWrite.customerSubscription.findUnique.mockResolvedValue({
    id: SUB_ID,
    product: { provider: 'Stripe' },
  });
  dbMock.dbWrite.user.findUnique.mockResolvedValue({ customerId: 'cus_case', isModerator: false });
  dbMock.dbWrite.modActivity.count.mockResolvedValue(0);
});

describe('the grant is held by roles', () => {
  it('control: a moderator in a granted role extends; the actor is the session', async () => {
    const { stripe } = fakeStripe();
    const { status, body } = await extend();
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, trialEnd: new Date(T3 * 1000).toISOString() });
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(trackModActivity).toHaveBeenCalledWith(MOD, {
      entityType: 'user',
      entityId: MEMBER,
      activity: 'extendMembership',
    });
  });

  it('a moderator whose role is not on the grant is refused (403), and Stripe is never read', async () => {
    const { stripe } = fakeStripe();
    asModerator(['moderator:mod-medium-access']);
    const { status, body } = await extend();
    expect(status).toBe(403);
    expect(body.message).toMatch(/user\.membership\.extend/);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('the old per-user permission opens nothing: no role, `membershipExtend` in permissions, refused', async () => {
    const { stripe } = fakeStripe();
    session.user = { ...session.user, roles: [], permissions: ['membershipExtend'] };
    expect((await extend()).status).toBe(403);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('the preview is held to the same grant', async () => {
    const { stripe } = fakeStripe();
    asModerator(['moderator:mod-medium-access']);
    expect((await preview()).status).toBe(403);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    asModerator([GRANTED_ROLE]);
    const ok = await preview();
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ problems: [], expectedCurrentPeriodEnd: PERIOD_END });
  });

  it('a mutating GET is refused (405): extend is POST only', async () => {
    const { stripe } = fakeStripe();
    expect((await call(extendHandler, 'GET', EXTEND)).status).toBe(405);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('the money rules, through this endpoint', () => {
  it.each([0, 32, 1.5])('days %s is refused (400) with nothing written', async (days) => {
    const { stripe } = fakeStripe();
    expect((await extend({ days })).status).toBe(400);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('control: 31 days, the most allowed, goes through', async () => {
    const { updates } = fakeStripe();
    expect((await extend({ days: 31 })).status).toBe(200);
    expect(updates[0]).toMatchObject({ trial_end: PERIOD_END + 31 * 86_400 });
  });

  it('extending your own membership is refused (403), whatever the body claims about the actor', async () => {
    const { stripe } = fakeStripe();
    asModerator([GRANTED_ROLE], MEMBER);
    expect((await extend({ actorId: MOD })).status).toBe(403);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('a stale preview (moved current_period_end) is refused (409), nothing written, no cooldown row', async () => {
    const { stripe } = fakeStripe();
    const { status } = await extend({ expectedCurrentPeriodEnd: PERIOD_END - 86_400 });
    expect(status).toBe(409);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  it('a status other than active or trialing is refused (400)', async () => {
    const { stripe } = fakeStripe();
    stripe.subscriptions.retrieve.mockResolvedValue(
      structuredClone(liveSub({ status: 'past_due' })) as never
    );
    const { status, body } = await extend();
    expect(status).toBe(400);
    expect(body.message).toMatch(/not active or trialing/);
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('the write charges nothing now: trial_end with no proration, so Stripe bills a $0 invoice', async () => {
    const { updates } = fakeStripe({ id: 'in_zero', amount_due: 0, amount_paid: 0 });
    const { body } = await extend();
    expect(updates[0]).toMatchObject({ trial_end: T3, proration_behavior: 'none' });
    expect(body).toMatchObject({ ok: true, newInvoiceId: 'in_zero' });
  });

  it('an invoice with money on it comes back ok: false, so the panel says to check Stripe', async () => {
    fakeStripe({ id: 'in_charged', amount_due: 5000, amount_paid: 5000 });
    const { status, body } = await extend();
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(String(body.problems)).toMatch(/in_charged with money due or paid/);
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as PaddleService from '~/server/services/paddle.service';
import type * as EmailTemplates from '~/server/email/templates';
import type * as MeiliUtil from '~/server/meilisearch/util';
import type * as HatSync from '~/server/events/points/sync';

/**
 * `charge.refunded` and the `charge.dispute.*` events, delivered to the real webhook handler with the
 * real referral, App Blocks attribution, membership gift and ban services behind it. The database is
 * an in-memory store those services read and write through `dbWrite`/`dbRead`, so a second delivery
 * sees what the first left. Event payloads are shaped as Stripe sends them on API version
 * 2022-11-15, the version `getServerStripe` pins.
 */

const mockDbWrite = dbMock.dbWrite;
const mockDbRead = dbMock.dbRead;

const { mockStripe, ledger, banSideEffects } = vi.hoisted(() => ({
  mockStripe: {
    webhooks: { constructEvent: vi.fn() },
    paymentIntents: { retrieve: vi.fn() },
    subscriptions: { retrieve: vi.fn(), del: vi.fn(), deleteDiscount: vi.fn() },
    coupons: { del: vi.fn() },
  },
  // Stands in for the Buzz ledger: it refuses a debit the account cannot cover and a repeated
  // externalTransactionId, as the real service does.
  ledger: {
    balances: new Map<number, number>(),
    externalIds: new Set<string>(),
    debits: [] as { fromAccountId: number; amount: number; externalTransactionId: string }[],
  },
  banSideEffects: {
    sendModerationEmail: vi.fn(async (..._a: unknown[]) => undefined),
    removeUserContent: vi.fn(async (..._a: unknown[]) => undefined),
    invalidateSession: vi.fn(async (..._a: unknown[]) => undefined),
  },
}));

vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: vi.fn().mockResolvedValue(mockStripe),
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  trackWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/stripe.service', () => ({
  manageCheckoutPayment: vi.fn(),
  manageInvoicePaid: vi.fn(),
  toDateTime: vi.fn(),
  upsertPriceRecord: vi.fn(),
  upsertProductRecord: vi.fn(),
  upsertSubscription: vi.fn(),
  cancelSubscription: vi.fn(async () => undefined),
  reinstateSubscription: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  syncFreshdeskMembership: vi.fn(),
  deliverMonthlyCosmetics: vi.fn(),
  getPlans: vi.fn(),
}));
vi.mock('~/server/services/paddle.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaddleService>()),
  cancelSubscriptionPlan: vi.fn(async () => undefined),
}));
vi.mock('~/server/email/templates', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailTemplates>()),
  moderationActionEmail: { send: banSideEffects.sendModerationEmail },
}));
vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  removeUserContentFromSearchIndex: banSideEffects.removeUserContent,
}));
vi.mock('~/server/events/points/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof HatSync>()),
  syncOwnerEventHats: vi.fn(),
}));
vi.mock('~/server/events/points/roster-sync', () => ({ syncEventRosterMember: vi.fn() }));
vi.mock('~/server/services/integration.service', () => ({ notifyAir: vi.fn() }));
vi.mock('~/server/services/buzz.service', async () => {
  const { BuzzApiError } = await import('@civitai/buzz');
  return {
    completeStripeBuzzTransaction: vi.fn(),
    getUserBuzzAccount: vi.fn(async ({ accountId }: { accountId: number }) => [
      { id: accountId, balance: ledger.balances.get(accountId) ?? 0, accountType: 'blue' },
    ]),
    createBuzzTransaction: vi.fn(
      async (tx: { fromAccountId: number; amount: number; externalTransactionId: string }) => {
        if (ledger.externalIds.has(tx.externalTransactionId)) {
          throw new BuzzApiError(409, 'Conflict');
        }
        const balance = ledger.balances.get(tx.fromAccountId) ?? 0;
        if (balance < tx.amount) throw new Error('Insufficient funds');
        ledger.balances.set(tx.fromAccountId, balance - tx.amount);
        ledger.externalIds.add(tx.externalTransactionId);
        ledger.debits.push(tx);
        return { transactionId: tx.externalTransactionId };
      }
    ),
  };
});
vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
  invalidateSession: banSideEffects.invalidateSession,
}));

import handler from '~/pages/api/webhooks/stripe';

type Reward = {
  id: number;
  userId: number;
  refereeId: number | null;
  kind: string;
  status: string;
  buzzAmount: number;
  sourceEventId: string;
};
type BuzzAttribution = {
  id: string;
  paymentTransactionId: string;
  appBlockId: string;
  status: string;
  entryType: string;
  appOwnerShareCents: number;
};
type SubscriptionAttribution = { invoiceId: string; entryType: string; status: string };

const REFERRER = 10;
const REFEREE = 20;
const GIFTER = 30;
const CUSTOMERS: Record<string, string> = {
  pi_gift: 'cus_gifter',
  pi_buzz: 'cus_referee',
  pi_membership: 'cus_referee',
};

type User = {
  id: number;
  customerId: string | null;
  bannedAt: Date | null;
  isModerator: boolean;
  meta: Record<string, unknown>;
  username: string;
  email: string | null;
};
let users: Map<number, User>;
let replicaLag: Map<number, User>;

let rewards: Reward[];
let referral: { id: number; userId: number; paidMonthCount: number; firstPaidAt: Date | null };
let buzzAttributions: BuzzAttribution[];
let subscriptionAttributions: SubscriptionAttribution[];
let gift: Record<string, unknown> | null;

const matches = (value: unknown, cond: any) =>
  cond === undefined ||
  (cond && typeof cond === 'object' && 'in' in cond ? cond.in.includes(value) : value === cond);

function installStore() {
  mockDbWrite.referralReward.findMany.mockImplementation(async ({ where }: any) =>
    rewards.filter(
      (r) =>
        where.OR.some((o: any) => o.sourceEventId === r.sourceEventId) &&
        matches(r.status, where.status)
    )
  );
  mockDbWrite.referralReward.update.mockImplementation(async ({ where, data }: any) => {
    const r = rewards.find((x) => x.id === where.id)!;
    Object.assign(r, data);
    return r;
  });
  mockDbWrite.referralReward.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = rewards.filter((r) => r.id === where.id && matches(r.status, where.status));
    hit.forEach((r) => Object.assign(r, data));
    return { count: hit.length };
  });
  // As Postgres would: rolls the referral rows back when the callback throws, and holds the row
  // lock a raw `FOR UPDATE` read takes until the transaction ends.
  let lockTail = Promise.resolve();
  mockDbWrite.$transaction.mockImplementation(async (fn: any) => {
    const saved = { rewards: structuredClone(rewards), referral: structuredClone(referral) };
    let release: (() => void) | undefined;
    const tx = new Proxy(mockDbWrite, {
      get: (target, key) =>
        key !== '$queryRaw'
          ? (target as any)[key]
          : async (sql: unknown) => {
              if (!release) {
                const held = lockTail;
                lockTail = new Promise<void>((resolve) => (release = resolve));
                await held;
              }
              return mockDbWrite.$queryRaw(sql);
            },
    });
    try {
      return await fn(tx);
    } catch (err) {
      rewards.splice(0, rewards.length, ...saved.rewards);
      Object.assign(referral, saved.referral);
      throw err;
    } finally {
      release?.();
    }
  });
  mockDbWrite.$queryRaw.mockImplementation(async (sql: { values: unknown[] }) =>
    sql.values[0] === referral.userId ? [{ ...referral }] : []
  );
  mockDbWrite.userReferral.update.mockImplementation(async ({ data }: any) => {
    referral.paidMonthCount = data.paidMonthCount;
    if (data.firstPaidAt !== undefined) referral.firstPaidAt = data.firstPaidAt;
    return referral;
  });

  mockDbWrite.blockBuzzAttribution.findMany.mockImplementation(async ({ where }: any) =>
    buzzAttributions.filter(
      (a) =>
        a.paymentTransactionId === where.paymentTransactionId && matches(a.status, where.status)
    )
  );
  mockDbWrite.blockBuzzAttribution.create.mockImplementation(async ({ data }: any) => {
    const dup = buzzAttributions.some(
      (a) =>
        a.paymentTransactionId === data.paymentTransactionId && a.appBlockId === data.appBlockId
    );
    if (dup) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    buzzAttributions.push({ ...data });
    return data;
  });
  mockDbWrite.blockBuzzAttribution.updateMany.mockImplementation(async ({ where, data }: any) => {
    const hit = buzzAttributions.filter(
      (a) =>
        a.paymentTransactionId === where.paymentTransactionId && matches(a.status, where.status)
    );
    hit.forEach((a) => Object.assign(a, data));
    return { count: hit.length };
  });
  mockDbWrite.blockSubscriptionAttribution.updateMany.mockImplementation(
    async ({ where, data }: any) => {
      const hit = subscriptionAttributions.filter(
        (a) =>
          a.invoiceId === where.invoiceId &&
          a.entryType === where.entryType &&
          matches(a.status, where.status)
      );
      hit.forEach((a) => Object.assign(a, data));
      return { count: hit.length };
    }
  );

  mockDbWrite.membershipGift.findUnique.mockImplementation(async ({ where }: any) =>
    gift && gift.stripePaymentIntentId === where.stripePaymentIntentId ? gift : null
  );
  mockDbWrite.membershipGift.update.mockImplementation(async ({ data }: any) => {
    Object.assign(gift!, data);
    return gift;
  });

  const findUser = async ({ where }: any) =>
    [...users.values()].find((u) =>
      'customerId' in where ? u.customerId === where.customerId : u.id === where.id
    ) ?? null;
  mockDbWrite.user.findUnique.mockImplementation(findUser);
  // The replica: what it shows can lag the primary.
  mockDbRead.user.findUnique.mockImplementation(
    async (args: any) => replicaLag.get(args.where.id) ?? findUser(args)
  );
  mockDbWrite.user.update.mockImplementation(async ({ where, data }: any) => {
    const u = users.get(where.id)!;
    Object.assign(u, data);
    return u;
  });
  mockDbWrite.userLink.deleteMany.mockResolvedValue({ count: 0 });
  mockDbWrite.image.updateMany.mockResolvedValue({ count: 0 });
  mockDbWrite.comment.updateMany.mockResolvedValue({ count: 0 });
  mockDbWrite.commentV2.updateMany.mockResolvedValue({ count: 0 });
}

const seedUser = (id: number, customerId: string | null, overrides: Partial<User> = {}) =>
  users.set(id, {
    id,
    customerId,
    bannedAt: null,
    isModerator: false,
    meta: {},
    username: `user${id}`,
    email: `user${id}@example.com`,
    ...overrides,
  });

// A one-off Buzz purchase: a Settled kickback to the referrer and an App Blocks attribution row
// whose publisher share was already paid out.
function seedBuzzPurchase(pi = 'pi_buzz') {
  rewards.push({
    id: 1,
    userId: REFERRER,
    refereeId: REFEREE,
    kind: 'BuzzKickback',
    status: 'Settled',
    buzzAmount: 250,
    sourceEventId: pi,
  });
  buzzAttributions.push({
    id: 'bba_1',
    paymentTransactionId: pi,
    appBlockId: 'blk_1',
    status: 'paid_out',
    entryType: 'purchase',
    appOwnerShareCents: 300,
  });
  ledger.balances.set(REFERRER, 1000);
}

function seedGift(pi = 'pi_gift') {
  gift = {
    id: 'gift_1',
    holderId: REFEREE,
    status: 'Pending',
    stripePaymentIntentId: pi,
    armedCouponId: null,
    stripeSubscriptionId: null,
    stripeCouponId: null,
  };
}

// A referee's first membership invoice: the referrer's token reward, the referee's welcome bonus
// (settled at once) and a membership attribution row, all keyed on the invoice.
function seedMembershipInvoice(invoice = 'in_1') {
  rewards.push(
    {
      id: 2,
      userId: REFERRER,
      refereeId: REFEREE,
      kind: 'MembershipToken',
      status: 'Pending',
      buzzAmount: 0,
      sourceEventId: invoice,
    },
    {
      id: 3,
      userId: REFEREE,
      refereeId: null,
      kind: 'RefereeBonus',
      status: 'Settled',
      buzzAmount: 100,
      sourceEventId: `referee-bonus:${invoice}`,
    }
  );
  referral.paidMonthCount = 1;
  referral.firstPaidAt = new Date('2026-09-01');
  subscriptionAttributions.push({ invoiceId: invoice, entryType: 'charge', status: 'tracked' });
  ledger.balances.set(REFEREE, 1000);
}

const charge = (pi: string, amount: number, amountRefunded: number) => ({
  id: `ch_${pi}`,
  object: 'charge',
  amount,
  amount_captured: amount,
  amount_refunded: amountRefunded,
  refunded: amountRefunded === amount,
  captured: true,
  paid: true,
  disputed: false,
  status: 'succeeded',
  currency: 'usd',
  livemode: true,
  payment_intent: pi,
  invoice: null,
});

const dispute = (pi: string | null, amount: number, status = 'needs_response') => ({
  id: `dp_${pi}`,
  object: 'dispute',
  amount,
  charge: `ch_${pi}`,
  payment_intent: pi,
  currency: 'usd',
  reason: 'fraudulent',
  status,
  is_charge_refundable: false,
  livemode: true,
});

async function deliver(type: string, object: unknown, eventId = `evt_${type}`) {
  mockStripe.webhooks.constructEvent.mockReturnValue({
    id: eventId,
    object: 'event',
    api_version: '2022-11-15',
    type,
    created: 0,
    livemode: true,
    data: { object },
  });
  const req = Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST',
    headers: { 'stripe-signature': 'sig' },
  });
  const res = {
    statusCode: 200,
    status: vi.fn(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    end: vi.fn(),
  };
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

const rewardStatus = (id: number) => rewards.find((r) => r.id === id)?.status;
const clawbacks = () => buzzAttributions.filter((a) => a.entryType === 'clawback');

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
  rewards = [];
  referral = { id: 1, userId: REFEREE, paidMonthCount: 0, firstPaidAt: null };
  buzzAttributions = [];
  subscriptionAttributions = [];
  gift = null;
  users = new Map();
  replicaLag = new Map();
  seedUser(REFERRER, 'cus_referrer');
  seedUser(REFEREE, 'cus_referee');
  seedUser(GIFTER, 'cus_gifter');
  ledger.balances.clear();
  ledger.externalIds.clear();
  ledger.debits.length = 0;
  installStore();
  mockStripe.paymentIntents.retrieve.mockImplementation(async (id: string) => ({
    id,
    object: 'payment_intent',
    invoice: id === 'pi_membership' ? 'in_1' : null,
    customer: CUSTOMERS[id] ?? null,
  }));
});

const banOf = (id: number) => users.get(id)!.meta.banDetails;
const disputeBanLogs = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([data]) => data as Record<string, unknown>)
    .filter((data) => data.stage === 'dispute-ban');

describe('stripe webhook: charge.refunded', () => {
  it('revokes a Buzz purchase on a full refund', async () => {
    seedBuzzPurchase();

    const res = await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));

    expect(res.statusCode).toBe(200);
    expect(rewardStatus(1)).toBe('Revoked');
    expect(ledger.debits).toEqual([
      expect.objectContaining({ fromAccountId: REFERRER, amount: 250 }),
    ]);
    expect(buzzAttributions.find((a) => a.id === 'bba_1')?.status).toBe('voided');
    expect(clawbacks().map((c) => c.appOwnerShareCents)).toEqual([-300]);
  });

  it('marks a gift Refunded on a full refund', async () => {
    seedGift();

    await deliver('charge.refunded', charge('pi_gift', 5000, 5000));

    expect(gift?.status).toBe('Refunded');
  });

  // A partial refund is a support decision about part of a payment; it is not a refund of the
  // purchase, so the rewards, attribution and gift it paid for stand.
  it('revokes nothing on a partial refund', async () => {
    seedBuzzPurchase();
    seedGift('pi_buzz');

    const res = await deliver('charge.refunded', charge('pi_buzz', 5000, 1000));

    expect(res.statusCode).toBe(200);
    expect(rewardStatus(1)).toBe('Settled');
    expect(ledger.debits).toEqual([]);
    expect(clawbacks()).toEqual([]);
    expect(buzzAttributions.find((a) => a.id === 'bba_1')?.status).toBe('paid_out');
    expect(gift?.status).toBe('Pending');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'partial-refund', paymentIntentId: 'pi_buzz' }),
      'webhooks'
    );
  });

  it('revokes when a later partial refund completes the refund', async () => {
    seedBuzzPurchase();

    await deliver('charge.refunded', charge('pi_buzz', 5000, 1000), 'evt_partial_1');
    expect(rewardStatus(1)).toBe('Settled');

    await deliver('charge.refunded', charge('pi_buzz', 5000, 5000), 'evt_partial_2');
    expect(rewardStatus(1)).toBe('Revoked');
    expect(ledger.debits).toHaveLength(1);
    expect(clawbacks()).toHaveLength(1);
  });

  it('revokes a membership invoice payment through the invoice the PaymentIntent names', async () => {
    seedMembershipInvoice('in_1');

    await deliver('charge.refunded', charge('pi_membership', 2500, 2500));

    expect(rewardStatus(2)).toBe('Revoked');
    expect(rewardStatus(3)).toBe('Revoked');
    expect(ledger.debits).toEqual([
      expect.objectContaining({ fromAccountId: REFEREE, amount: 100 }),
    ]);
    expect(referral).toMatchObject({ paidMonthCount: 0, firstPaidAt: null });
    expect(subscriptionAttributions[0].status).toBe('voided');
  });

  // Stripe redelivers an event that did not get a 2xx, for up to three days. A 200 after a failed
  // step tells Stripe the event is handled, and what that step missed is never revisited.
  it('runs the other steps when the PaymentIntent lookup fails, asks Stripe to retry, and completes on the retry', async () => {
    seedBuzzPurchase('pi_membership');
    seedMembershipInvoice('in_1');
    mockStripe.paymentIntents.retrieve.mockRejectedValueOnce(new Error('api down'));

    const first = await deliver('charge.refunded', charge('pi_membership', 2500, 2500));
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(rewardStatus(1)).toBe('Revoked');
    expect(rewardStatus(2)).toBe('Pending');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'refund-payment-intent-lookup',
        paymentIntentId: 'pi_membership',
      }),
      'webhooks'
    );

    const retry = await deliver('charge.refunded', charge('pi_membership', 2500, 2500));
    expect(retry.statusCode).toBe(200);
    expect(rewardStatus(2)).toBe('Revoked');
    expect(subscriptionAttributions[0].status).toBe('voided');
    expect(ledger.debits.map((d) => d.fromAccountId).sort()).toEqual([REFERRER, REFEREE]);
    expect(clawbacks()).toHaveLength(1);
  });

  it('runs the other steps when a revoke fails, asks Stripe to retry, and the retry doubles nothing', async () => {
    seedBuzzPurchase();
    seedGift('pi_buzz');
    mockDbWrite.referralReward.findMany.mockRejectedValueOnce(new Error('db unavailable'));

    const first = await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(rewardStatus(1)).toBe('Settled');
    expect(gift?.status).toBe('Refunded');
    expect(clawbacks()).toHaveLength(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'referral-revoke', paymentIntentId: 'pi_buzz' }),
      'webhooks'
    );

    const retry = await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));
    expect(retry.statusCode).toBe(200);
    expect(rewardStatus(1)).toBe('Revoked');
    expect(ledger.debits).toHaveLength(1);
    expect(clawbacks()).toHaveLength(1);
  });
});

describe('stripe webhook: disputes', () => {
  // A dispute can still be won, and nothing reinstates what a revoke took.
  it('revokes and bans nothing when a dispute is opened', async () => {
    seedBuzzPurchase('pi_gift');
    seedGift('pi_gift');

    const res = await deliver('charge.dispute.created', dispute('pi_gift', 5000));

    expect(res.statusCode).toBe(200);
    expect(gift?.status).toBe('Pending');
    expect(rewardStatus(1)).toBe('Settled');
    expect(ledger.debits).toEqual([]);
    expect(users.get(GIFTER)?.bannedAt).toBeNull();
  });

  it.each(['won', 'warning_closed'])(
    'revokes and bans nothing when a dispute closes %s',
    async (status) => {
      seedBuzzPurchase('pi_gift');
      seedGift('pi_gift');

      const res = await deliver('charge.dispute.closed', dispute('pi_gift', 5000, status));

      expect(res.statusCode).toBe(200);
      expect(gift?.status).toBe('Pending');
      expect(rewardStatus(1)).toBe('Settled');
      expect(clawbacks()).toEqual([]);
      expect(users.get(GIFTER)?.bannedAt).toBeNull();
    }
  );

  it('revokes a gift and a Buzz purchase when a dispute is lost', async () => {
    seedBuzzPurchase('pi_gift');
    seedGift('pi_gift');

    const res = await deliver('charge.dispute.closed', dispute('pi_gift', 5000, 'lost'));

    expect(res.statusCode).toBe(200);
    expect(gift?.status).toBe('Revoked');
    expect(rewards[0]).toMatchObject({
      status: 'Revoked',
      revokedReason: 'charge.dispute.closed',
    });
    expect(ledger.debits).toHaveLength(1);
    expect(clawbacks()).toHaveLength(1);
  });

  // The ban goes through toggleBan as the system user, like the moderation ban webhook.
  it('bans the payer of a lost dispute, the gifter rather than the recipient', async () => {
    seedGift('pi_gift');

    const res = await deliver('charge.dispute.closed', dispute('pi_gift', 5000, 'lost'));

    expect(res.statusCode).toBe(200);
    expect(users.get(GIFTER)?.bannedAt).toBeInstanceOf(Date);
    expect(banOf(GIFTER)).toEqual({
      reasonCode: 'Chargeback',
      detailsInternal: 'Stripe dispute dp_pi_gift lost',
      detailsExternal: 'A payment on this account was reversed.',
    });
    expect(users.get(REFEREE)?.bannedAt).toBeNull();
    expect(banSideEffects.invalidateSession).toHaveBeenCalledWith(GIFTER, 'ban');
    expect(banSideEffects.sendModerationEmail).toHaveBeenCalledTimes(1);
    expect(disputeBanLogs()).toEqual([
      expect.objectContaining({ userId: GIFTER, disputeId: 'dp_pi_gift', outcome: 'banned' }),
    ]);
  });

  it("removes none of the payer's models, media, comments or profile links", async () => {
    await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'));

    expect(users.get(REFEREE)?.bannedAt).toBeInstanceOf(Date);
    expect(mockDbWrite.userLink.deleteMany).not.toHaveBeenCalled();
    expect(mockDbRead.model.findMany).not.toHaveBeenCalled();
    expect(mockDbWrite.image.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.comment.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.commentV2.updateMany).not.toHaveBeenCalled();
  });

  // toggleBan flips the ban: called on a banned account it would lift the ban.
  it('leaves an existing ban exactly as it was', async () => {
    const bannedAt = new Date('2026-01-01');
    const banDetails = { reasonCode: 'Harassment', detailsInternal: 'earlier ban' };
    seedUser(REFEREE, 'cus_referee', { bannedAt, meta: { banDetails } });

    const res = await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'));

    expect(res.statusCode).toBe(200);
    expect(users.get(REFEREE)).toMatchObject({ bannedAt, meta: { banDetails } });
    expect(mockDbWrite.user.update).not.toHaveBeenCalled();
    expect(disputeBanLogs()).toEqual([
      expect.objectContaining({ userId: REFEREE, outcome: 'already-banned' }),
    ]);
  });

  it('bans once when Stripe delivers a lost dispute twice', async () => {
    await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'), 'evt_same');
    const firstBan = users.get(REFEREE)?.bannedAt;
    await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'), 'evt_same');

    expect(users.get(REFEREE)?.bannedAt).toBe(firstBan);
    expect(mockDbWrite.user.update).toHaveBeenCalledTimes(1);
    expect(disputeBanLogs().map((l) => l.outcome)).toEqual(['banned', 'already-banned']);
  });

  it('does not ban a moderator, and logs it for support', async () => {
    seedUser(REFEREE, 'cus_referee', { isModerator: true });

    await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'));

    expect(users.get(REFEREE)?.bannedAt).toBeNull();
    expect(disputeBanLogs()).toEqual([
      expect.objectContaining({
        type: 'warning',
        disputeId: 'dp_pi_buzz',
        outcome: 'skipped-moderator',
      }),
    ]);
  });

  it('still revokes, and answers 200, when no user matches the payer', async () => {
    seedBuzzPurchase('pi_unknown');

    const res = await deliver('charge.dispute.closed', dispute('pi_unknown', 5000, 'lost'));

    expect(res.statusCode).toBe(200);
    expect(rewardStatus(1)).toBe('Revoked');
    expect(disputeBanLogs()).toEqual([expect.objectContaining({ outcome: 'no-user' })]);
  });

  it('still revokes when the ban fails, asks Stripe to retry, and bans on the retry', async () => {
    seedBuzzPurchase();
    mockDbWrite.user.update.mockRejectedValueOnce(new Error('db unavailable'));

    const first = await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'));

    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(rewardStatus(1)).toBe('Revoked');
    expect(users.get(REFEREE)?.bannedAt).toBeNull();
    expect(disputeBanLogs()).toEqual([
      expect.objectContaining({ userId: REFEREE, outcome: 'failed' }),
    ]);

    const retry = await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'));

    expect(retry.statusCode).toBe(200);
    expect(users.get(REFEREE)?.bannedAt).toBeInstanceOf(Date);
    expect(ledger.debits).toHaveLength(1);
    expect(clawbacks()).toHaveLength(1);
  });

  // toggleBan decides ban or unban from what it reads; a replica that has not yet seen a moderator's
  // unban would turn this ban into a second unban.
  it('bans even when the replica still shows a lifted ban', async () => {
    replicaLag.set(REFEREE, {
      ...users.get(REFEREE)!,
      bannedAt: new Date('2026-01-01'),
      meta: { banDetails: { reasonCode: 'Other' } },
    });

    await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'));

    expect(users.get(REFEREE)?.bannedAt).toBeInstanceOf(Date);
    expect(banOf(REFEREE)).toMatchObject({ reasonCode: 'Chargeback' });
  });

  it('never lifts a ban a moderator places while the dispute is being handled', async () => {
    const moderatorBan = { reasonCode: 'Harassment', detailsInternal: 'moderator ban' };
    const read = mockDbWrite.user.findUnique.getMockImplementation()!;
    mockDbWrite.user.findUnique.mockImplementation(async (args: any) => {
      const found = await read(args);
      const result = found && { ...found };
      // Lands just after the webhook's own check, before the ban is written.
      if (args.select?.isModerator) {
        Object.assign(users.get(REFEREE)!, {
          bannedAt: new Date('2026-01-01'),
          meta: { banDetails: moderatorBan },
        });
      }
      return result;
    });

    const res = await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'));

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(users.get(REFEREE)).toMatchObject({ meta: { banDetails: moderatorBan } });
    expect(users.get(REFEREE)?.bannedAt).toBeInstanceOf(Date);
  });

  it('claws back once when a refunded payment is later lost in a dispute', async () => {
    seedBuzzPurchase('pi_gift');
    seedGift('pi_gift');

    await deliver('charge.refunded', charge('pi_gift', 5000, 5000));
    await deliver('charge.dispute.closed', dispute('pi_gift', 5000, 'lost'));

    expect(gift?.status).toBe('Refunded');
    expect(ledger.debits).toHaveLength(1);
    expect(clawbacks()).toHaveLength(1);
  });

  it('claws back once when Stripe delivers the same event twice', async () => {
    seedBuzzPurchase();
    seedMembershipInvoice('in_1');
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_buzz',
      object: 'payment_intent',
      invoice: 'in_1',
      customer: 'cus_referee',
    });
    referral.paidMonthCount = 2;

    await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'), 'evt_same');
    await deliver('charge.dispute.closed', dispute('pi_buzz', 5000, 'lost'), 'evt_same');

    expect(ledger.debits).toHaveLength(2);
    expect(clawbacks()).toHaveLength(1);
    expect(referral.paidMonthCount).toBe(1);
  });
});

describe('referral clawback from a spent balance', () => {
  it('takes what the balance covers and logs the shortfall', async () => {
    seedBuzzPurchase();
    ledger.balances.set(REFERRER, 100);

    await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));

    expect(ledger.debits).toEqual([
      expect.objectContaining({ fromAccountId: REFERRER, amount: 100 }),
    ]);
    expect(rewardStatus(1)).toBe('Revoked');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'referral-clawback-shortfall',
        rewardId: 1,
        userId: REFERRER,
        owed: 250,
        taken: 100,
      })
    );
  });

  it('logs the whole amount as a shortfall from an empty balance', async () => {
    seedBuzzPurchase();
    ledger.balances.set(REFERRER, 0);

    await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));

    expect(ledger.debits).toEqual([]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'referral-clawback-shortfall', owed: 250, taken: 0 })
    );
  });
});

describe('referral revoke under retries and duplicate deliveries', () => {
  // The paid-month decrement commits with the reward's revoke, so a failure between them cannot
  // leave the reward revoked and the decrement lost to every retry.
  it('keeps the paid-month decrement when a revoke fails part way and is retried', async () => {
    seedMembershipInvoice('in_1');
    referral.paidMonthCount = 2;
    mockDbWrite.$queryRaw.mockRejectedValueOnce(new Error('lock timeout'));

    const first = await deliver('charge.refunded', charge('pi_membership', 2500, 2500));
    expect(first.statusCode).toBeGreaterThanOrEqual(400);

    const retry = await deliver('charge.refunded', charge('pi_membership', 2500, 2500));
    expect(retry.statusCode).toBe(200);
    expect(rewardStatus(2)).toBe('Revoked');
    expect(referral.paidMonthCount).toBe(1);
  });

  it('retries a clawback the ledger could not take, instead of revoking without it', async () => {
    seedBuzzPurchase();
    const { getUserBuzzAccount } = await import('~/server/services/buzz.service');
    vi.mocked(getUserBuzzAccount).mockRejectedValueOnce(new Error('buzz service down'));

    const first = await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(rewardStatus(1)).toBe('Settled');

    await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));
    expect(rewardStatus(1)).toBe('Revoked');
    expect(ledger.debits).toEqual([
      expect.objectContaining({ fromAccountId: REFERRER, amount: 250 }),
    ]);
  });

  it('completes on a retry after the clawback was taken but the revoke failed', async () => {
    seedBuzzPurchase();
    mockDbWrite.referralReward.updateMany.mockRejectedValueOnce(new Error('db unavailable'));

    const first = await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(ledger.debits).toHaveLength(1);

    const retry = await deliver('charge.refunded', charge('pi_buzz', 5000, 5000));
    expect(retry.statusCode).toBe(200);
    expect(rewardStatus(1)).toBe('Revoked');
    expect(ledger.debits).toHaveLength(1);
  });

  it('revokes once when two deliveries of the same event run at the same time', async () => {
    seedBuzzPurchase();
    seedMembershipInvoice('in_1');
    referral.paidMonthCount = 2;
    mockStripe.paymentIntents.retrieve.mockResolvedValue({
      id: 'pi_buzz',
      object: 'payment_intent',
      invoice: 'in_1',
      customer: 'cus_referee',
    });

    // Both deliveries read the membership rewards before either revokes them.
    const read = mockDbWrite.referralReward.findMany.getMockImplementation()!;
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    mockDbWrite.referralReward.findMany.mockImplementation(async (args: any) => {
      const rows = (await read(args)).map((r: Reward) => ({ ...r }));
      if (args.where.OR[0].sourceEventId !== 'in_1') return rows;
      if (++arrived === 2) release();
      await bothRead;
      return rows;
    });

    await Promise.all([
      deliver('charge.refunded', charge('pi_buzz', 5000, 5000)),
      deliver('charge.refunded', charge('pi_buzz', 5000, 5000)),
    ]);

    expect(arrived).toBe(2);

    expect(referral.paidMonthCount).toBe(1);
    expect(ledger.debits).toHaveLength(2);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'referral-clawback-shortfall' })
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W3 flow C — MEMBERSHIP / subscription attribution service coverage. The
 * interesting surface is:
 *   - server-derived three-way split (fee + platform + author = gross) per
 *     the active subscription rate card
 *   - self-purchase wash (subscriber == owner → voided + 0 share)
 *   - internal-owner wash (owner ∈ internalAppOwnerUserIds)
 *   - idempotency via the (invoice_id, app_block_id) UNIQUE (P2002)
 *   - RENEWALS-PAY: a second invoice on the same subscription → a 2nd row
 *   - missing-app guard
 *   - clawback on refund of a paid_out period (negative carry-forward) +
 *     no-clawback for pending/confirmed refunds + clawback dedup
 *
 * Prisma + logger are mocked at the module boundary so the test stays
 * in-process and deterministic.
 */

class FakePrismaKnownError extends Error {
  code: string;
  clientVersion: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.clientVersion = 'test';
  }
}

const { mockDbRead, mockDbWrite, mockLog } = vi.hoisted(() => ({
  mockDbRead: {
    oauthClient: { findUnique: vi.fn() },
    blockSubscriptionAttribution: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    blockSubscriptionAttribution: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
  mockLog: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));

import {
  AttributionAppMissingError,
  recordSubscriptionAttribution,
  voidSubscriptionAttributionsForInvoice,
  type RecordSubscriptionAttributionInput,
} from '../buzz-attribution.service';
import { ACTIVE_RATE_CARD, computeSubscriptionShare } from '../rate-card';

const APP_ID = 'app_test';
const APP_BLOCK_ID = 'apb_test';
const APP_OWNER_USER_ID = 999;
const PURCHASER_ID = 100;
const INVOICE_ID = 'in_abc123';
const SUBSCRIPTION_ID = 'sub_xyz';

function fakeInput(
  over: Partial<RecordSubscriptionAttributionInput> = {}
): RecordSubscriptionAttributionInput {
  return {
    userId: PURCHASER_ID,
    buzzAmount: 5000,
    usdAmountCents: 1000, // $10 membership
    providerFeeCents: 50,
    paymentProvider: 'stripe',
    invoiceId: INVOICE_ID,
    subscriptionId: SUBSCRIPTION_ID,
    billingReason: 'subscription_create',
    tier: 'gold',
    attribution: {
      appId: APP_ID,
      appBlockId: APP_BLOCK_ID,
      blockInstanceId: 'bki_test123',
      modelId: 555,
    },
    ...over,
  };
}

function createEchoesData() {
  mockDbWrite.blockSubscriptionAttribution.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: data.id,
      status: data.status,
      appOwnerShareCents: data.appOwnerShareCents,
      platformShareCents: data.platformShareCents,
      providerFeeCents: data.providerFeeCents,
      subscriptionSharePct: data.subscriptionSharePct,
      grossValueCents: data.grossValueCents,
      rateCardVersion: data.rateCardVersion,
      voidedReason: data.voidedReason ?? null,
    })
  );
}

beforeEach(() => {
  mockDbRead.oauthClient.findUnique.mockReset();
  mockDbRead.blockSubscriptionAttribution.findUnique.mockReset();
  mockDbWrite.blockSubscriptionAttribution.create.mockReset();
  mockDbWrite.blockSubscriptionAttribution.findMany.mockReset();
  mockDbWrite.blockSubscriptionAttribution.updateMany.mockReset();
  mockLog.mockReset();
  // Default: app exists, owned by a different user than the purchaser.
  mockDbRead.oauthClient.findUnique.mockResolvedValue({
    id: APP_ID,
    userId: APP_OWNER_USER_ID,
  });
  createEchoesData();
});

describe('recordSubscriptionAttribution', () => {
  it('writes exactly one pending row: author=appBlock owner, three-way split per the active card', async () => {
    const res = await recordSubscriptionAttribution(fakeInput());

    expect(mockDbWrite.blockSubscriptionAttribution.create).toHaveBeenCalledTimes(1);
    expect(res.written).toBe(true);

    const { data } = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0];

    // Author is the appBlock's owning OauthClient user (server-derived).
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(data.grossValueCents).toBe(1000);

    // Shares match the active card's three-way split (gross 1000, fee 50).
    const expected = computeSubscriptionShare({
      grossCents: 1000,
      providerFeeCents: 50,
      isSelfPurchase: false,
      appOwnerUserId: APP_OWNER_USER_ID,
    });
    expect(data.appOwnerShareCents).toBe(expected.appOwnerShareCents);
    expect(data.platformShareCents).toBe(expected.platformShareCents);
    expect(data.providerFeeCents).toBe(expected.providerFeeCents);
    expect(data.subscriptionSharePct).toBe(ACTIVE_RATE_CARD.subscriptionSharePct);

    // Conservation invariant (the SQL CHECK on entry_type='charge'):
    expect(
      data.providerFeeCents + data.platformShareCents + data.appOwnerShareCents
    ).toBe(data.grossValueCents);

    // Forward charge, not voided.
    expect(data.status).toBe('pending');
    expect(data.entryType).toBe('charge');
    expect(data.voidedReason).toBeNull();

    // Server context preserved.
    expect(data.appId).toBe(APP_ID);
    expect(data.appBlockId).toBe(APP_BLOCK_ID);
    expect(data.invoiceId).toBe(INVOICE_ID);
    expect(data.subscriptionId).toBe(SUBSCRIPTION_ID);
    expect(data.scope).toBe('subscription');
    expect(data.billingReason).toBe('subscription_create');
    expect(data.rateCardVersion).toBe(ACTIVE_RATE_CARD.version);
  });

  it('author share floor: share = floor((gross-fee) * pct/100), within [0, net]', async () => {
    await recordSubscriptionAttribution(fakeInput({ usdAmountCents: 1999, providerFeeCents: 87 }));
    const { data } = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0];
    const net = 1999 - 87;
    expect(data.appOwnerShareCents).toBe(
      Math.floor((net * ACTIVE_RATE_CARD.subscriptionSharePct) / 100)
    );
    expect(data.appOwnerShareCents).toBeGreaterThanOrEqual(0);
    expect(data.appOwnerShareCents).toBeLessThanOrEqual(net);
    expect(
      data.providerFeeCents + data.platformShareCents + data.appOwnerShareCents
    ).toBe(1999);
  });

  it('self-purchase (subscriber == app owner) → voided, zero author share', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValue({
      id: APP_ID,
      userId: PURCHASER_ID, // owner == subscriber
    });
    const res = await recordSubscriptionAttribution(fakeInput());
    const { data } = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0];
    expect(data.status).toBe('voided');
    expect(data.voidedReason).toBe('self_purchase');
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.subscriptionSharePct).toBe(0);
    // Conservation still holds: fee + platform + 0 = gross.
    expect(data.providerFeeCents + data.platformShareCents).toBe(data.grossValueCents);
    expect(res.row.status).toBe('voided');
  });

  it('idempotency: a second webhook for the same invoice returns the existing row, no second write', async () => {
    const first = await recordSubscriptionAttribution(fakeInput());
    expect(first.written).toBe(true);

    mockDbWrite.blockSubscriptionAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('dup', 'P2002')
    );
    mockDbRead.blockSubscriptionAttribution.findUnique.mockResolvedValueOnce({
      id: 'bsu_existing',
      status: 'pending',
      appOwnerShareCents: 142,
      platformShareCents: 808,
      providerFeeCents: 50,
      subscriptionSharePct: 15,
      grossValueCents: 1000,
      rateCardVersion: 'v5',
      voidedReason: null,
    });

    const second = await recordSubscriptionAttribution(fakeInput());
    expect(second.written).toBe(false);
    expect(second.row.id).toBe('bsu_existing');

    // Looked up by the (invoice, app) idempotency key.
    expect(mockDbRead.blockSubscriptionAttribution.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { invoiceId_appBlockId: { invoiceId: INVOICE_ID, appBlockId: APP_BLOCK_ID } },
      })
    );
  });

  it('RENEWALS-PAY: a 2nd invoice (subscription_cycle) on the same subscription writes a 2nd row', async () => {
    // First invoice (initial purchase).
    const first = await recordSubscriptionAttribution(
      fakeInput({ invoiceId: 'in_period1', billingReason: 'subscription_create' })
    );
    expect(first.written).toBe(true);

    // Second invoice — DIFFERENT invoice_id (a renewal). Same subscription.
    // Distinct invoice_id → distinct UNIQUE key → a fresh row, NOT a dup.
    const second = await recordSubscriptionAttribution(
      fakeInput({ invoiceId: 'in_period2', billingReason: 'subscription_cycle' })
    );
    expect(second.written).toBe(true);

    // Two writes, one per period.
    expect(mockDbWrite.blockSubscriptionAttribution.create).toHaveBeenCalledTimes(2);
    const firstData = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0].data;
    const secondData = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[1][0].data;
    expect(firstData.invoiceId).toBe('in_period1');
    expect(secondData.invoiceId).toBe('in_period2');
    expect(firstData.subscriptionId).toBe(SUBSCRIPTION_ID);
    expect(secondData.subscriptionId).toBe(SUBSCRIPTION_ID);
    // Both accrue the author share — the renewals-pay policy.
    expect(firstData.appOwnerShareCents).toBeGreaterThan(0);
    expect(secondData.appOwnerShareCents).toBeGreaterThan(0);
    expect(secondData.billingReason).toBe('subscription_cycle');
  });

  it('aborts (throws AttributionAppMissingError) when the app is gone — no orphan row', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValue(null);
    await expect(recordSubscriptionAttribution(fakeInput())).rejects.toBeInstanceOf(
      AttributionAppMissingError
    );
    expect(mockDbWrite.blockSubscriptionAttribution.create).not.toHaveBeenCalled();
  });

  it('re-throws a non-P2002 DB error (real failures are not swallowed as idempotent)', async () => {
    mockDbWrite.blockSubscriptionAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('connection lost', 'P1001')
    );
    await expect(recordSubscriptionAttribution(fakeInput())).rejects.toMatchObject({
      code: 'P1001',
    });
    expect(mockDbRead.blockSubscriptionAttribution.findUnique).not.toHaveBeenCalled();
  });
});

describe('voidSubscriptionAttributionsForInvoice', () => {
  it('refund of a PENDING/CONFIRMED period: voids, NO clawback (money never left)', async () => {
    // No paid_out rows to claw back.
    mockDbWrite.blockSubscriptionAttribution.findMany.mockResolvedValueOnce([]);
    mockDbWrite.blockSubscriptionAttribution.updateMany.mockResolvedValueOnce({ count: 1 });

    const count = await voidSubscriptionAttributionsForInvoice({
      paymentProvider: 'stripe',
      invoiceId: INVOICE_ID,
      reason: 'refund',
    });

    expect(count).toBe(1);
    // No clawback row written.
    expect(mockDbWrite.blockSubscriptionAttribution.create).not.toHaveBeenCalled();
    // The void targets charge rows in pending/confirmed/paid_out.
    expect(mockDbWrite.blockSubscriptionAttribution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentProvider: 'stripe',
          invoiceId: INVOICE_ID,
          entryType: 'charge',
          status: { in: ['pending', 'confirmed', 'paid_out'] },
        }),
        data: expect.objectContaining({ status: 'voided', voidedReason: 'refund' }),
      })
    );
  });

  it('refund of a PAID_OUT period: voids the original AND writes a negative clawback that nets out', async () => {
    mockDbWrite.blockSubscriptionAttribution.findMany.mockResolvedValueOnce([
      {
        appOwnerShareCents: 142,
        appOwnerUserId: APP_OWNER_USER_ID,
        userId: PURCHASER_ID,
        buzzType: 'yellow',
        appId: APP_ID,
        appBlockId: APP_BLOCK_ID,
        blockInstanceId: 'bki_test123',
        scope: 'subscription',
        modelId: 555,
        tier: 'gold',
        subscriptionId: SUBSCRIPTION_ID,
        billingReason: 'subscription_cycle',
        rateCardVersion: 'v5',
        subscriptionSharePct: 15,
      },
    ]);
    mockDbWrite.blockSubscriptionAttribution.updateMany.mockResolvedValueOnce({ count: 1 });

    const count = await voidSubscriptionAttributionsForInvoice({
      paymentProvider: 'stripe',
      invoiceId: INVOICE_ID,
      reason: 'refund',
    });

    expect(count).toBe(1);
    expect(mockDbWrite.blockSubscriptionAttribution.create).toHaveBeenCalledTimes(1);
    const { data } = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0];
    // Negative carry-forward, confirmed so the aggregator nets it next mint.
    expect(data.entryType).toBe('clawback');
    expect(data.status).toBe('confirmed');
    expect(data.appOwnerShareCents).toBe(-142);
    expect(data.grossValueCents).toBe(-142);
    expect(data.platformShareCents).toBe(0);
    expect(data.providerFeeCents).toBe(0);
    // Synthetic invoice id so a repeat refund webhook dedups on the UNIQUE.
    expect(data.invoiceId).toBe(`${INVOICE_ID}:clawback`);
    // Owner snapshot preserved → debt routes to the right publisher.
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);

    // Conservation: original (142) + clawback (-142) = 0 net for the owner.
    expect(142 + data.appOwnerShareCents).toBe(0);
  });

  it('clawback dedup: a second refund webhook hits the synthetic-key UNIQUE and is skipped', async () => {
    mockDbWrite.blockSubscriptionAttribution.findMany.mockResolvedValueOnce([
      {
        appOwnerShareCents: 142,
        appOwnerUserId: APP_OWNER_USER_ID,
        userId: PURCHASER_ID,
        buzzType: 'yellow',
        appId: APP_ID,
        appBlockId: APP_BLOCK_ID,
        blockInstanceId: 'bki_test123',
        scope: 'subscription',
        modelId: null,
        tier: null,
        subscriptionId: SUBSCRIPTION_ID,
        billingReason: 'subscription_cycle',
        rateCardVersion: 'v5',
        subscriptionSharePct: 15,
      },
    ]);
    // The clawback create hits P2002 (already written by a prior webhook).
    mockDbWrite.blockSubscriptionAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('dup clawback', 'P2002')
    );
    mockDbWrite.blockSubscriptionAttribution.updateMany.mockResolvedValueOnce({ count: 0 });

    // Must NOT throw — the duplicate clawback is swallowed.
    const count = await voidSubscriptionAttributionsForInvoice({
      paymentProvider: 'stripe',
      invoiceId: INVOICE_ID,
      reason: 'chargeback',
    });
    expect(count).toBe(0);
    expect(mockDbWrite.blockSubscriptionAttribution.create).toHaveBeenCalledTimes(1);
  });
});

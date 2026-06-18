import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W3 flow C — MEMBERSHIP / subscription attribution service coverage.
 *
 * ⚠️ TRACK-ONLY (#2629). The write records the EVENT + money basis (gross +
 * provider_fee) and DEFERS the share to a payout-time backpay. So the
 * interesting surface is:
 *   - track-only row shape: status='tracked', author_share=0,
 *     subscription_share_pct=0, rate_card_version='unrated', gross+fee
 *     recorded, platform_share=net so conservation still holds (author=0)
 *   - NO rate is applied at write — computeSubscriptionShare is never called
 *     and the author share is 0 regardless of the rate card
 *   - self-purchase wash (subscriber == owner → voided + 0 share)
 *   - internal-owner wash (owner ∈ internalAppOwnerUserIds)
 *   - idempotency via the (invoice_id, app_block_id) UNIQUE (P2002)
 *   - RENEWALS-PAY: a second invoice on the same subscription → a 2nd tracked
 *     row (the backpay later pays each)
 *   - missing-app guard
 *   - refund → the tracked row is VOIDED, no clawback (author=0, no debt)
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

// Spy on computeSubscriptionShare so the track-only contract is testable:
// the write must NEVER call it (the share is deferred to payout). Everything
// else from rate-card stays real.
const computeSubscriptionShareSpy = vi.hoisted(() => vi.fn());
vi.mock('../rate-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rate-card')>();
  return {
    ...actual,
    computeSubscriptionShare: (...args: Parameters<typeof actual.computeSubscriptionShare>) => {
      computeSubscriptionShareSpy(...args);
      return actual.computeSubscriptionShare(...args);
    },
  };
});

import {
  AttributionAppMissingError,
  recordSubscriptionAttribution,
  voidSubscriptionAttributionsForInvoice,
  UNRATED_RATE_CARD_VERSION,
  type RecordSubscriptionAttributionInput,
} from '../buzz-attribution.service';
import { ACTIVE_RATE_CARD } from '../rate-card';

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
  computeSubscriptionShareSpy.mockReset();
  // Default: app exists, owned by a different user than the purchaser.
  mockDbRead.oauthClient.findUnique.mockResolvedValue({
    id: APP_ID,
    userId: APP_OWNER_USER_ID,
  });
  createEchoesData();
});

describe('recordSubscriptionAttribution', () => {
  it('TRACK-ONLY: writes exactly one tracked row — event + gross/fee, author=0, NO rate stamped', async () => {
    const res = await recordSubscriptionAttribution(fakeInput());

    expect(mockDbWrite.blockSubscriptionAttribution.create).toHaveBeenCalledTimes(1);
    expect(res.written).toBe(true);

    const { data } = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0];

    // Author is the appBlock's owning OauthClient user (server-derived).
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);

    // Money BASIS recorded: gross + provider_fee. (gross 1000, fee 50.)
    expect(data.grossValueCents).toBe(1000);
    expect(data.providerFeeCents).toBe(50);

    // NO rate applied at write: author share 0, pct 0, version 'unrated'.
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.subscriptionSharePct).toBe(0);
    expect(data.rateCardVersion).toBe(UNRATED_RATE_CARD_VERSION);
    expect(data.rateCardVersion).not.toBe(ACTIVE_RATE_CARD.version);

    // platform = net (gross - fee) so conservation still holds with author=0.
    expect(data.platformShareCents).toBe(1000 - 50);

    // Conservation invariant (the SQL CHECK on entry_type='charge'):
    // fee + platform + author = gross, with author = 0.
    expect(
      data.providerFeeCents + data.platformShareCents + data.appOwnerShareCents
    ).toBe(data.grossValueCents);

    // Share-pending track-only state, forward charge, not voided.
    expect(data.status).toBe('tracked');
    expect(data.entryType).toBe('charge');
    expect(data.voidedReason).toBeNull();

    // The rate card is NEVER consulted at write time (deferred to payout).
    expect(computeSubscriptionShareSpy).not.toHaveBeenCalled();

    // Server context preserved (the backpay needs it).
    expect(data.appId).toBe(APP_ID);
    expect(data.appBlockId).toBe(APP_BLOCK_ID);
    expect(data.invoiceId).toBe(INVOICE_ID);
    expect(data.subscriptionId).toBe(SUBSCRIPTION_ID);
    expect(data.scope).toBe('subscription');
    expect(data.billingReason).toBe('subscription_create');
  });

  it('records gross/fee basis with author=0 + platform=net for the backpay (conservation holds)', async () => {
    await recordSubscriptionAttribution(fakeInput({ usdAmountCents: 1999, providerFeeCents: 87 }));
    const { data } = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0];
    const net = 1999 - 87;
    // No share computed at write — author 0, platform absorbs all of net.
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.platformShareCents).toBe(net);
    expect(data.providerFeeCents).toBe(87);
    expect(data.grossValueCents).toBe(1999);
    expect(
      data.providerFeeCents + data.platformShareCents + data.appOwnerShareCents
    ).toBe(1999);
    expect(computeSubscriptionShareSpy).not.toHaveBeenCalled();
  });

  it('fee clamped to gross when fee > gross (defensive): author=0, platform=0, still conserves', async () => {
    await recordSubscriptionAttribution(fakeInput({ usdAmountCents: 100, providerFeeCents: 250 }));
    const { data } = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0];
    // fee clamped to gross → net 0 → platform 0, author 0.
    expect(data.grossValueCents).toBe(100);
    expect(data.providerFeeCents).toBe(100);
    expect(data.platformShareCents).toBe(0);
    expect(data.appOwnerShareCents).toBe(0);
    expect(
      data.providerFeeCents + data.platformShareCents + data.appOwnerShareCents
    ).toBe(100);
  });

  it('MUTATION-CHECK: author share is 0 regardless of the active rate card (no rate applied at write)', async () => {
    // Active card defines subscriptionSharePct=15. A track-only write must
    // NOT apply it — author stays 0 even though the rate is non-zero. If the
    // write regressed to applying the 15%, this assertion (and the
    // not-called spy) would fail.
    expect(ACTIVE_RATE_CARD.subscriptionSharePct).toBeGreaterThan(0);
    await recordSubscriptionAttribution(fakeInput({ usdAmountCents: 10000, providerFeeCents: 0 }));
    const { data } = mockDbWrite.blockSubscriptionAttribution.create.mock.calls[0][0];
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.subscriptionSharePct).toBe(0);
    expect(computeSubscriptionShareSpy).not.toHaveBeenCalled();
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

  it('RENEWALS-PAY: a 2nd invoice (subscription_cycle) on the same subscription writes a 2nd tracked row', async () => {
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
    // Both are TRACKED (the backpay later pays each period); gross recorded.
    expect(firstData.status).toBe('tracked');
    expect(secondData.status).toBe('tracked');
    expect(firstData.grossValueCents).toBeGreaterThan(0);
    expect(secondData.grossValueCents).toBeGreaterThan(0);
    // No share applied at write on either.
    expect(firstData.appOwnerShareCents).toBe(0);
    expect(secondData.appOwnerShareCents).toBe(0);
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
  it('refund of a TRACKED period: voids the row, NO clawback (author=0 → no debt)', async () => {
    mockDbWrite.blockSubscriptionAttribution.updateMany.mockResolvedValueOnce({ count: 1 });

    const count = await voidSubscriptionAttributionsForInvoice({
      paymentProvider: 'stripe',
      invoiceId: INVOICE_ID,
      reason: 'refund',
    });

    expect(count).toBe(1);
    // No clawback row is ever written in the track-only model.
    expect(mockDbWrite.blockSubscriptionAttribution.create).not.toHaveBeenCalled();
    // No paid_out snapshot is read — there is nothing to claw back.
    expect(mockDbWrite.blockSubscriptionAttribution.findMany).not.toHaveBeenCalled();
    // The void targets forward 'charge' rows including the live 'tracked'
    // state (pending/confirmed/paid_out included defensively).
    expect(mockDbWrite.blockSubscriptionAttribution.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          paymentProvider: 'stripe',
          invoiceId: INVOICE_ID,
          entryType: 'charge',
          status: { in: ['tracked', 'pending', 'confirmed', 'paid_out'] },
        }),
        data: expect.objectContaining({ status: 'voided', voidedReason: 'refund' }),
      })
    );
  });

  it('refund webhook is idempotent: already-voided row → updateMany count 0, still no clawback', async () => {
    mockDbWrite.blockSubscriptionAttribution.updateMany.mockResolvedValueOnce({ count: 0 });

    const count = await voidSubscriptionAttributionsForInvoice({
      paymentProvider: 'stripe',
      invoiceId: INVOICE_ID,
      reason: 'chargeback',
    });

    expect(count).toBe(0);
    expect(mockDbWrite.blockSubscriptionAttribution.create).not.toHaveBeenCalled();
  });
});

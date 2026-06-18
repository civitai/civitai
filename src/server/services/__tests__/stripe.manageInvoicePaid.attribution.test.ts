import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stripe } from 'stripe';

/**
 * W3 flow C — manageInvoicePaid attribution-gating coverage (🟡-1 + 🟡-2).
 *
 * The NEW subscription-attribution write (recordSubscriptionAttribution) must
 * fire ONLY for billing_reason IN (subscription_create, subscription_cycle)
 * and ONLY when the resolved gross (amount_paid ?? total) is > 0:
 *
 *   - subscription_update (mid-cycle upgrade PRORATION invoice) → NO row.
 *     The proration delta and the period's subscription_cycle invoice are
 *     DISTINCT invoice_ids over overlapping value; attributing both would
 *     over-accrue. Proration is NOT separately attributed.
 *   - subscription_cycle (renewal) → row written (renewals-pay).
 *   - subscription_create (first invoice) → row written.
 *   - amount_paid == 0 (proration covered by credit) → no row (no new money).
 *
 * The buzz grant / recordMembershipPaymentReward / ref_code logic is LEFT
 * firing for subscription_update — only the attribution write is gated. We
 * assert createBuzzTransaction still fires on subscription_update to lock that
 * in (no regression of the existing renewals-pay / upgrade Buzz grant).
 *
 * Every module boundary manageInvoicePaid touches is mocked so the test stays
 * in-process and deterministic; the real code under test is the gate itself.
 */

const {
  mockDbRead,
  mockDbWrite,
  mockLog,
  mockCreateBuzzTransaction,
  mockGetServerStripe,
  mockRecordSubscriptionAttribution,
  mockRecordMembershipPaymentReward,
  mockBindReferralCodeForUser,
  mockInvalidateSubscriptionCaches,
} = vi.hoisted(() => ({
  mockDbRead: {
    product: { findMany: vi.fn() },
  },
  mockDbWrite: {
    user: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    purchase: { createMany: vi.fn() },
  },
  mockLog: vi.fn(),
  mockCreateBuzzTransaction: vi.fn(),
  mockGetServerStripe: vi.fn(),
  mockRecordSubscriptionAttribution: vi.fn(),
  mockRecordMembershipPaymentReward: vi.fn(),
  mockBindReferralCodeForUser: vi.fn(),
  mockInvalidateSubscriptionCaches: vi.fn(),
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
vi.mock('~/server/utils/errorHandling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/errorHandling')>();
  return {
    ...actual,
    handleLogError: vi.fn(),
    // run the fn once, no retry loop in tests
    withRetries: (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: (...args: unknown[]) => mockCreateBuzzTransaction(...args),
  completeStripeBuzzTransaction: vi.fn(),
  getMultipliersForUser: vi.fn(),
}));
vi.mock('~/server/utils/get-server-stripe', () => ({
  getServerStripe: (...args: unknown[]) => mockGetServerStripe(...args),
}));
// vault.service is imported by stripe.service (getOrCreateVault) but unused by
// manageInvoicePaid; mock it to cut the transitive common.service → caches →
// selectors → Prisma.validator import chain that crashes under the copied
// .prisma/client in this worktree.
vi.mock('~/server/services/vault.service', () => ({
  getOrCreateVault: vi.fn(),
}));
vi.mock('~/server/services/referral.service', () => ({
  bindReferralCodeForUser: (...args: unknown[]) => mockBindReferralCodeForUser(...args),
  recordMembershipPaymentReward: (...args: unknown[]) =>
    mockRecordMembershipPaymentReward(...args),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  recordSubscriptionAttribution: (...args: unknown[]) =>
    mockRecordSubscriptionAttribution(...args),
}));
vi.mock('~/server/utils/subscription.utils', () => ({
  invalidateSubscriptionCaches: (...args: unknown[]) =>
    mockInvalidateSubscriptionCaches(...args),
}));
vi.mock('~/server/prom/client', () => ({
  userUpdateCounter: { inc: vi.fn() },
}));

import { manageInvoicePaid } from '../stripe.service';
import { encodeAttributionMetadata } from '~/server/schema/blocks/attribution.schema';

const USER_ID = 100;
const CUSTOMER_ID = 'cus_test';
const PRODUCT_ID = 'prod_tier';
const PRICE_ID = 'price_tier';
const APP_ID = 'app_real';
const APP_BLOCK_ID = 'apb_real';

// A valid server-derived attribution bag (already FIN-1 validated upstream).
const ATTRIBUTION_BAG = encodeAttributionMetadata({
  appId: APP_ID,
  appBlockId: APP_BLOCK_ID,
  blockInstanceId: 'bus_view_abc',
  scope: 'viewer_personal',
  modelId: 555,
  slotId: 'model.sidebar_top',
})!;

function fakeInvoice(over: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id: 'in_test',
    customer: CUSTOMER_ID,
    status: 'paid',
    subscription: 'sub_xyz',
    billing_reason: 'subscription_cycle',
    amount_paid: 1000,
    total: 1000,
    payment_intent: 'pi_test',
    charge: undefined,
    subscription_details: { metadata: { ...ATTRIBUTION_BAG } },
    lines: {
      data: [
        {
          price: { id: PRICE_ID, product: PRODUCT_ID },
          period: { start: 1_700_000_000, end: 1_702_592_000 },
        },
      ],
    },
    ...over,
  } as unknown as Stripe.Invoice;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.user.findUniqueOrThrow.mockResolvedValue({ id: USER_ID, customerId: CUSTOMER_ID });
  mockDbWrite.user.update.mockResolvedValue({});
  mockDbWrite.purchase.createMany.mockResolvedValue({ count: 1 });
  mockDbRead.product.findMany.mockResolvedValue([
    {
      id: PRODUCT_ID,
      // env.TIER_METADATA_KEY drives the membership filter. The default key is
      // 'tier' (see env/server). monthlyBuzz/buzzType/tier feed the grant.
      metadata: { tier: 'gold', monthlyBuzz: 5000, buzzType: 'yellow' },
    },
  ]);
  mockCreateBuzzTransaction.mockResolvedValue({});
  mockRecordMembershipPaymentReward.mockResolvedValue({});
  mockBindReferralCodeForUser.mockResolvedValue({});
  mockRecordSubscriptionAttribution.mockResolvedValue({});
  mockInvalidateSubscriptionCaches.mockResolvedValue(undefined);
  // No charge → fee fetch is skipped (best-effort 0 fee); stripe client unused
  // on the happy attribution path, but the ref_code fallback may call it.
  mockGetServerStripe.mockResolvedValue({
    checkout: { sessions: { list: vi.fn().mockResolvedValue({ data: [] }) } },
    charges: { retrieve: vi.fn() },
  });
});

describe('manageInvoicePaid — subscription attribution gating (🟡-1 proration)', () => {
  it('subscription_update (proration) invoice → NO attribution row', async () => {
    await manageInvoicePaid(fakeInvoice({ billing_reason: 'subscription_update' }));
    expect(mockRecordSubscriptionAttribution).not.toHaveBeenCalled();
    // …but the existing upgrade Buzz grant + membership reward STILL fire.
    expect(mockCreateBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordMembershipPaymentReward).toHaveBeenCalledTimes(1);
  });

  it('subscription_cycle (renewal) invoice → attribution row written (renewals-pay)', async () => {
    await manageInvoicePaid(fakeInvoice({ billing_reason: 'subscription_cycle' }));
    expect(mockRecordSubscriptionAttribution).toHaveBeenCalledTimes(1);
    const arg = mockRecordSubscriptionAttribution.mock.calls[0][0];
    expect(arg.invoiceId).toBe('in_test');
    expect(arg.billingReason).toBe('subscription_cycle');
    expect(arg.usdAmountCents).toBe(1000);
    expect(arg.attribution.appId).toBe(APP_ID);
  });

  it('subscription_create (first) invoice → attribution row written', async () => {
    await manageInvoicePaid(fakeInvoice({ billing_reason: 'subscription_create' }));
    expect(mockRecordSubscriptionAttribution).toHaveBeenCalledTimes(1);
    expect(mockRecordSubscriptionAttribution.mock.calls[0][0].billingReason).toBe(
      'subscription_create'
    );
  });
});

describe('manageInvoicePaid — zero-gross skip (🟡-2)', () => {
  it('amount_paid == 0 invoice → no attribution row', async () => {
    await manageInvoicePaid(
      fakeInvoice({ billing_reason: 'subscription_cycle', amount_paid: 0, total: 0 })
    );
    expect(mockRecordSubscriptionAttribution).not.toHaveBeenCalled();
    // The Buzz grant still fires — only the attribution write is skipped.
    expect(mockCreateBuzzTransaction).toHaveBeenCalledTimes(1);
  });

  it('amount_paid == 0 but total > 0 → still no row (amount_paid is the basis)', async () => {
    await manageInvoicePaid(
      fakeInvoice({ billing_reason: 'subscription_cycle', amount_paid: 0, total: 999 })
    );
    expect(mockRecordSubscriptionAttribution).not.toHaveBeenCalled();
  });
});

describe('manageInvoicePaid — attribution write payload (no regression)', () => {
  it('passes the resolved gross (amount_paid) as usdAmountCents', async () => {
    await manageInvoicePaid(
      fakeInvoice({ billing_reason: 'subscription_cycle', amount_paid: 1499, total: 1499 })
    );
    expect(mockRecordSubscriptionAttribution.mock.calls[0][0].usdAmountCents).toBe(1499);
  });

  it('no block metadata on the invoice → no attribution row (un-attributed membership)', async () => {
    await manageInvoicePaid(
      fakeInvoice({
        billing_reason: 'subscription_cycle',
        subscription_details: { metadata: {} },
      } as Partial<Stripe.Invoice>)
    );
    expect(mockRecordSubscriptionAttribution).not.toHaveBeenCalled();
    // Membership still provisioned.
    expect(mockCreateBuzzTransaction).toHaveBeenCalledTimes(1);
  });
});

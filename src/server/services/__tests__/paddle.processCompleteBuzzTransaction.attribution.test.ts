import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionNotification } from '@paddle/paddle-node-sdk';

/**
 * FIN-1 coverage for the Paddle Buzz-purchase attribution path.
 *
 * `processCompleteBuzzTransaction` credits buzz to the buyer, then writes an
 * App Blocks revenue-share attribution row off the line-item customData. The
 * block-attribution fields in that customData are CLIENT-SUPPLIED, so before
 * recording we re-derive them SERVER-SIDE through the same chokepoint the
 * Stripe path uses (`validateBuzzPurchaseAttribution`, which resolves the
 * cited instance AS THE BUYER, overwrites forged appId/scope, and strips
 * attribution that doesn't resolve). These tests prove:
 *   - a forged client appId/scope is corrected to the server-resolved values
 *     before recordAttribution is called (NOT the client's claim);
 *   - a non-resolving / absent instance → attribution dropped,
 *     recordAttribution NOT called, the purchase still proceeds (buzz still
 *     credited);
 *   - a normal non-block purchase → no attribution write, buzz still credited.
 *
 * Every module boundary the handler touches is mocked so the test stays
 * in-process and deterministic; the real code under test is the wiring of
 * validate → extract → record (and that the buzz-credit path is never gated
 * by the attribution outcome). BlockRegistry.resolveBlockInstance + the logger
 * are mocked at the validator's module boundary so the REAL FIN-1 validator
 * runs end-to-end (matching subscription-attribution.fin1.test.ts).
 */

const {
  mockResolve,
  mockLog,
  mockGetMultipliersForUser,
  mockCreateBuzzTransaction,
  mockGrantCosmetics,
  mockRecordAttribution,
} = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockLog: vi.fn(),
  mockGetMultipliersForUser: vi.fn(),
  mockCreateBuzzTransaction: vi.fn(),
  mockGrantCosmetics: vi.fn(),
  mockRecordAttribution: vi.fn(),
}));

// Real FIN-1 validator runs; only its resolver + logger are mocked.
vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveBlockInstance: mockResolve },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: (...args: unknown[]) => mockCreateBuzzTransaction(...args),
  getMultipliersForUser: (...args: unknown[]) => mockGetMultipliersForUser(...args),
}));
vi.mock('~/server/services/cosmetic.service', () => ({
  grantCosmetics: (...args: unknown[]) => mockGrantCosmetics(...args),
}));
vi.mock('~/server/services/blocks/buzz-attribution.service', () => ({
  recordAttribution: (...args: unknown[]) => mockRecordAttribution(...args),
  // AttributionAppMissingError is referenced by the catch block; a plain
  // Error subclass is enough for the `instanceof` branch.
  AttributionAppMissingError: class AttributionAppMissingError extends Error {},
}));
// paddle.service imports these at module load; none are exercised by
// processCompleteBuzzTransaction's buzz-purchase path, so stub them to cut
// the transitive Prisma / env / paddle-client import chains.
vi.mock('~/server/paddle/client', () => ({
  cancelPaddleSubscription: vi.fn(),
  createBuzzTransaction: vi.fn(),
  createOneTimeProductPurchaseTransaction: vi.fn(),
  getCustomerLatestTransaction: vi.fn(),
  getOrCreateCustomer: vi.fn(),
  getPaddleAdjustments: vi.fn(),
  getPaddleCustomerSubscriptions: vi.fn(),
  getPaddleSubscription: vi.fn(),
  subscriptionBuzzOneTimeCharge: vi.fn(),
  updatePaddleSubscription: vi.fn(),
  createAnnualSubscriptionDiscount: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({
  dbWrite: {},
  dbRead: {},
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getPlans: vi.fn(),
}));
vi.mock('~/server/services/vault.service', () => ({
  getOrCreateVault: vi.fn(),
}));

import { processCompleteBuzzTransaction } from '../paddle.service';
import { encodeAttributionMetadata } from '~/server/schema/blocks/attribution.schema';

const BUYER = 100;
const REAL_APP_ID = 'app_real';
const REAL_APP_BLOCK_ID = 'apb_real';
const SLOT = 'model.sidebar_top';
const MODEL_ID = 555;
const TX_ID = 'txn_test';

function resolvedInstance(over: Record<string, unknown> = {}) {
  return {
    source: 'viewer_subscription',
    modelId: MODEL_ID,
    slotId: SLOT,
    enabled: true,
    settings: {},
    installedByUserId: BUYER,
    appBlock: {
      id: REAL_APP_BLOCK_ID,
      blockId: 'blk',
      appId: REAL_APP_ID,
      status: 'approved',
      manifest: {},
      approvedScopes: [],
      app: { allowedScopes: 0 },
    },
    ...over,
  };
}

/**
 * Build a Paddle TransactionNotification carrying a buzzPurchase line item.
 * `blockMeta` (if given) is the CLIENT-SUPPLIED block-attribution bag merged
 * onto the line-item customData — i.e. the forgeable surface.
 */
function fakeTransaction(blockMeta: Record<string, unknown> = {}): TransactionNotification {
  const customData = {
    type: 'buzzPurchase',
    user_id: BUYER,
    buzz_amount: 1000,
    ...blockMeta,
  };
  return {
    id: TX_ID,
    details: { totals: { total: '500' } },
    items: [{ price: { customData } }],
  } as unknown as TransactionNotification;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMultipliersForUser.mockResolvedValue({ purchasesMultiplier: 1 });
  mockCreateBuzzTransaction.mockResolvedValue({});
  mockGrantCosmetics.mockResolvedValue({});
  mockRecordAttribution.mockResolvedValue({});
});

describe('paddle processCompleteBuzzTransaction — FIN-1 attribution re-derivation', () => {
  it('valid attribution → records SERVER-DERIVED appId/scope (buzz still credited)', async () => {
    mockResolve.mockResolvedValueOnce(resolvedInstance({ source: 'viewer_subscription' }));

    const clientBag = encodeAttributionMetadata({
      appId: REAL_APP_ID,
      appBlockId: REAL_APP_BLOCK_ID,
      blockInstanceId: 'bus_view_abc',
      scope: 'viewer_personal',
      modelId: MODEL_ID,
      slotId: SLOT,
    })!;

    await processCompleteBuzzTransaction(fakeTransaction(clientBag));

    // Buzz credit happened regardless of attribution.
    expect(mockCreateBuzzTransaction).toHaveBeenCalled();
    expect(mockRecordAttribution).toHaveBeenCalledTimes(1);
    const arg = mockRecordAttribution.mock.calls[0][0];
    expect(arg.attribution.appId).toBe(REAL_APP_ID);
    expect(arg.attribution.scope).toBe('viewer_personal');
    expect(arg.paymentProvider).toBe('paddle');
    expect(arg.paymentTransactionId).toBe(TX_ID);
    expect(arg.userId).toBe(BUYER);
    // v1 fee behavior preserved.
    expect(arg.providerFeeCents).toBe(0);
    expect(arg.usdAmountCents).toBe(500);
  });

  it('forged appId/scope → corrected to the resolved values, NOT the client claim', async () => {
    // The instance actually resolves to viewer_subscription → viewer_personal,
    // owned by the real app. The buyer forges a confederate app + a high-rate
    // scope; the server must overwrite both.
    mockResolve.mockResolvedValueOnce(resolvedInstance({ source: 'viewer_subscription' }));

    const forgedBag = encodeAttributionMetadata({
      appId: 'app_attacker', // forged
      appBlockId: REAL_APP_BLOCK_ID,
      blockInstanceId: 'bus_view_abc',
      scope: 'publisher_all_my_models', // forged high-rate scope
      modelId: MODEL_ID,
      slotId: SLOT,
    })!;

    await processCompleteBuzzTransaction(fakeTransaction(forgedBag));

    expect(mockRecordAttribution).toHaveBeenCalledTimes(1);
    const arg = mockRecordAttribution.mock.calls[0][0];
    // Server-derived — NOT the forged values.
    expect(arg.attribution.appId).toBe(REAL_APP_ID);
    expect(arg.attribution.appId).not.toBe('app_attacker');
    expect(arg.attribution.scope).toBe('viewer_personal');
    expect(arg.attribution.scope).not.toBe('publisher_all_my_models');
  });

  it('non-resolving instance → attribution dropped, recordAttribution NOT called, buzz still credited', async () => {
    mockResolve.mockResolvedValueOnce(null); // buyer is not a legit viewer/owner

    const forgedBag = encodeAttributionMetadata({
      appId: REAL_APP_ID,
      appBlockId: REAL_APP_BLOCK_ID,
      blockInstanceId: 'bus_view_nope',
      scope: 'viewer_personal',
      modelId: MODEL_ID,
      slotId: SLOT,
    })!;

    await processCompleteBuzzTransaction(fakeTransaction(forgedBag));

    expect(mockRecordAttribution).not.toHaveBeenCalled();
    // Purchase still proceeds: buzz credited.
    expect(mockCreateBuzzTransaction).toHaveBeenCalled();
  });

  it('normal non-block purchase → no attribution write, buzz still credited', async () => {
    await processCompleteBuzzTransaction(fakeTransaction());

    expect(mockRecordAttribution).not.toHaveBeenCalled();
    // The validator short-circuits (no appId) and never touches the resolver.
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockCreateBuzzTransaction).toHaveBeenCalled();
  });
});

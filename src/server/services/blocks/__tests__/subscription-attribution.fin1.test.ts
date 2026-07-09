import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W3 flow C FIN-1 coverage — the membership/subscription checkout chokepoint.
 *
 * createSubscribeSession re-derives a block's membership attribution
 * SERVER-SIDE before stamping it onto the Stripe subscription metadata,
 * using the SAME validator the Buzz-purchase path uses
 * (validateBuzzPurchaseAttribution). These tests exercise that validator
 * with the encode→validate→extract→encode round-trip the subscription
 * helper performs, proving:
 *   - a forged client scope (claiming a high-rate scope) is corrected to
 *     the server-resolved scope
 *   - a forged client appId is overwritten with the resolved app's id
 *   - an instance that doesn't resolve for the buyer is STRIPPED (the
 *     membership purchase proceeds un-attributed — never a forged credit)
 *   - the page surface (page_*) re-derives to viewer_global server-side
 *
 * BlockRegistry.resolveBlockInstance + logger are mocked at the module
 * boundary; everything else is the real FIN-1 code.
 */

const { mockResolve, mockLog } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  mockLog: vi.fn(),
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: { resolveBlockInstance: mockResolve },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));

import { validateBuzzPurchaseAttribution } from '../attribution-validator.service';
import {
  encodeAttributionMetadata,
  extractAttribution,
  type BlockAttribution,
} from '~/server/schema/blocks/attribution.schema';

const BUYER = 100;
const REAL_APP_ID = 'app_real';
const REAL_APP_BLOCK_ID = 'apb_real';
const SLOT = 'model.sidebar_top';
const MODEL_ID = 555;

/**
 * Mirror the createSubscribeSession FIN-1 helper:
 * client BlockAttribution → encode → validate (server re-derive) → extract.
 * Returns the SERVER-DERIVED attribution (or null when stripped).
 */
async function deriveServerSide(
  clientAttribution: BlockAttribution,
  sessionUserId: number
): Promise<BlockAttribution | null> {
  const encoded = encodeAttributionMetadata(clientAttribution)!;
  const validated = await validateBuzzPurchaseAttribution({
    metadata: { ...encoded } as Record<string, unknown> & { userId?: unknown },
    sessionUserId,
  });
  return extractAttribution(validated as Record<string, string | number | null | undefined>);
}

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

beforeEach(() => {
  mockResolve.mockReset();
  mockLog.mockReset();
});

describe('membership FIN-1 (model surface)', () => {
  it('corrects a forged client scope to the server-resolved scope', async () => {
    // Buyer forges the highest-rate scope; the instance actually resolves to
    // viewer_subscription → viewer_personal (the resolver is authoritative).
    mockResolve.mockResolvedValueOnce(resolvedInstance({ source: 'viewer_subscription' }));

    const forged: BlockAttribution = {
      appId: REAL_APP_ID,
      appBlockId: REAL_APP_BLOCK_ID,
      blockInstanceId: 'bus_view_abc',
      scope: 'platform_default', // forged (client lie — doesn't matter, server overrides)
      modelId: MODEL_ID,
      slotId: SLOT,
    };
    const derived = await deriveServerSide(forged, BUYER);
    expect(derived).not.toBeNull();
    // Server re-derived the scope from the resolved source.
    expect(derived!.scope).toBe('viewer_personal');
    expect(derived!.appId).toBe(REAL_APP_ID);
  });

  it('overwrites a forged client appId with the resolved app id', async () => {
    mockResolve.mockResolvedValueOnce(resolvedInstance({ source: 'viewer_subscription' }));
    const forged: BlockAttribution = {
      appId: 'app_attacker', // forged — points at a confederate's app
      appBlockId: REAL_APP_BLOCK_ID,
      blockInstanceId: 'bus_view_abc',
      scope: 'viewer_personal',
      modelId: MODEL_ID,
      slotId: SLOT,
    };
    const derived = await deriveServerSide(forged, BUYER);
    expect(derived).not.toBeNull();
    // The attacker's app id is replaced with the real resolved app.
    expect(derived!.appId).toBe(REAL_APP_ID);
    expect(derived!.appBlockId).toBe(REAL_APP_BLOCK_ID);
  });

  it('strips attribution entirely when the instance does not resolve for the buyer', async () => {
    mockResolve.mockResolvedValueOnce(null); // not a legit viewer/owner
    const forged: BlockAttribution = {
      appId: REAL_APP_ID,
      appBlockId: REAL_APP_BLOCK_ID,
      blockInstanceId: 'bus_view_nope',
      scope: 'viewer_personal',
      modelId: MODEL_ID,
      slotId: SLOT,
    };
    const derived = await deriveServerSide(forged, BUYER);
    // Stripped → the membership purchase proceeds un-attributed (no credit).
    expect(derived).toBeNull();
  });

  it('strips when modelId/slotId are missing (cannot server-revalidate)', async () => {
    const forged: BlockAttribution = {
      appId: REAL_APP_ID,
      appBlockId: REAL_APP_BLOCK_ID,
      blockInstanceId: 'bus_view_abc',
      scope: 'viewer_personal',
      // no modelId / slotId — the resolver can't revalidate the instance.
    };
    const derived = await deriveServerSide(forged, BUYER);
    expect(derived).toBeNull();
    // The resolver was never even called (fail-safe before resolve).
    expect(mockResolve).not.toHaveBeenCalled();
  });
});

describe('membership FIN-1 (page surface)', () => {
  it('re-derives a page_* instance to viewer_global server-side', async () => {
    mockResolve.mockResolvedValueOnce(
      resolvedInstance({ source: 'page', modelId: 0, slotId: '' })
    );
    const pageAttribution: BlockAttribution = {
      appId: REAL_APP_ID,
      appBlockId: REAL_APP_BLOCK_ID,
      blockInstanceId: 'page_apb_real',
      scope: 'viewer_personal', // forged — server corrects to viewer_global
    };
    const derived = await deriveServerSide(pageAttribution, BUYER);
    expect(derived).not.toBeNull();
    expect(derived!.scope).toBe('viewer_global');
    expect(derived!.appId).toBe(REAL_APP_ID);
    // A page has no model entity → no modelId stamped.
    expect(derived!.modelId).toBeUndefined();
  });
});

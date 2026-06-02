import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FIN-1 coverage. `validateBuzzPurchaseAttribution` is the server-side
 * chokepoint that re-validates/re-derives every block-attribution field on
 * a buzz purchase against the authenticated session user, closing the
 * client-forgeable revenue-attribution path.
 *
 * The four forge vectors under test:
 *   1. spender spoof  — metadata.userId != session user
 *   2. install existence — blockInstanceId that doesn't resolve for buyer
 *   3. scope forgery  — client claims viewer_personal (25%) but instance
 *                       derives platform_default (0%)
 *   4. app mismatch   — client blockAppId != resolved install's app
 * Plus: legit install (preserved with server values) and non-block
 * purchase (untouched passthrough).
 *
 * BlockRegistry.resolveBlockInstance + logger are mocked at the module
 * boundary so the test stays in-process and deterministic.
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

const SESSION_USER = 100;
const REAL_APP_ID = 'app_real';
const REAL_APP_BLOCK_ID = 'apb_real';
const SLOT = 'model.sidebar_top';
const MODEL_ID = 555;

/** A buzz-purchase metadata bag with valid-looking block attribution. */
function blockMetadata(over: Record<string, unknown> = {}) {
  return {
    type: 'buzzPurchase',
    unitAmount: 100,
    buzzAmount: 1000,
    userId: SESSION_USER,
    buzzType: 'yellow',
    blockAppId: REAL_APP_ID,
    blockAppBlockId: REAL_APP_BLOCK_ID,
    blockInstanceId: 'bus_view_abc',
    blockScope: 'viewer_personal',
    blockModelId: String(MODEL_ID),
    blockSlotId: SLOT,
    ...over,
  } as Record<string, unknown> & {
    userId?: unknown;
    blockAppId?: string | null;
    blockInstanceId?: string | null;
  };
}

/** A resolved-instance stub mirroring ResolvedBlockInstance's relevant fields. */
function resolvedInstance(over: Record<string, unknown> = {}) {
  return {
    source: 'viewer_subscription',
    modelId: MODEL_ID,
    slotId: SLOT,
    enabled: true,
    settings: {},
    installedByUserId: SESSION_USER,
    appBlock: {
      id: REAL_APP_BLOCK_ID,
      blockId: 'blk_x',
      appId: REAL_APP_ID,
      status: 'approved',
      manifest: {},
      approvedScopes: [],
      app: null,
    },
    ...over,
  };
}

beforeEach(() => {
  mockResolve.mockReset();
  mockLog.mockReset();
});

describe('validateBuzzPurchaseAttribution', () => {
  it('preserves attribution with server-derived values for a legit install', async () => {
    mockResolve.mockResolvedValueOnce(resolvedInstance());
    const out = await validateBuzzPurchaseAttribution({
      metadata: blockMetadata(),
      sessionUserId: SESSION_USER,
    });

    // resolver called with the SESSION user as the viewer + write db
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        blockInstanceId: 'bus_view_abc',
        modelId: MODEL_ID,
        slotId: SLOT,
        viewerUserId: SESSION_USER,
        db: 'write',
      })
    );
    expect(out.blockAppId).toBe(REAL_APP_ID);
    expect(out.blockAppBlockId).toBe(REAL_APP_BLOCK_ID);
    expect(out.blockInstanceId).toBe('bus_view_abc');
    // viewer_subscription source → viewer_personal scope (server-derived)
    expect(out.blockScope).toBe('viewer_personal');
    expect(out.blockModelId).toBe(String(MODEL_ID));
    expect(out.userId).toBe(SESSION_USER);
  });

  it('VECTOR 2 — strips attribution when the instance does not resolve for this buyer', async () => {
    mockResolve.mockResolvedValueOnce(null); // forged / not a real viewer
    const out = await validateBuzzPurchaseAttribution({
      metadata: blockMetadata({ blockInstanceId: 'bus_view_forged' }),
      sessionUserId: SESSION_USER,
    });

    // purchase still proceeds (no throw); all block fields gone
    expect(out.blockAppId).toBeUndefined();
    expect(out.blockAppBlockId).toBeUndefined();
    expect(out.blockInstanceId).toBeUndefined();
    expect(out.blockScope).toBeUndefined();
    expect(out.blockModelId).toBeUndefined();
    expect(out.blockSlotId).toBeUndefined();
    // non-block fields intact
    expect(out.type).toBe('buzzPurchase');
    expect(out.buzzAmount).toBe(1000);
    expect(out.userId).toBe(SESSION_USER);
  });

  it('VECTOR 3 — corrects the scope to the server-derived value (viewer_personal → platform_default)', async () => {
    // Client lies: claims the 25% viewer_personal scope. The instance
    // actually resolves as a platform_default (0% to publisher).
    mockResolve.mockResolvedValueOnce(
      resolvedInstance({ source: 'platform_default', installedByUserId: null })
    );
    const out = await validateBuzzPurchaseAttribution({
      metadata: blockMetadata({ blockScope: 'viewer_personal', blockInstanceId: 'pdb_x' }),
      sessionUserId: SESSION_USER,
    });

    // scope is the DERIVED one, not the client-asserted high-rate one
    expect(out.blockScope).toBe('platform_default');
    expect(out.blockAppId).toBe(REAL_APP_ID);
  });

  it('VECTOR 4 — overwrites a mismatched client blockAppId with the resolved app', async () => {
    // Client cites a confederate's app id; resolver returns the REAL app
    // that owns the resolved instance.
    mockResolve.mockResolvedValueOnce(resolvedInstance());
    const out = await validateBuzzPurchaseAttribution({
      metadata: blockMetadata({ blockAppId: 'app_confederate', blockAppBlockId: 'apb_confederate' }),
      sessionUserId: SESSION_USER,
    });

    expect(out.blockAppId).toBe(REAL_APP_ID);
    expect(out.blockAppBlockId).toBe(REAL_APP_BLOCK_ID);
  });

  it('VECTOR 1 — rejects a purchase whose metadata.userId is not the session user', async () => {
    await expect(
      validateBuzzPurchaseAttribution({
        metadata: blockMetadata({ userId: 999 }), // spoofed spender
        sessionUserId: SESSION_USER,
      })
    ).rejects.toThrow(/error while creating your order/i);
    // never even hit the resolver
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('forces metadata.userId to the session user when client omits it', async () => {
    mockResolve.mockResolvedValueOnce(resolvedInstance());
    const md = blockMetadata();
    delete (md as Record<string, unknown>).userId;
    const out = await validateBuzzPurchaseAttribution({ metadata: md, sessionUserId: SESSION_USER });
    expect(out.userId).toBe(SESSION_USER);
  });

  it('non-block purchase passes through unchanged (only userId pinned)', async () => {
    const md = {
      type: 'buzzPurchase',
      unitAmount: 100,
      buzzAmount: 1000,
      userId: SESSION_USER,
      buzzType: 'yellow',
    } as Record<string, unknown> & { userId?: unknown };
    const out = await validateBuzzPurchaseAttribution({ metadata: md, sessionUserId: SESSION_USER });

    expect(mockResolve).not.toHaveBeenCalled();
    expect(out).toEqual(md);
  });

  it('strips attribution when slotId is missing (cannot re-validate)', async () => {
    const md = blockMetadata();
    delete (md as Record<string, unknown>).blockSlotId;
    const out = await validateBuzzPurchaseAttribution({ metadata: md, sessionUserId: SESSION_USER });

    expect(mockResolve).not.toHaveBeenCalled();
    expect(out.blockAppId).toBeUndefined();
    expect(out.blockInstanceId).toBeUndefined();
  });

  it('strips attribution when blockAppId is present without a blockInstanceId', async () => {
    const md = blockMetadata({ blockInstanceId: '' });
    const out = await validateBuzzPurchaseAttribution({ metadata: md, sessionUserId: SESSION_USER });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(out.blockAppId).toBeUndefined();
  });

  it('strips attribution (does not throw) when the resolver itself throws', async () => {
    mockResolve.mockRejectedValueOnce(new Error('db down'));
    const out = await validateBuzzPurchaseAttribution({
      metadata: blockMetadata(),
      sessionUserId: SESSION_USER,
    });
    expect(out.blockAppId).toBeUndefined();
    expect(out.buzzAmount).toBe(1000); // purchase preserved
  });

  it('maps each resolver source onto the correct attribution scope', async () => {
    const cases: Array<[string, string]> = [
      // L-M2: the resolver's `install` source is a per-model-PINNED publisher
      // subscription post kill_per_model_installs, so it buckets as
      // publisher_all_my_models (same publisher rate, one bucket) rather than
      // the stale per_model_install.
      ['install', 'publisher_all_my_models'],
      ['publisher_subscription', 'publisher_all_my_models'],
      ['viewer_subscription', 'viewer_personal'],
      ['platform_default', 'platform_default'],
    ];
    for (const [source, expectedScope] of cases) {
      mockResolve.mockResolvedValueOnce(resolvedInstance({ source }));
      const out = await validateBuzzPurchaseAttribution({
        metadata: blockMetadata({ blockScope: 'viewer_personal' }),
        sessionUserId: SESSION_USER,
      });
      expect(out.blockScope).toBe(expectedScope);
    }
  });
});

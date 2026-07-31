import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelVersionTerms } from '@civitai/buzz';

const { mockGetPaidAccess, mockHasEntityAccess, mockGetViewerMonetization } = vi.hoisted(() => ({
  mockGetPaidAccess: vi.fn(),
  mockHasEntityAccess: vi.fn(),
  mockGetViewerMonetization: vi.fn(),
}));

// Rows reach the gate through getViewerMonetization, which prices them; this stub hands back the stored
// rows so these tests stay about the ACCESS decision. Pricing has its own tests in paid-access.service.
vi.mock('~/server/services/paid-access.service', () => ({
  getViewerMonetization: mockGetViewerMonetization,
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: mockHasEntityAccess }));

import { applyPaidAccessGating } from '~/server/services/generation/paid-access-gating';

const OWNER = 99;
const FUTURE = new Date('2099-01-01T00:00:00.000Z');

const BUNDLED: ModelVersionTerms = { download: { price: 500 } }; // no generation key = must buy
const TRIAL: ModelVersionTerms = {
  download: { price: 500 },
  generation: { price: 200, trialLimit: 5 },
};
const FREE: ModelVersionTerms = { generation: { free: true } };

// A generation resource as it arrives from resource-data: gated versions are availability='Public',
// so hasAccess/canGenerate start optimistically true.
const resource = (over: Record<string, unknown> = {}) => ({
  id: 1,
  covered: true as boolean | null,
  hasAccess: true,
  canGenerate: true,
  paidAccess: null as { endsAt: Date | null; terms: ModelVersionTerms } | null,
  ...over,
});

const gate = (over: Record<string, unknown> = {}) => ({
  entityType: 'ModelVersion' as const,
  entityId: 1,
  ownerId: OWNER,
  endsAt: FUTURE,
  timeframeDays: 7,
  terms: BUNDLED as ModelVersionTerms,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPaidAccess.mockResolvedValue({});
  mockHasEntityAccess.mockResolvedValue([]);
  mockGetViewerMonetization.mockImplementation(
    async ({ versions }: { versions: { id: number }[] }) => {
      const rows = await mockGetPaidAccess(versions.map((v) => v.id));
      return Object.fromEntries(
        versions.map((v) => [v.id, { paidAccess: rows[v.id], licensingFee: null }])
      );
    }
  );
});

describe('applyPaidAccessGating — the sole paid generation gate', () => {
  it('BLOCKS a non-owner non-buyer on a bundled must-buy gate (the paywall-bypass regression)', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ terms: BUNDLED }) });
    const r = resource();

    await applyPaidAccessGating([r], { id: 1 }); // not owner, not mod

    expect(r.hasAccess).toBe(false);
    expect(r.canGenerate).toBe(false);
    expect(r.paidAccess).toEqual({ endsAt: FUTURE, terms: BUNDLED });
  });

  it('lets the OWNER through and never runs the purchase lookup for them', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ terms: BUNDLED }) });
    const r = resource();

    await applyPaidAccessGating([r], { id: OWNER });

    expect(r.hasAccess).toBe(true);
    expect(mockHasEntityAccess).not.toHaveBeenCalled();
  });

  it('lets a MODERATOR through', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ terms: BUNDLED }) });
    const r = resource();

    await applyPaidAccessGating([r], { id: 1, isModerator: true });

    expect(r.hasAccess).toBe(true);
  });

  it('lets a BUYER through (EntityAccess grants generation)', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ terms: BUNDLED }) });
    mockHasEntityAccess.mockResolvedValueOnce([{ entityId: 1, hasAccess: true }]);
    const r = resource();

    await applyPaidAccessGating([r], { id: 1 });

    expect(r.hasAccess).toBe(true);
    expect(mockHasEntityAccess).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'ModelVersion', entityIds: [1] })
    );
  });

  it('keeps FREE generation open to a non-owner and skips the purchase lookup', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ terms: FREE }) });
    const r = resource();

    await applyPaidAccessGating([r], { id: 1 });

    expect(r.hasAccess).toBe(true);
    expect(mockHasEntityAccess).not.toHaveBeenCalled(); // free gates aren't purchase-checked
  });

  it('grants a non-buyer access via the free TRIAL tier', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ terms: TRIAL }) });
    mockHasEntityAccess.mockResolvedValueOnce([]); // not purchased
    const r = resource();

    await applyPaidAccessGating([r], { id: 1 });

    expect(r.hasAccess).toBe(true);
  });

  it('leaves an UNGATED resource untouched (no gate row) and runs no purchase lookup', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({}); // no PaidAccess row
    const r = resource({ hasAccess: true, canGenerate: true });

    await applyPaidAccessGating([r], { id: 1 });

    expect(r.hasAccess).toBe(true); // optimistic flag preserved
    expect(r.paidAccess).toBeNull();
    expect(mockHasEntityAccess).not.toHaveBeenCalled();
  });

  it('treats an EXPIRED gate (tombstone) as ungated', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ endsAt: new Date('2000-01-01') }) });
    const r = resource();

    await applyPaidAccessGating([r], { id: 1 });

    expect(r.hasAccess).toBe(true);
    expect(r.paidAccess).toBeNull();
  });

  it('never lets access override an already-false canGenerate (canGenerate = hasAccess && canGenerate)', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ terms: BUNDLED }) });
    mockHasEntityAccess.mockResolvedValueOnce([{ entityId: 1, hasAccess: true }]);
    const r = resource({ canGenerate: false }); // e.g. not covered/generatable

    await applyPaidAccessGating([r], { id: 1 });

    expect(r.hasAccess).toBe(true);
    expect(r.canGenerate).toBe(false);
  });

  it('purchase lookup is scoped to covered && non-owner && non-free gated ids only', async () => {
    const bundledCovered = resource({ id: 1 });
    const freeNonOwner = resource({ id: 2 });
    const ownedBundled = resource({ id: 3 });
    const notCovered = resource({ id: 4, covered: false });
    mockGetPaidAccess.mockResolvedValueOnce({
      1: gate({ entityId: 1, terms: BUNDLED }),
      2: gate({ entityId: 2, terms: FREE }),
      3: gate({ entityId: 3, ownerId: 1, terms: BUNDLED }), // owned by the viewer
      4: gate({ entityId: 4, terms: BUNDLED }),
    });

    await applyPaidAccessGating([bundledCovered, freeNonOwner, ownedBundled, notCovered], {
      id: 1,
    });

    // Only id 1 qualifies for the purchase check.
    expect(mockHasEntityAccess).toHaveBeenCalledTimes(1);
    expect(mockHasEntityAccess).toHaveBeenCalledWith(expect.objectContaining({ entityIds: [1] }));
  });
});

describe('applyPaidAccessGating — pricing is delegated, not reimplemented', () => {
  it('forwards the VIEWER so the owner keeps their stored prices (a dropped arg caps them)', async () => {
    mockGetPaidAccess.mockResolvedValueOnce({ 1: gate({ terms: BUNDLED }) });

    await applyPaidAccessGating([resource()], { id: OWNER, isModerator: false });

    expect(mockGetViewerMonetization).toHaveBeenCalledWith({
      versions: [{ id: 1 }],
      viewer: { id: OWNER, isModerator: false },
    });
  });

  it('puts the PRICED terms on the wire, not the stored ones', async () => {
    mockGetViewerMonetization.mockResolvedValueOnce({
      1: { paidAccess: gate({ terms: { download: { price: 500 } } }), licensingFee: null },
    });

    const r = resource();
    await applyPaidAccessGating([r], { id: 2 });

    expect(r.paidAccess?.terms).toEqual({ download: { price: 500 } });
  });
});

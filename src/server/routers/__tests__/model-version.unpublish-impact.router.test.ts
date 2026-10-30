import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `getUnpublishImpact` is the branch the cascade design rests on: it prices the refund at the scope
 * the unpublish will actually run at, and returns that scope so the dialog words itself from it.
 * Pricing per-version while the server unpublishes the whole model is the show-one-figure,
 * debit-another divergence the design exists to prevent — and it is invisible to the controller
 * suite, which mocks the resolver.
 */

const { mockResolveUnpublishScope, mockModelRequirement, mockVersionRequirement } = vi.hoisted(
  () => ({
    mockResolveUnpublishScope: vi.fn(),
    mockModelRequirement: vi.fn(),
    mockVersionRequirement: vi.fn(),
  })
);

vi.mock('~/server/services/model-version.service', () => ({
  resolveUnpublishScope: mockResolveUnpublishScope,
}));
vi.mock('~/server/services/model-early-access-refund.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getModelEarlyAccessRefundRequirement: mockModelRequirement,
    getModelVersionEarlyAccessRefundRequirement: mockVersionRequirement,
  };
});

import { getUnpublishImpact } from '~/server/routers/model-version.unpublish-impact';

const VERSION_ID = 100;
const MODEL_ID = 42;

const requirement = (totalBuzz: number, buyerCount = 1) => ({
  purchases: Array.from({ length: buyerCount }, (_, i) => ({
    modelVersionId: VERSION_ID,
    buyerId: 500 + i,
    buzzTransactionIds: [`tx-${i}`],
  })),
  buyerCount,
  totalBuzz,
  totalsByAccount: { yellow: totalBuzz },
  exemptBuyerCount: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockModelRequirement.mockResolvedValue(requirement(900, 3));
  mockVersionRequirement.mockResolvedValue(requirement(300, 1));
});

describe('getUnpublishImpact', () => {
  it('prices the whole model when the take-down will cascade', async () => {
    mockResolveUnpublishScope.mockResolvedValue({ kind: 'model', modelId: MODEL_ID });

    const impact = await getUnpublishImpact(VERSION_ID);

    expect(impact.scope).toBe('model');
    expect(impact.totalBuzz).toBe(900);
    expect(mockModelRequirement).toHaveBeenCalledWith({ id: MODEL_ID });
    // The divergence this exists to prevent: pricing one version while the server takes the model.
    expect(mockVersionRequirement).not.toHaveBeenCalled();
  });

  it('prices the version alone when the model stays up', async () => {
    mockResolveUnpublishScope.mockResolvedValue({ kind: 'version', modelId: MODEL_ID });

    const impact = await getUnpublishImpact(VERSION_ID);

    expect(impact.scope).toBe('version');
    expect(impact.totalBuzz).toBe(300);
    expect(mockVersionRequirement).toHaveBeenCalledWith({ id: VERSION_ID });
    // The mirror direction: over-pricing a version take-down as if the model were coming down would
    // quote a creator for buyers who keep their access.
    expect(mockModelRequirement).not.toHaveBeenCalled();
  });

  it('returns counts only, never a buyer identity', async () => {
    mockResolveUnpublishScope.mockResolvedValue({ kind: 'model', modelId: MODEL_ID });

    const impact = await getUnpublishImpact(VERSION_ID);

    expect(impact).toEqual({
      scope: 'model',
      purchaseCount: 3,
      buyerCount: 3,
      totalBuzz: 900,
      exemptBuyerCount: 0,
    });
  });
});

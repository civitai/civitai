import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/orchestration-client', () => ({
  submitWorkflow: vi.fn(),
  PutObjectCommand: class {},
}));
vi.mock('@aws-sdk/client-s3', () => {
  const PutObjectCommand = class {};
  return { PutObjectCommand, default: { PutObjectCommand } };
});
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/services/cosmetic-phash.service', () => ({
  queueCosmeticPerceptualHash: vi.fn(),
}));
vi.mock('~/server/services/storage-resolver', () => ({ registerMediaLocation: vi.fn() }));
vi.mock('~/utils/s3-utils', () => ({ getImageUploadBackend: vi.fn() }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { syncActiveBadgeMetadata } from '~/server/services/product-badge.service';

const OCT_URL = 'https://image.test/oct-bronze.png';
const AUG_URL = 'https://image.test/aug-bronze.png';

const products = [
  {
    id: 'civitai-bronze',
    provider: 'Civitai',
    metadata: { tier: 'bronze', badge: AUG_URL, badgeType: 'static' },
  },
  {
    id: 'civitai-bronze-legacy',
    provider: 'Civitai',
    metadata: { tier: 'bronze', badge: AUG_URL, badgeType: 'static' },
  },
  {
    id: 'stripe-bronze',
    provider: 'Stripe',
    metadata: { tier: 'bronze', badge: AUG_URL, badgeType: 'static' },
  },
];
const buzzBronze = {
  id: 'civitai-buzz-bronze',
  metadata: {
    tier: 'bronze',
    buzzPurchase: true,
    badge: AUG_URL,
    badgeType: 'none',
    rewardsMultiplier: 1,
  },
};
const buzzSilver = {
  id: 'civitai-buzz-silver',
  metadata: { tier: 'silver', buzzPurchase: true, badge: AUG_URL, badgeType: 'none' },
};

const updatedMetadata = () =>
  Object.fromEntries(
    dbMock.dbWrite.product.update.mock.calls.map(([arg]) => [
      (arg as { where: { id: string } }).where.id,
      (arg as { data: { metadata: Record<string, unknown> } }).data.metadata,
    ])
  );

beforeEach(() => {
  dbMock.dbWrite.product.update.mockReset();
  dbMock.dbRead.product.findMany.mockImplementation((async (args: { where: { id?: unknown } }) =>
    args.where.id ? products : [...products, buzzBronze, buzzSilver]) as never);
});

describe('syncActiveBadgeMetadata', () => {
  it("copies a Civitai cash tier's live badge onto the Buzz product of the same tier, and only that one", async () => {
    dbMock.dbRead.cosmetic.findMany.mockResolvedValue([
      { id: 1, productId: 'civitai-bronze', data: { url: OCT_URL, animated: false } },
    ]);

    await syncActiveBadgeMetadata();

    const updated = updatedMetadata();
    expect(updated['civitai-buzz-bronze']).toEqual({
      ...buzzBronze.metadata,
      badge: OCT_URL,
      badgeType: 'static',
    });
    expect(Object.keys(updated).sort()).toEqual(['civitai-bronze', 'civitai-buzz-bronze']);
  });

  it('copies only from the cash product the Buzz catalog was seeded from', async () => {
    dbMock.dbRead.cosmetic.findMany.mockResolvedValue([
      { id: 3, productId: 'civitai-bronze-legacy', data: { url: OCT_URL, animated: true } },
    ]);

    await syncActiveBadgeMetadata();

    expect(Object.keys(updatedMetadata())).toEqual(['civitai-bronze-legacy']);
  });

  it("never copies another provider's badge onto the Buzz catalog", async () => {
    dbMock.dbRead.cosmetic.findMany.mockResolvedValue([
      { id: 2, productId: 'stripe-bronze', data: { url: OCT_URL, animated: true } },
    ]);

    await syncActiveBadgeMetadata();

    expect(Object.keys(updatedMetadata())).toEqual(['stripe-bronze']);
  });
});

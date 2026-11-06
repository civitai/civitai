import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/orchestration-client', () => ({
  submitWorkflow: vi.fn(),
  PutObjectCommand: class {},
}));
// `default` mirrors the named export: the package is pre-bundled for CJS interop, so consumers
// resolve through `default`.
vi.mock('@aws-sdk/client-s3', () => {
  const PutObjectCommand = class {};
  return { PutObjectCommand, default: { PutObjectCommand } };
});
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/services/cosmetic-phash.service', () => ({
  queueCosmeticPerceptualHash: vi.fn(),
}));
vi.mock('~/server/services/storage-resolver', () => ({ registerMediaLocation: vi.fn() }));
vi.mock('~/server/schema/subscriptions.schema', () => ({
  subscriptionProductMetadataSchema: {},
}));
vi.mock('~/utils/s3-utils', () => ({ getImageUploadBackend: vi.fn() }));
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { upsertProductBadge } from '~/server/services/product-badge.service';

// A stored key at the target size, so the resize short-circuits without the orchestrator.
const STORAGE_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/badge.png';

beforeEach(() => {
  dbMock.dbWrite.cosmetic.create.mockReset().mockImplementation((async ({ data }: never) => ({
    id: 1,
    ...(data as object),
  })) as never);
  dbMock.dbRead.cosmetic.findMany.mockResolvedValue([]);
});

describe('upsertProductBadge', () => {
  // The nightly job deletes non-permanent Membership cosmetics from lapsed members, so false here
  // would revoke past monthly badges on cancel.
  it('creates monthly membership badges as permanent unlocks, one per product', async () => {
    await upsertProductBadge({
      name: 'October Badge',
      badgeUrl: STORAGE_KEY,
      animated: false,
      productIds: ['bronze', 'silver'],
      availableStart: new Date('2026-10-01T07:00:00Z'),
      availableEnd: new Date('2026-10-31T07:00:00Z'),
      sourceWidth: 200,
      sourceHeight: 200,
    });

    const created = dbMock.dbWrite.cosmetic.create.mock.calls.map(
      ([arg]) => (arg as { data: { productId: string; permanentUnlock: boolean } }).data
    );
    expect(
      created.map(({ productId, permanentUnlock }) => ({ productId, permanentUnlock }))
    ).toEqual([
      { productId: 'bronze', permanentUnlock: true },
      { productId: 'silver', permanentUnlock: true },
    ]);
  });
});

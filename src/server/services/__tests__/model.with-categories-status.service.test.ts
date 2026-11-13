import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as SystemCache from '~/server/services/system-cache';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Drives the real getAllModelsWithCategories; I/O stubs follow model.service.vae-append-no-mutation.test.ts.

const OWNER_ID = 5;
const ROWS = [
  { id: 1, name: 'published', status: 'Published' },
  { id: 2, name: 'draft', status: 'Draft' },
  { id: 3, name: 'training', status: 'Training' },
  { id: 4, name: 'private', status: 'Published', availability: 'Private' },
];

type Where = { status: { in: string[] }; availability?: { not: string } };
const visible = ({ where }: { where: Where }) =>
  ROWS.filter(
    (r) =>
      where.status.in.includes(r.status) &&
      (!where.availability || r.availability !== where.availability.not)
  );

vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn().mockResolvedValue({}),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn().mockResolvedValue(false),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(),
  getPublicPaidAccessForModelVersions: vi.fn().mockResolvedValue({}),
  getModelPaidAccessGates: vi.fn().mockResolvedValue(new Map()),
  bustPaidAccessCache: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn().mockResolvedValue(new Map()),
  getUserMetricPrivacyDefaultsMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn().mockResolvedValue({}),
  getProfilePicturesForUsers: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
// This list must track model.service's own import list from this module. A missing name is not a
// test failure — vitest throws it during module evaluation, so the file collects ZERO tests and the
// run stays green with this guard silently absent.
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { fetch: vi.fn() },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: { fetch: vi.fn().mockResolvedValue({}), bust: vi.fn() },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn() },
}));

import { getAllModelsWithCategories } from '~/server/services/model.service';
import { modelTagCache } from '~/server/redis/caches';

const names = async (viewer: { id?: number; isModerator?: boolean } | null) =>
  (await getAllModelsWithCategories({ userId: OWNER_ID, page: 1, limit: 50, viewer })).items.map(
    (m) => m.name
  );

beforeEach(() => {
  const { dbRead } = dbMock;
  dbRead.$transaction.mockImplementation((async (ops: unknown[]) => Promise.all(ops)) as never);
  dbRead.model.findMany.mockImplementation((async (args: { where: Where }) =>
    visible(args)) as never);
  dbRead.model.count.mockImplementation(
    (async (args: { where: Where }) => visible(args).length) as never
  );
  vi.mocked(modelTagCache.fetch).mockResolvedValue({});
});

describe('getAllModelsWithCategories, unpublished and private models', () => {
  it('lists only public models to a signed-out viewer', async () => {
    expect(await names(null)).toEqual(['published']);
  });

  it("lists only public models to another user's viewer", async () => {
    expect(await names({ id: OWNER_ID + 1 })).toEqual(['published']);
  });

  it('lists draft, training and private models to their owner', async () => {
    expect(await names({ id: OWNER_ID })).toEqual(['published', 'draft', 'training', 'private']);
  });

  it('lists draft, training and private models to a moderator', async () => {
    expect(await names({ id: OWNER_ID + 1, isModerator: true })).toEqual([
      'published',
      'draft',
      'training',
      'private',
    ]);
  });
});

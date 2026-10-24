import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CollectionService from '~/server/services/collection.service';
import type * as RegionBlocking from '~/server/utils/region-blocking';
import type { Context } from '~/server/createContext';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

const { mockGetPermissions, mockGetCollectionById, mockIsRegionRestricted } = vi.hoisted(() => ({
  mockGetPermissions: vi.fn(),
  mockGetCollectionById: vi.fn(),
  mockIsRegionRestricted: vi.fn(),
}));

vi.mock('~/server/services/collection.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CollectionService>()),
  getUserCollectionPermissionsById: mockGetPermissions,
  getCollectionById: mockGetCollectionById,
}));
vi.mock('~/server/utils/region-blocking', async (importOriginal) => ({
  ...(await importOriginal<typeof RegionBlocking>()),
  isRegionRestricted: mockIsRegionRestricted,
}));

const { getCollectionByIdHandler } = await import('~/server/controllers/collection.controller');

const levelsOf = (strings: TemplateStringsArray, values: unknown[]) =>
  Prisma.sql(strings, ...(values as never[])).values.filter((v) => typeof v === 'number');

// The pending count a query returns: PG/PG-13 items only when it is held to those levels, every
// item otherwise.
function arrangePending({ sfw, mature }: { sfw: number; mature: number }) {
  dbMock.dbRead.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sfwOnly = levelsOf(strings, values).includes(sfwBrowsingLevelsFlag);
    return [{ pending: sfwOnly ? sfw : sfw + mature }];
  }) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPermissions.mockResolvedValue({ manage: true, read: true, write: false });
  mockGetCollectionById.mockResolvedValue({ id: 10, userId: 1, mode: 'Contest' });
  arrangePending({ sfw: 0, mature: 3 });
});

// civitai.com never allows mature content; civitai.red allows it outside restricted regions.
const call = ({ isGreen, restricted = false }: { isGreen: boolean; restricted?: boolean }) => {
  mockIsRegionRestricted.mockReturnValue(restricted);
  return getCollectionByIdHandler({
    ctx: {
      user: { id: 1 },
      features: { isGreen, canViewNsfw: !isGreen && !restricted },
      req: { headers: { 'cf-ipcountry': 'US' } },
    } as unknown as Context,
    input: { id: 10 },
  });
};

describe('collection.getById review counts by domain', () => {
  it('on civitai.com, counts no mature items and points to the 3 on civitai.red', async () => {
    const { pendingReviewCount, redPendingReviewCount } = await call({ isGreen: true });

    expect(pendingReviewCount).toBe(0);
    expect(redPendingReviewCount).toBe(3);
  });

  // The pointer must already be there when the manager clears the .com items, without a reload:
  // getById is not refetched after a review.
  it('on civitai.com, counts the mature items for the pointer while PG items still wait', async () => {
    arrangePending({ sfw: 2, mature: 3 });

    const { pendingReviewCount, redPendingReviewCount } = await call({ isGreen: true });

    expect(pendingReviewCount).toBe(2);
    expect(redPendingReviewCount).toBe(3);
  });

  it('on civitai.com in a restricted region, points nowhere: civitai.red hides them too', async () => {
    const { pendingReviewCount, redPendingReviewCount } = await call({
      isGreen: true,
      restricted: true,
    });

    expect(pendingReviewCount).toBe(0);
    expect(redPendingReviewCount).toBe(0);
  });

  it('on civitai.red, counts the mature items and points nowhere', async () => {
    const { pendingReviewCount, redPendingReviewCount } = await call({ isGreen: false });

    expect(pendingReviewCount).toBe(3);
    expect(redPendingReviewCount).toBe(0);
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('on civitai.red in a restricted region, counts only what its queue shows', async () => {
    const { pendingReviewCount, redPendingReviewCount } = await call({
      isGreen: false,
      restricted: true,
    });

    expect(pendingReviewCount).toBe(0);
    expect(redPendingReviewCount).toBe(0);
  });
});

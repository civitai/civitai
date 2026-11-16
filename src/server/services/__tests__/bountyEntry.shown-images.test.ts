import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { constants } from '~/server/common/constants';

vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  checkEntityImageKeys: vi.fn(async () => []),
  createEntityImages: vi.fn(async () => []),
  invalidateManyImageExistence: vi.fn(),
  updateEntityImages: vi.fn(async () => []),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/file.service', () => ({
  getFilesByEntity: vi.fn(async () => []),
  updateEntityFiles: vi.fn(),
}));
vi.mock('~/server/services/bounty.service', () => ({
  settleBountyPayout: vi.fn(),
  refundUnpayableBountyAward: vi.fn(),
}));
vi.mock('~/server/services/text-scan/submit', () => ({ scanEntityInBackground: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({
  userBountyEntryCountCache: { refresh: vi.fn() },
}));

import { upsertBountyEntry } from '~/server/services/bountyEntry.service';
import { updateEntityImages } from '~/server/services/image.service';

describe('upsertBountyEntry — images the edit form was not shown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
    dbMock.dbWrite.bountyEntry.update.mockResolvedValue({ id: 3, userId: 5 } as never);
  });

  it('passes the ids the form was shown through to the image links', async () => {
    await upsertBountyEntry({
      id: 3,
      bountyId: 9,
      userId: 5,
      files: [],
      images: [{ url: '00000000-0000-4000-8000-000000000000' }],
      shownImageIds: [1, 2],
    } as never);
    expect(vi.mocked(updateEntityImages).mock.calls[0][0]).toMatchObject({
      entityId: 3,
      entityType: 'BountyEntry',
      shownImageIds: [1, 2],
      maxLinked: constants.bounties.maxEntryImagesForEdit,
    });
  });

  it('replaces the set and holds it to the entry limit for a caller that read none', async () => {
    await upsertBountyEntry({
      id: 3,
      bountyId: 9,
      userId: 5,
      files: [],
      images: [{ url: '00000000-0000-4000-8000-000000000000' }],
      replaceImages: true,
    } as never);
    expect(vi.mocked(updateEntityImages).mock.calls[0][0]).toMatchObject({
      shownImageIds: 'all',
      maxLinked: constants.bounties.maxEntryImagesForEdit,
    });
  });

  it('refuses a new entry with no image', async () => {
    await expect(
      upsertBountyEntry({ bountyId: 9, userId: 5, files: [], images: [] } as never)
    ).rejects.toThrow('At least one example image');
    expect(dbMock.dbWrite.bountyEntry.create).not.toHaveBeenCalled();
  });
});

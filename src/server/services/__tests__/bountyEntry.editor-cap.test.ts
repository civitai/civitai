import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

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

  it('passes the editor’s cap through to the image links', async () => {
    await upsertBountyEntry({
      id: 3,
      bountyId: 9,
      userId: 5,
      files: [],
      images: [{ url: '00000000-0000-4000-8000-000000000000' }],
      editorCap: 3,
    } as never);
    expect(vi.mocked(updateEntityImages).mock.calls[0][0]).toMatchObject({
      entityId: 3,
      entityType: 'BountyEntry',
      editorCap: 3,
    });
  });
});

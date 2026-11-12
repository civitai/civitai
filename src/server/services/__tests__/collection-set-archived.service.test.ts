import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// setCollectionArchived requeues the search index and marks the row fresh — neither is under
// test here, so stub them so the module loads without reaching real infra.
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
  getKyselyWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const { setCollectionArchived } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const OTHER_ID = 777;

function arrange({
  userId = OWNER_ID,
  mode = null,
}: {
  userId?: number;
  mode?: string | null;
} = {}) {
  mockDbRead.collection.findUnique.mockResolvedValue({ id: COLLECTION_ID, userId, mode });
  mockDbWrite.collection.update.mockResolvedValue({ id: COLLECTION_ID });
}

describe('setCollectionArchived', () => {
  beforeEach(() => vi.clearAllMocks());

  it('archives the owner’s own collection with a timestamp', async () => {
    arrange();
    await setCollectionArchived({ id: COLLECTION_ID, archived: true, userId: OWNER_ID });
    const call = mockDbWrite.collection.update.mock.calls[0][0];
    expect(call.data.archivedAt).toBeInstanceOf(Date);
  });

  it('unarchives by clearing the timestamp', async () => {
    arrange();
    await setCollectionArchived({ id: COLLECTION_ID, archived: false, userId: OWNER_ID });
    const call = mockDbWrite.collection.update.mock.calls[0][0];
    expect(call.data.archivedAt).toBeNull();
  });

  it('refuses to archive a collection the caller does not own', async () => {
    arrange({ userId: OWNER_ID });
    await expect(
      setCollectionArchived({ id: COLLECTION_ID, archived: true, userId: OTHER_ID })
    ).rejects.toThrow();
    expect(mockDbWrite.collection.update).not.toHaveBeenCalled();
  });

  it('lets a moderator archive a collection they do not own', async () => {
    arrange({ userId: OWNER_ID });
    await setCollectionArchived({
      id: COLLECTION_ID,
      archived: true,
      userId: OTHER_ID,
      isModerator: true,
    });
    expect(mockDbWrite.collection.update).toHaveBeenCalled();
  });

  it('refuses to archive a Bookmark collection (no UI path back)', async () => {
    arrange({ mode: 'Bookmark' });
    await expect(
      setCollectionArchived({ id: COLLECTION_ID, archived: true, userId: OWNER_ID })
    ).rejects.toThrow();
    expect(mockDbWrite.collection.update).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
} from '~/server/common/constants';

type QueuedCall = [{ indexName: string; items: { id: number; action: string }[] }];

const { mockQueueUpdate } = vi.hoisted(() => ({
  mockQueueUpdate: vi.fn(async () => true),
}));

vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { queueUpdate: mockQueueUpdate },
}));

const { queueOwnedContentUpdate } = await import('~/server/search-index/user-content-reindex');

const USER_ID = 8105;
const rows = (...ids: number[]) => ids.map((id) => ({ id }));
const callsFor = (indexName: string) =>
  (mockQueueUpdate.mock.calls as unknown as QueuedCall[]).filter(
    ([call]) => call.indexName === indexName
  );
const queuedIds = (indexName: string) =>
  callsFor(indexName).flatMap(([call]) => call.items.map((item) => item.id));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('queueOwnedContentUpdate', () => {
  it("queues the owner's content in every index that embeds their username", async () => {
    dbMock.dbRead.model.findMany.mockResolvedValueOnce(rows(1, 2));
    dbMock.dbRead.article.findMany.mockResolvedValueOnce(rows(3));
    dbMock.dbRead.collection.findMany.mockResolvedValueOnce(rows(4));
    dbMock.dbRead.bounty.findMany.mockResolvedValueOnce(rows(5));
    dbMock.dbRead.comicProject.findMany.mockResolvedValueOnce(rows(6));

    await queueOwnedContentUpdate(USER_ID);

    expect(dbMock.dbRead.model.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER_ID } })
    );
    expect(mockQueueUpdate).toHaveBeenCalledWith({
      indexName: MODELS_SEARCH_INDEX,
      items: [
        { id: 1, action: 'Update' },
        { id: 2, action: 'Update' },
      ],
    });
    expect(queuedIds(ARTICLES_SEARCH_INDEX)).toEqual([3]);
    expect(queuedIds(COLLECTIONS_SEARCH_INDEX)).toEqual([4]);
    expect(queuedIds(BOUNTIES_SEARCH_INDEX)).toEqual([5]);
    expect(queuedIds(COMICS_SEARCH_INDEX)).toEqual([6]);
  });

  it('queues nothing for an index the user owns nothing in', async () => {
    await queueOwnedContentUpdate(USER_ID);

    expect(mockQueueUpdate).not.toHaveBeenCalled();
  });

  it('queues a large account in bounded chunks without dropping ids', async () => {
    const ids = Array.from({ length: 2500 }, (_, i) => i + 1);
    dbMock.dbRead.model.findMany.mockResolvedValueOnce(rows(...ids));

    await queueOwnedContentUpdate(USER_ID);

    expect(callsFor(MODELS_SEARCH_INDEX)).toHaveLength(3);
    expect(queuedIds(MODELS_SEARCH_INDEX)).toEqual(ids);
  });

  it('a failing index is logged and does not stop the others or throw', async () => {
    dbMock.dbRead.model.findMany.mockResolvedValueOnce(rows(1));
    dbMock.dbRead.article.findMany.mockRejectedValueOnce(new Error('statement timeout'));
    dbMock.dbRead.collection.findMany.mockResolvedValueOnce(rows(4));

    await expect(queueOwnedContentUpdate(USER_ID)).resolves.toBeUndefined();

    expect(queuedIds(MODELS_SEARCH_INDEX)).toEqual([1]);
    expect(queuedIds(COLLECTIONS_SEARCH_INDEX)).toEqual([4]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'owned-content-search-index',
        indexName: ARTICLES_SEARCH_INDEX,
      })
    );
  });
});

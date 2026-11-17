import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as MeiliUtil from '~/server/meilisearch/util';

const updateDocs = vi.fn();
const onSearchIndexDocumentsCleanup = vi.fn();

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  updateDocs: (...args: unknown[]) => updateDocs(...args),
}));

vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  onSearchIndexDocumentsCleanup: (...args: unknown[]) => onSearchIndexDocumentsCleanup(...args),
}));

const { pullData, transformIndexData, pushData, queueAllComicsForRefresh, comicsSearchIndex } =
  await import('~/server/search-index/comics.search-index');

const comicRow = (id: number) => ({
  id,
  name: `comic ${id}`,
  description: null,
  genre: null,
  nsfwLevel: 1,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  userId: 100,
  coverImageUrl: null,
  coverImageNsfwLevel: null,
  user: { id: 100, username: 'someone', deletedAt: null, image: null, profilePictureId: null },
  stats: null,
});

const run = async (batch: Parameters<typeof pullData>[1], rows: ReturnType<typeof comicRow>[]) => {
  const db = { $queryRaw: vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]) };
  const ctx = { db, indexName: 'comics', logger: () => undefined } as unknown as Parameters<
    typeof pullData
  >[0];
  const pulled = await pullData(ctx, batch);
  if (pulled) await pushData(ctx, await transformIndexData(pulled));
};

beforeEach(() => {
  updateDocs.mockReset();
  onSearchIndexDocumentsCleanup.mockReset();
});

describe('comics search index :: documents whose comic no longer qualifies', () => {
  it('deletes the documents of requested comics the rule no longer keeps, and upserts the rest', async () => {
    await run({ type: 'update', ids: [1, 2, 3] }, [comicRow(1)]);

    expect(onSearchIndexDocumentsCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ indexName: 'comics', ids: [2, 3] })
    );
    expect(updateDocs).toHaveBeenCalledWith(
      expect.objectContaining({ documents: [expect.objectContaining({ id: 1 })] })
    );
  });

  it('deletes every requested id when none still qualifies', async () => {
    await run({ type: 'update', ids: [7, 8] }, []);

    expect(onSearchIndexDocumentsCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [7, 8] })
    );
  });

  it('deletes nothing on a range batch, where absence is the normal case', async () => {
    await run({ type: 'new', startId: 1, endId: 1000 }, [comicRow(4)]);

    expect(onSearchIndexDocumentsCleanup).not.toHaveBeenCalled();
  });
});

describe('comics search index :: the refresh pass', () => {
  // A ban, hold or image flag changes no comic row, so only the pass brings such a comic back
  // through pullData, which deletes it (above).
  it('queues every comic for an update, never forwarded to the semantic sync', async () => {
    const queueUpdate = vi
      .spyOn(comicsSearchIndex, 'queueUpdate')
      .mockResolvedValue(undefined as never);
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ id: 4 }, { id: 9 }]) };

    await expect(queueAllComicsForRefresh(db as never)).resolves.toBe(2);

    expect(queueUpdate).toHaveBeenCalledWith(
      [
        { id: 4, action: 'Update' },
        { id: 9, action: 'Update' },
      ],
      { reason: 'refresh' }
    );
    queueUpdate.mockRestore();
  });
});

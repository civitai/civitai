import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { getHeldGalleryLevel, migrateResourceToCollection } from '~/server/services/model.service';
import { recordedOwnership } from './model-ownership-db';

/**
 * Splitting a model into a collection creates one model per extra version. Each new model records its
 * owner as its first, in the same transaction, so a hold on that owner follows it after a transfer.
 */

const OWNER = 7;

const published = (id: number) => ({ id, name: `v${id}`, status: 'Published', nsfwLevel: 1 });

/** The model 1 being split, with three published versions, and the writes the split makes. */
function stubSplit() {
  vi.mocked(dbMock.dbRead.model.findUnique).mockResolvedValue({
    id: 1,
    name: 'Model',
    userId: OWNER,
    status: 'Published',
    locked: false,
    mode: null,
    tosViolation: false,
    nsfw: false,
    nsfwLevel: 1,
    meta: {},
    gallerySettings: null,
    modelVersions: [published(10), published(11), published(12)],
    tagsOnModels: [],
    licenses: [],
    resourceReviews: [],
  } as never);
  let created = 100;
  vi.mocked(dbMock.dbWrite.model.create).mockImplementation((async () => ({
    id: ++created,
  })) as never);
  vi.mocked(dbMock.dbWrite.collection.create).mockResolvedValue({ id: 5 } as never);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementationOnce((async (
    fn: (client: unknown) => unknown
  ) => fn(dbMock.dbWrite)) as never);
}

describe('migrateResourceToCollection', () => {
  it('looks up the model of each version it moves afresh', async () => {
    installFakeCacheRedis();
    stubSplit();
    vi.mocked(dbMock.dbRead.model.findFirst).mockResolvedValue({
      id: 1,
      userId: OWNER,
      minor: false,
      sfwOnly: false,
      gallerySettings: null,
    } as never);
    vi.mocked(dbMock.dbWrite.model.update).mockResolvedValue({ id: 1, userId: OWNER } as never);
    const lookup = vi.mocked(dbMock.dbRead.modelVersion.findMany);
    lookup.mockResolvedValue([{ id: 11, modelId: 1 }] as never);
    await getHeldGalleryLevel({ modelVersionId: 11 });
    await getHeldGalleryLevel({ modelVersionId: 11 });
    expect(lookup).toHaveBeenCalledTimes(1);

    await migrateResourceToCollection({ id: 1, collectionName: 'c' } as never);
    lookup.mockClear();
    await getHeldGalleryLevel({ modelVersionId: 11 });

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('looks the moved versions up again after a lagging read re-caches them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      installFakeCacheRedis();
      stubSplit();
      vi.mocked(dbMock.dbRead.model.findFirst).mockResolvedValue({
        id: 1,
        userId: OWNER,
        minor: false,
        sfwOnly: false,
        gallerySettings: null,
      } as never);
      vi.mocked(dbMock.dbWrite.model.update).mockResolvedValue({ id: 1, userId: OWNER } as never);
      const lookup = vi.mocked(dbMock.dbRead.modelVersion.findMany);
      lookup.mockResolvedValue([{ id: 11, modelId: 1 }] as never);

      await migrateResourceToCollection({ id: 1, collectionName: 'c' } as never);
      await vi.advanceTimersByTimeAsync(3_000);
      lookup.mockClear();
      await getHeldGalleryLevel({ modelVersionId: 11 });
      await getHeldGalleryLevel({ modelVersionId: 11 });
      expect(lookup).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3_000);
      await getHeldGalleryLevel({ modelVersionId: 11 });

      expect(lookup).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the owner of every model it creates, in its transaction', async () => {
    vi.mocked(dbMock.dbRead.model.findUnique).mockResolvedValue({
      id: 1,
      name: 'Model',
      userId: OWNER,
      status: 'Published',
      locked: false,
      mode: null,
      tosViolation: false,
      nsfw: false,
      nsfwLevel: 1,
      meta: {},
      gallerySettings: null,
      modelVersions: [published(10), published(11), published(12)],
      tagsOnModels: [],
      licenses: [],
      resourceReviews: [],
    } as never);
    let created = 100;
    vi.mocked(dbMock.dbWrite.model.create).mockImplementation((async () => ({
      id: ++created,
    })) as never);
    vi.mocked(dbMock.dbWrite.collection.create).mockResolvedValue({ id: 5 } as never);
    // A distinct client with its own raw writer, so a write on dbWrite would not pass for one on it.
    const txExecuteRaw = vi.fn(async () => 1);
    const tx = new Proxy(dbMock.dbWrite, {
      get: (target, key) =>
        key === '$executeRaw' ? txExecuteRaw : (target as Record<string | symbol, unknown>)[key],
    });
    vi.mocked(dbMock.dbWrite.$transaction).mockImplementationOnce((async (
      fn: (client: unknown) => unknown
    ) => fn(tx)) as never);

    // What follows the commit (caches, search) is not under test.
    await migrateResourceToCollection({ id: 1, collectionName: 'c' } as never).catch(
      () => undefined
    );

    const statements = (txExecuteRaw.mock.calls as unknown as [Prisma.Sql][])
      .map(([sql]) => sql)
      .filter((sql) => sql.text.includes('"ModelOwnership"'));
    const rows = await recordedOwnership(
      [
        [1, OWNER],
        [101, OWNER],
        [102, OWNER],
      ],
      statements
    );
    expect(rows).toEqual([
      { modelId: 101, userId: OWNER, reason: 'create', actorId: null },
      { modelId: 102, userId: OWNER, reason: 'create', actorId: null },
    ]);
  });
});

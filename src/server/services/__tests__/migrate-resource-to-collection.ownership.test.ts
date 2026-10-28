import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { migrateResourceToCollection } from '~/server/services/model.service';
import { recordedOwnership } from './model-ownership-db';

/**
 * Splitting a model into a collection creates one model per extra version. Each new model records its
 * owner as its first, in the same transaction, so a hold on that owner follows it after a transfer.
 */

const OWNER = 7;

describe('migrateResourceToCollection', () => {
  it('records the owner of every model it creates, in its transaction', async () => {
    const published = (id: number) => ({ id, name: `v${id}`, status: 'Published', nsfwLevel: 1 });
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

import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Runs the endpoint's real id queries against an in-process Postgres, through its real query
 * schema. By default it queues every indexed taken-down model, and no other. With
 * `target=collections` it queues, a page of taken-down models at a time, the collections showing
 * their images, and reads them back from the queue.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const {
  env,
  queueModelsReindex,
  collectionsOf,
  enqueueCollectionRebuild,
  queuedCollections,
  getQueue,
  coverLegUsable,
} = vi.hoisted(() => {
  const queuedCollections = new Set<number>();
  return {
    env: {
      WEBHOOK_TOKEN: 'test-token',
      LOGGING: '',
      NEXTAUTH_URL: 'https://example.test',
      TRPC_ORIGINS: [] as string[],
    },
    queueModelsReindex: vi.fn(async (ids: number[]) => ({ ids: ids.length })),
    // Model n's images show in collections 10n and 100 (shared, so it must be queued once).
    collectionsOf: vi.fn(
      async ({
        modelId,
      }: {
        modelId: number;
      }): Promise<{
        collectionIds: number[];
        truncated: boolean;
        failed?: boolean;
      }> => ({ collectionIds: [modelId * 10, 100], truncated: false })
    ),
    enqueueCollectionRebuild: vi.fn(async ({ collectionIds }: { collectionIds: number[] }) => {
      for (const id of collectionIds) queuedCollections.add(id);
      return { queued: collectionIds.length, truncated: false };
    }),
    queuedCollections,
    getQueue: vi.fn(async () => ({ content: [...queuedCollections] })),
    coverLegUsable: vi.fn(async () => true),
  };
});

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
// The models queueing and its read-back are queue-paid-models-reindex-endpoint.test.ts's to pin.
vi.mock('~/server/search-index/queue-models-reindex', () => ({ queueModelsReindex }));
// The collections queue, as the read-back sees it.
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { getQueue },
}));
// The lookup's SQL is collection-media-index-model-images.behavior.test.ts's to pin.
vi.mock('~/server/services/collection-media-index', () => ({
  getCollectionIdsForModelImages: collectionsOf,
  enqueueCollectionRebuild,
  isCoverLegUsable: coverLegUsable,
}));

const handler = (await import('~/pages/api/admin/temp/queue-takendown-models-reindex')).default;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Published', 'Unpublished', 'Deleted');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, status "ModelStatus", availability "Availability" DEFAULT 'Public',
      mode "ModelModifier"
    );
    -- 1 and 2 are indexed and taken down; 3 is taken down but a draft; 4 taken down but
    -- unsearchable; 5 archived; 6 in no mode.
    INSERT INTO "Model" (id, status, availability, mode) VALUES
      (1, 'Published', 'Public', 'TakenDown'),
      (2, 'Published', 'Private', 'TakenDown'),
      (3, 'Draft', 'Public', 'TakenDown'),
      (4, 'Published', 'Unsearchable', 'TakenDown'),
      (5, 'Published', 'Public', 'Archived'),
      (6, 'Published', 'Public', NULL);
  `);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    pgliteRaw(db).queryRaw
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  queuedCollections.clear();
});

type Page = {
  models: number;
  nextAfterId: number | null;
  collections: number;
  failedModelIds: number[];
  truncated: boolean;
  dryRun: boolean;
  landed?: number;
};
let body: Page = {} as Page;
async function call(query: Record<string, string>) {
  const req = { method: 'POST', query: { token: 'test-token', ...query }, headers: {} } as never;
  let statusCode = 0;
  body = {} as Page;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: (sent: Page) => {
      body = sent;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  await handler(req, res as never);
  return statusCode;
}

const lookedUp = () => collectionsOf.mock.calls.map(([arg]) => arg.modelId);
const enqueued = () =>
  enqueueCollectionRebuild.mock.calls.flatMap(([arg]) => arg.collectionIds).sort((a, b) => a - b);

describe('/api/admin/temp/queue-takendown-models-reindex', () => {
  it('queues every indexed taken-down model, and no other, and no collection', async () => {
    expect(await call({ dryRun: 'false' })).toBe(200);
    const [ids] = queueModelsReindex.mock.calls.at(-1) as unknown as [number[]];
    expect([...ids].sort()).toEqual([1, 2]);
    expect(collectionsOf).not.toHaveBeenCalled();
  });

  describe('target=collections', () => {
    it("queues the collections showing any taken-down model's images, indexed or not, once each", async () => {
      expect(await call({ target: 'collections', dryRun: 'false' })).toBe(200);
      expect(queueModelsReindex).not.toHaveBeenCalled();
      expect(lookedUp()).toEqual([1, 2, 3, 4]);
      expect(enqueued()).toEqual([10, 20, 30, 40, 100]);
      expect(body).toMatchObject({
        models: 4,
        nextAfterId: null,
        collections: 5,
        landed: 5,
        failedModelIds: [],
        truncated: false,
        dryRun: false,
      });
      // Read back without checking the queue out, so the sync still gets it.
      expect(getQueue).toHaveBeenCalledWith('collections_v3', 'Update', true);
    });

    it.each([true, false])(
      'checks the cover leg once per page and hands the answer (%s) to every lookup',
      async (usable) => {
        coverLegUsable.mockResolvedValueOnce(usable);
        expect(await call({ target: 'collections', dryRun: 'true' })).toBe(200);
        expect(coverLegUsable).toHaveBeenCalledTimes(1);
        expect(
          collectionsOf.mock.calls.map(([arg]) => (arg as { withCover?: boolean }).withCover)
        ).toEqual([usable, usable, usable, usable]);
        expect(body).toMatchObject({ coverLeg: usable });
      }
    );

    it.each([
      ['take', '0'],
      ['take', '201'],
      ['afterId', '-1'],
    ])('refuses %s=%s and queues nothing', async (param, value) => {
      expect(await call({ target: 'collections', dryRun: 'false', [param]: value })).toBe(400);
      expect(collectionsOf).not.toHaveBeenCalled();
      expect(enqueueCollectionRebuild).not.toHaveBeenCalled();
    });

    it('takes a page of models at a time and says where the next page starts', async () => {
      expect(await call({ target: 'collections', dryRun: 'false', take: '2' })).toBe(200);
      expect(lookedUp()).toEqual([1, 2]);
      expect(body).toMatchObject({ models: 2, nextAfterId: 2, collections: 3 });

      collectionsOf.mockClear();
      expect(await call({ target: 'collections', dryRun: 'false', take: '2', afterId: '2' })).toBe(
        200
      );
      expect(lookedUp()).toEqual([3, 4]);
      expect(body).toMatchObject({ models: 2, nextAfterId: 2 + 2 });

      collectionsOf.mockClear();
      expect(await call({ target: 'collections', dryRun: 'false', take: '2', afterId: '4' })).toBe(
        200
      );
      expect(lookedUp()).toEqual([]);
      expect(body).toMatchObject({ models: 0, nextAfterId: null });
    });

    it.each(['true', '1', 'yes'])(
      'counts the collections and queues none on a dry run (dryRun=%s)',
      async (dryRun) => {
        expect(await call({ target: 'collections', dryRun })).toBe(200);
        expect(lookedUp()).toEqual([1, 2, 3, 4]);
        expect(enqueueCollectionRebuild).not.toHaveBeenCalled();
        expect(body).toMatchObject({ models: 4, collections: 5, dryRun: true });
        expect(body.landed).toBeUndefined();
      }
    );

    it('queues nothing for a dryRun it cannot read', async () => {
      expect(await call({ target: 'collections', dryRun: 'abc' })).toBe(400);
      expect(enqueueCollectionRebuild).not.toHaveBeenCalled();
    });

    it('names a model whose lookup failed, and passes on a lookup cut short', async () => {
      collectionsOf
        .mockImplementationOnce(async () => ({ collectionIds: [], truncated: false, failed: true }))
        .mockImplementationOnce(async ({ modelId }) => ({
          collectionIds: [modelId * 10],
          truncated: true,
        }));
      expect(await call({ target: 'collections', dryRun: 'false' })).toBe(200);
      expect(body).toMatchObject({ failedModelIds: [1], truncated: true });
      expect(enqueueCollectionRebuild).toHaveBeenCalledWith(
        expect.objectContaining({ truncated: true })
      );
    });

    it('reports what did not reach the queue', async () => {
      enqueueCollectionRebuild.mockImplementationOnce(async () => ({
        queued: 0,
        truncated: false,
      }));
      expect(await call({ target: 'collections', dryRun: 'false' })).toBe(200);
      expect(body).toMatchObject({ collections: 5, landed: 0 });
    });
  });
});

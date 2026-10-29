import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Coverage for the two model removal paths, which want OPPOSITE things.
 *
 * `collections_v3` denormalizes an image for each of a collection's first items, and
 * `prepareBatches` in collections.search-index.ts filters on
 * `c."createdAt" >= lastUpdatedAt` — so the incremental sweep only ever revisits NEWLY
 * CREATED collections. An existing collection is rebuilt only when something enqueues
 * it explicitly.
 *
 *   permaDeleteModelById  MUST enqueue. The rows genuinely go away, so the document
 *                         would otherwise keep a thumbnail that no longer resolves.
 *                         These tests assert the real resolve→enqueue chain: the
 *                         collections index client is the only thing mocked, so the
 *                         payload assertions pin the ids and the action that actually
 *                         reach it, and the ordering assertions pin that the resolve
 *                         happens before the cascade removes what it reads.
 *
 *   deleteModelById       MUST NOT enqueue. A soft delete leaves every row intact and
 *                         the index CTEs filter only on ingestion/needsReview, so a
 *                         rebuild re-emits the same image — the enqueue was a provable
 *                         no-op costing up to 10,000 queue writes per delete. The test
 *                         below pins its absence; see the comment there for what would
 *                         have to change for it to be worth re-adding.
 *
 * `unpublishModelById` was in an earlier revision of this file for the same reason as
 * the soft delete, and is not exercised here at all now that it has no enqueue.
 *
 * Fixture discipline: the model id, the collection ids and the version/post/image ids
 * are pairwise distinct and distinct from one another's magnitudes, so an id read from
 * the wrong variable cannot satisfy an assertion by coincidence.
 */

const {
  mockCollectionsQueueUpdate,
  mockModelsQueueUpdate,
  mockQueueImageSearchIndexUpdate,
  mockDeleteBidsForModel,
} = vi.hoisted(() => ({
  mockCollectionsQueueUpdate: vi.fn(),
  mockModelsQueueUpdate: vi.fn(),
  mockQueueImageSearchIndexUpdate: vi.fn(),
  mockDeleteBidsForModel: vi.fn(async () => ({ refundFailed: [] as string[] })),
}));

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
  preventModelVersionLagBatch: vi.fn(),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, Tracker: class {} }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(() => false), FLIPT_FEATURE_FLAGS: {} }));
vi.mock('~/server/metrics', () => ({ modelMetrics: {} }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: {},
  modelTagCache: { refresh: vi.fn() },
  modelVotableTagsCache: { bust: vi.fn() },
  userBasicCache: {},
  userModelCountCache: { refresh: vi.fn() },
}));

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: mockModelsQueueUpdate },
}));
vi.mock('~/server/search-index/collections.search-index', () => ({
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
}));
vi.mock('~/server/search-index/models.search-index', () => ({
  modelsSearchIndex: { queueUpdate: mockModelsQueueUpdate },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: mockDeleteBidsForModel,
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/collection.service', () => ({
  getAvailableCollectionItemsFilterForUser: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  saveItemInCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn(),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getUnavailableResources: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: {},
  queueImageSearchIndexUpdate: mockQueueImageSearchIndexUpdate,
}));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: {} }));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(),
  bustPublicModelResponseCache: vi.fn(),
  createModelVersionPostFromTraining: vi.fn(),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
vi.mock('~/server/services/subscriptions.service', () => ({ getHighestTierSubscription: vi.fn() }));
vi.mock('~/server/services/system-cache', () => ({ getCategoryTags: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
  getProfilePicturesForUsers: vi.fn(),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  bustFetchThroughCache: vi.fn(),
  fetchThroughCache: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObjects: vi.fn() }));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: vi.fn() }));

import {
  deleteModelById,
  MODEL_KEPT_FOR_HELD_COMMENT,
  MODEL_KEPT_FOR_HOLD,
  permaDeleteModelById,
} from '~/server/services/model.service';
import { HOLD_UNCONFIRMED } from '~/server/services/legal-hold.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { deleteModelFileObjects } from '~/utils/s3-utils';
import { userModelCountCache } from '~/server/redis/caches';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const MODEL_ID = 4212;
const OWNER_ID = 3307;
const VERSION_ID = 5150;
const COLLECTION_A = 8801;
const COLLECTION_B = 9107;

/**
 * The only `$queryRaw` these paths issue against `CollectionItem` is the collections
 * resolver's. Branching on the SQL rather than on call order means the assertion does
 * not silently start reading someone else's query if one is added later.
 */
function primeCollectionLookup(collectionIds: number[]) {
  mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.from(strings).join('?');
    if (sql.includes('"CollectionItem"'))
      return collectionIds.map((collectionId) => ({ collectionId }));
    if (isModelDelete(sql)) return [DELETED_MODEL];
    return [];
  });
}

/** The permanent delete's own statement; it returns the row it deleted. */
const isModelDelete = (sql: string) => sql.includes('DELETE FROM "Model"');
const DELETED_MODEL = { id: MODEL_ID, userId: OWNER_ID, nsfwLevel: 1 };

const expectedUpdatePayload = (ids: number[]) =>
  ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }));

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(mockDbWrite) : Promise.all(arg)
  );
  primeCollectionLookup([COLLECTION_A, COLLECTION_B]);
});

describe('deleteModelById — soft delete', () => {
  beforeEach(() => {
    mockDbWrite.model.update.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      nsfwLevel: 1,
      modelVersions: [{ id: VERSION_ID }],
    });
  });

  // 🔴 DELIBERATELY NO ENQUEUE. An earlier revision queued a collections rebuild here.
  // It was provably a no-op: the index's image CTEs filter only on
  // `i."ingestion" = 'Scanned' AND i."needsReview" IS NULL` — no `Model.status`, no
  // `Model.deletedAt` — and a soft delete leaves the Model, Post and Image rows intact,
  // so the rebuild re-emits the same image. The cost was up to 10,000 Meilisearch
  // enqueues per soft delete for no change in output. When the image is genuinely
  // removed, deleteImageById/deleteImages enqueue it themselves.
  //
  // If the product answer is "hide a soft-deleted model's images from collection
  // cards", the CTE predicate and this enqueue are needed TOGETHER — neither alone
  // does anything. Re-adding the enqueue by itself will not fix that, which is what
  // this guard is here to say.
  it('does not queue a collections rebuild, which would be a no-op', async () => {
    await deleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });

  /** Runs deleteModelById on a transaction of its own; `recorded` is what the status record reports. */
  async function deleteInTx(
    recorded: number,
    by: { userId: number | null; isModerator?: boolean } = { userId: OWNER_ID }
  ) {
    const order: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('?').includes("'statusAtDelete'"))
          order.push(`record:${values.join(',')}`);
        return recorded;
      }),
      model: {
        update: vi.fn(async () => {
          order.push('delete');
          return {
            id: MODEL_ID,
            userId: OWNER_ID,
            nsfwLevel: 1,
            modelVersions: [{ id: VERSION_ID }],
          };
        }),
      },
    };
    mockDbWrite.$transaction.mockImplementationOnce((async (fn: (t: typeof tx) => unknown) =>
      fn(tx)) as never);
    await deleteModelById({ id: MODEL_ID, ...by } as any);
    const [[{ data }]] = tx.model.update.mock.calls as unknown as [[{ data: object }]];
    return { order, data };
  }

  // The creator score reads statusAtDelete; recorded after the update it would always read 'Deleted',
  // and recorded outside the transaction it would survive a rolled-back delete.
  it('records the status at delete for this model, in the transaction, before writing Deleted', async () => {
    const { order, data } = await deleteInTx(1);

    expect(order).toEqual([`record:${MODEL_ID}`, 'delete']);
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(data).toMatchObject({ status: 'Deleted', deletedBy: OWNER_ID });
  });

  // The score reads deletedBy, so a second delete by the owner must not replace a moderator's.
  it('keeps the first actor and time when the model was already deleted', async () => {
    const { data } = await deleteInTx(0);

    expect(data).toMatchObject({ status: 'Deleted' });
    expect(data).not.toHaveProperty('deletedBy');
    expect(data).not.toHaveProperty('deletedAt');
  });

  // The account wipe soft-deletes another account's model this way, as a moderator.
  it("soft-deletes another account's model for a moderator, recording the moderator", async () => {
    const { data } = await deleteInTx(1, { userId: 77, isModerator: true });

    expect(data).toMatchObject({ status: 'Deleted', deletedBy: 77 });
  });

  it('hands its caller the bid refunds that failed, with the versions they were on', async () => {
    mockDeleteBidsForModel.mockResolvedValueOnce({ refundFailed: ['tx-1'] });
    const onBidRefundFailed = vi.fn();
    mockDbWrite.$transaction.mockImplementationOnce((async (fn: (t: unknown) => unknown) =>
      fn({
        $executeRaw: vi.fn(async () => 1),
        model: {
          update: vi.fn(async () => ({
            id: MODEL_ID,
            userId: OWNER_ID,
            nsfwLevel: 1,
            modelVersions: [{ id: VERSION_ID }],
          })),
        },
      })) as never);

    await deleteModelById({ id: MODEL_ID, userId: 77, isModerator: true, onBidRefundFailed });

    expect(onBidRefundFailed).toHaveBeenCalledWith({
      versionIds: [VERSION_ID],
      transactionIds: ['tx-1'],
    });
  });

  it('hands its caller a refund that threw, and still returns the deleted model', async () => {
    mockDeleteBidsForModel.mockRejectedValueOnce(new Error('buzz down'));
    const onBidRefundFailed = vi.fn();
    mockDbWrite.$transaction.mockImplementationOnce((async (fn: (t: unknown) => unknown) =>
      fn({
        $executeRaw: vi.fn(async () => 1),
        model: {
          update: vi.fn(async () => ({
            id: MODEL_ID,
            userId: OWNER_ID,
            nsfwLevel: 1,
            modelVersions: [{ id: VERSION_ID }],
          })),
        },
      })) as never);

    await expect(
      deleteModelById({ id: MODEL_ID, userId: 77, isModerator: true, onBidRefundFailed })
    ).resolves.toMatchObject({ id: MODEL_ID });
    expect(onBidRefundFailed).toHaveBeenCalledWith({
      versionIds: [VERSION_ID],
      error: 'buzz down',
    });
  });

  // The delete has committed by then: a cache that is down must not leave the bids standing.
  it('refunds the bids when a step after the delete fails', async () => {
    vi.mocked(userModelCountCache.refresh).mockRejectedValueOnce(new Error('cache down'));
    mockDbWrite.$transaction.mockImplementationOnce((async (fn: (t: unknown) => unknown) =>
      fn({
        $executeRaw: vi.fn(async () => 1),
        model: {
          update: vi.fn(async () => ({
            id: MODEL_ID,
            userId: OWNER_ID,
            nsfwLevel: 1,
            modelVersions: [{ id: VERSION_ID }],
          })),
        },
      })) as never);

    await expect(
      deleteModelById({ id: MODEL_ID, userId: 77, isModerator: true, onBidRefundFailed: vi.fn() })
    ).rejects.toThrow('cache down');
    expect(mockDeleteBidsForModel).toHaveBeenCalledTimes(1);
    expect(mockDeleteBidsForModel).toHaveBeenCalledWith({ modelId: MODEL_ID });
  });

  it('throws a refund that failed when its caller takes no refund failures', async () => {
    mockDeleteBidsForModel.mockRejectedValueOnce(new Error('buzz down'));
    mockDbWrite.$transaction.mockImplementationOnce((async (fn: (t: unknown) => unknown) =>
      fn({
        $executeRaw: vi.fn(async () => 1),
        model: {
          update: vi.fn(async () => ({
            id: MODEL_ID,
            userId: OWNER_ID,
            nsfwLevel: 1,
            modelVersions: [{ id: VERSION_ID }],
          })),
        },
      })) as never);

    await expect(deleteModelById({ id: MODEL_ID, userId: 77, isModerator: true })).rejects.toThrow(
      'buzz down'
    );
    // The steps after the refund still ran.
    expect(userModelCountCache.refresh).toHaveBeenCalledWith(OWNER_ID);
  });

  it('records no deleter when no person ordered the delete', async () => {
    const { data } = await deleteInTx(1, { userId: null, isModerator: true });

    expect(data).toMatchObject({ status: 'Deleted', deletedBy: null });
  });
});

describe('permaDeleteModelById — permanent delete', () => {
  beforeEach(() => {
    mockDbWrite.modelFile.findMany.mockResolvedValue([]);
    mockDbWrite.model.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      nsfwLevel: 1,
      modelVersions: [{ id: VERSION_ID }],
    });
    mockDbWrite.post.findMany.mockResolvedValue([{ id: 7012 }]);
    mockDbWrite.image.findMany.mockResolvedValue([{ id: 6631 }]);
  });

  it('queues an Update for every collection that contained the model or its images', async () => {
    await permaDeleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith(
      expectedUpdatePayload([COLLECTION_A, COLLECTION_B])
    );
  });

  it('resolves the collections BEFORE the delete, since CollectionItem cascades away', async () => {
    const order: string[] = [];
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('?');
      if (sql.includes('"CollectionItem"')) {
        order.push('resolve');
        return [{ collectionId: COLLECTION_A }];
      }
      if (isModelDelete(sql)) {
        order.push('delete');
        return [DELETED_MODEL];
      }
      return [];
    });

    await permaDeleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(order).toEqual(['resolve', 'delete']);
  });

  // model.service hard-deletes the model's Posts in the same transaction, and
  // CollectionItem.postId is onDelete: Cascade while the index denormalizes a post
  // item's first image — so Post-type membership rows go stale too and must be
  // resolved before the cascade removes them.
  it('resolves the posts the cascade deletes, not only the model and its images', async () => {
    await permaDeleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    const call = mockDbWrite.$queryRaw.mock.calls.find(([strings]: [string[]]) =>
      strings.join('?').includes('"CollectionItem"')
    );
    expect((call as unknown[])[0].join('?')).toContain('ci."postId"');
  });

  it('still deletes the model when the collections lookup fails', async () => {
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      if (isModelDelete(Array.from(strings).join('?'))) return [DELETED_MODEL];
      throw new Error('connection reset');
    });

    await permaDeleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(
      mockDbWrite.$queryRaw.mock.calls.some(([strings]: [string[]]) =>
        isModelDelete(strings.join('?'))
      )
    ).toBe(true);
    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });
});

// The DELETE runs on a Postgres stand-in with the evidence-hold migration applied, so the hold
// predicate inside it is what decides.
describe('permaDeleteModelById — legal hold', () => {
  // One owner per way of being held.
  const MARKED_OWNER = 61; // a hold marker
  const REPORTED_OWNER = 62; // named on a report not yet sent: no marker row exists for them
  const REVIEW_OWNER = 63; // an image awaiting CSAM review: the account hold's image leg
  const PLACEHOLDER_OWNER = -1;
  const POST_ID = 7012;
  const IMAGE_ID = 6631;
  const HOLD_MIGRATION = path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
  );
  const OWNERSHIP_MIGRATION = path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
  );
  let db: PGlite;
  let refusal: string | undefined;
  let executed: string[] = [];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
      CREATE TABLE "Image" (
        id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int NOT NULL DEFAULT 0,
        ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
        "blockedFor" text, metadata jsonb, "updatedAt" timestamp(3)
      );
      CREATE TABLE "Post" (
        id int PRIMARY KEY, "userId" int NOT NULL, title text, detail text,
        "createdAt" timestamp(3) NOT NULL DEFAULT now(), "publishedAt" timestamp(3),
        "modelVersionId" int, "collectionId" int, metadata jsonb
      );
      CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1);
      CREATE TABLE "Thread" (
        id serial PRIMARY KEY, "modelId" int REFERENCES "Model"(id) ON DELETE CASCADE, "reviewId" int,
        "postId" int, "imageId" int, "parentThreadId" int, "rootThreadId" int, "commentId" int,
        metadata jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE "CommentV2" (
        id serial PRIMARY KEY, "userId" int NOT NULL,
        "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE
      );
      CREATE TABLE "Comment" (id serial PRIMARY KEY, "userId" int NOT NULL, "modelId" int, "parentId" int);
      CREATE TABLE "ResourceReview" (id serial PRIMARY KEY, "modelId" int);
      CREATE TABLE "CsamReport" (
        id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
        images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
      );
    `);
    await db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
    await db.exec(readFileSync(OWNERSHIP_MIGRATION, 'utf8'));
    await db.exec(`
      INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKED_OWNER}, 'manual', 'review');
      INSERT INTO "CsamReport" ("userId") VALUES (${REPORTED_OWNER});
      INSERT INTO "Image" (id, "userId", "needsReview") VALUES (9001, ${REVIEW_OWNER}, 'csam');
    `);
  });
  afterAll(() => db.close());

  /** Runs the permanent delete of a model owned by `userId`; `exists: false` leaves no row to delete. */
  async function permaDeleteOwnedBy(
    userId: number,
    {
      exists = true,
      deleteFails = false,
      detachFails = false as boolean | 'post',
      heldCommenter = null as number | null,
      threadCommenter = null as number | null,
    } = {}
  ) {
    // The post and image deletes run for real, each with its thread detach in the same statement.
    mockDbWrite.$executeRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      executed.push(sql.text);
      const post = sql.text.includes('p."modelVersionId"');
      if (detachFails === true || (detachFails === 'post' && post))
        throw new Error('relation "EvidenceHeldUser" does not exist');
      return (await db.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
    }) as never);
    executed = [];
    await db.exec(`DELETE FROM "Thread"; DELETE FROM "Model"; DELETE FROM "Comment";`);
    if (heldCommenter)
      await db.exec(
        `INSERT INTO "Comment" ("userId", "modelId") VALUES (${heldCommenter}, ${MODEL_ID})`
      );
    if (exists) await db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${MODEL_ID}, ${userId})`);
    if (exists && threadCommenter)
      await db.exec(`
        INSERT INTO "Thread" (id, "modelId") VALUES (700, ${MODEL_ID});
        INSERT INTO "CommentV2" (id, "userId", "threadId") VALUES (7001, ${threadCommenter}, 700);`);
    mockDbWrite.modelFile.findMany.mockResolvedValue([{ url: 'models/held.safetensors' }]);
    mockDbWrite.post.findMany.mockResolvedValue([{ id: POST_ID }]);
    mockDbWrite.image.findMany.mockResolvedValue([{ id: IMAGE_ID }]);
    // The model as the transaction first reads it; the existence re-check after the DELETE reads the
    // stand-in.
    mockDbWrite.model.findUnique.mockImplementation((async (args: { select?: object }) => {
      if (args.select && 'modelVersions' in args.select)
        return { id: MODEL_ID, userId, nsfwLevel: 1, modelVersions: [{ id: VERSION_ID }] };
      const { rows } = await db.query(`SELECT id FROM "Model" WHERE id = ${MODEL_ID}`);
      return rows[0] ?? null;
    }) as never);
    mockDbWrite.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const flat = Prisma.sql(strings, ...(values as never[]));
      if (flat.text.includes('"ownerHeld"'))
        return (await db.query(flat.text, flat.values as unknown[])).rows;
      if (!isModelDelete(flat.text)) return [];
      if (deleteFails) throw new Error('relation "EvidenceHeldUser" does not exist');
      return (await db.query(flat.text, flat.values as unknown[])).rows;
    }) as never);
    // A throw out of the callback is what rolls the transaction back.
    let rolledBack = false;
    mockDbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => {
      try {
        return await fn(mockDbWrite);
      } catch (e) {
        rolledBack = true;
        throw e;
      }
    }) as never);
    const result = await permaDeleteModelById({ id: MODEL_ID, userId: 1 } as any).then(
      (model) => (model ? 'deleted' : 'not found'),
      (e: { code?: string; message?: string }) => {
        refusal = e.message;
        return e.code;
      }
    );
    const left = (await db.query(`SELECT id FROM "Model"`)).rows.length;
    return { result, left, rolledBack };
  }

  it.each([
    ['a hold marker', MARKED_OWNER],
    ['a report not yet sent', REPORTED_OWNER],
    ['an image awaiting CSAM review', REVIEW_OWNER],
    ['the placeholder owner', PLACEHOLDER_OWNER],
  ])(
    'refuses a model whose owner is held by %s, rolls back its post and image deletes, and deletes no files',
    async (_how, owner) => {
      expect(await permaDeleteOwnedBy(owner)).toEqual({
        result: 'FORBIDDEN',
        left: 1,
        rolledBack: true,
      });
      expect(vi.mocked(deleteModelFileObjects)).not.toHaveBeenCalled();
      // Kept on purpose, so a moderator does not read it as a failure; never which hold.
      expect(refusal).toBe(MODEL_KEPT_FOR_HOLD);
    }
  );

  // Only another account's legacy comment keeps it: its owner is not held, and is told so.
  it('refuses a model a held author left a legacy comment on, with its own message', async () => {
    expect(await permaDeleteOwnedBy(OWNER_ID, { heldCommenter: REPORTED_OWNER })).toEqual({
      result: 'FORBIDDEN',
      left: 1,
      rolledBack: true,
    });
    expect(refusal).toBe(MODEL_KEPT_FOR_HELD_COMMENT);
  });

  it("keeps the owner's message when the owner is held too", async () => {
    await permaDeleteOwnedBy(MARKED_OWNER, { heldCommenter: REPORTED_OWNER });
    expect(refusal).toBe(MODEL_KEPT_FOR_HOLD);
  });

  describe('with an earlier owner on record', () => {
    // The history is append-only; each case clears it as its owner would, past the guard.
    afterEach(() =>
      db.exec(`
        ALTER TABLE "ModelOwnership" DISABLE TRIGGER USER;
        DELETE FROM "ModelOwnership";
        ALTER TABLE "ModelOwnership" ENABLE TRIGGER USER;
      `)
    );

    it('refuses a model a held owner transferred to an unheld one', async () => {
      await db.exec(`
        INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
          (${MODEL_ID}, ${MARKED_OWNER}, 'create'), (${MODEL_ID}, ${OWNER_ID}, 'transfer')
      `);
      expect(await permaDeleteOwnedBy(OWNER_ID)).toEqual({
        result: 'FORBIDDEN',
        left: 1,
        rolledBack: true,
      });
    });

    it('deletes a model only unheld owners had (control for the above)', async () => {
      await db.exec(`
        INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
          (${MODEL_ID}, 99, 'create'), (${MODEL_ID}, ${OWNER_ID}, 'transfer')
      `);
      expect(await permaDeleteOwnedBy(OWNER_ID)).toMatchObject({ result: 'deleted', left: 0 });
    });

    it('refuses a model moved off the placeholder owner without a restore', async () => {
      await db.exec(`
        INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
          (${MODEL_ID}, -1, 'account-delete'), (${MODEL_ID}, ${OWNER_ID}, 'transfer')
      `);
      expect(await permaDeleteOwnedBy(OWNER_ID)).toMatchObject({ result: 'FORBIDDEN', left: 1 });
    });

    it('deletes a model restored from the placeholder owner to an unheld one', async () => {
      await db.exec(`
        INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
          (${MODEL_ID}, -1, 'account-delete'), (${MODEL_ID}, ${OWNER_ID}, 'restore')
      `);
      expect(await permaDeleteOwnedBy(OWNER_ID)).toMatchObject({ result: 'deleted', left: 0 });
    });

    it('refuses a model restored from the placeholder owner to a held one', async () => {
      await db.exec(`
        INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES
          (${MODEL_ID}, -1, 'account-delete'), (${MODEL_ID}, ${REPORTED_OWNER}, 'restore')
      `);
      expect(await permaDeleteOwnedBy(REPORTED_OWNER)).toMatchObject({
        result: 'FORBIDDEN',
        left: 1,
      });
    });
  });

  it('deletes a model whose owner is not held, and its files', async () => {
    expect(await permaDeleteOwnedBy(OWNER_ID)).toEqual({
      result: 'deleted',
      left: 0,
      rolledBack: false,
    });
    expect(vi.mocked(deleteModelFileObjects)).toHaveBeenCalledWith(['models/held.safetensors']);
  });

  it("deletes the model's post and image, and keeps a held author's threads off them", async () => {
    await db.exec(`
      DELETE FROM "Post"; DELETE FROM "Image" WHERE id = ${IMAGE_ID};
      INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (${POST_ID}, ${OWNER_ID}, ${VERSION_ID});
      INSERT INTO "Image" (id, "userId", "postId") VALUES (${IMAGE_ID}, ${OWNER_ID}, ${POST_ID});
    `);
    // Seeded after the harness clears the threads: a held author's and an unheld one's on each.
    const seedThreads = () =>
      db.exec(`
        INSERT INTO "Thread" (id, "postId") VALUES (800, ${POST_ID}), (802, ${POST_ID});
        INSERT INTO "Thread" (id, "imageId") VALUES (801, ${IMAGE_ID}), (803, ${IMAGE_ID});
        INSERT INTO "CommentV2" ("userId", "threadId") VALUES
          (${REPORTED_OWNER}, 800), (${REPORTED_OWNER}, 801), (${OWNER_ID}, 802), (${OWNER_ID}, 803);
      `);
    mockDbWrite.post.findMany.mockImplementationOnce((async () => {
      await seedThreads();
      return [{ id: POST_ID }];
    }) as never);

    expect(await permaDeleteOwnedBy(OWNER_ID)).toMatchObject({ result: 'deleted', left: 0 });

    expect((await db.query(`SELECT id FROM "Post" WHERE id = ${POST_ID}`)).rows).toEqual([]);
    expect((await db.query(`SELECT id FROM "Image" WHERE id = ${IMAGE_ID}`)).rows).toEqual([]);
    const threads = await db.query<{ id: number; postId: number | null; imageId: number | null }>(
      `SELECT id, "postId", "imageId" FROM "Thread" WHERE id >= 800 ORDER BY id`
    );
    expect(threads.rows).toEqual([
      { id: 800, postId: null, imageId: null },
      { id: 801, postId: null, imageId: null },
      { id: 802, postId: POST_ID, imageId: null },
      { id: 803, postId: null, imageId: IMAGE_ID },
    ]);
    // In the statement that deletes them: a hold placed between two statements would be missed.
    for (const table of ['Image', 'Post'])
      expect(
        executed.find((text) => text.includes(`DELETE FROM "${table}"`)),
        table
      ).toMatch(/detachedFrom[\s\S]*DELETE FROM/);
  });

  it("deletes the model, and keeps a held author's comment thread off it", async () => {
    expect(await permaDeleteOwnedBy(OWNER_ID, { threadCommenter: REPORTED_OWNER })).toEqual({
      result: 'deleted',
      left: 0,
      rolledBack: false,
    });
    const { rows } = await db.query(
      `SELECT t."modelId", t.metadata -> 'detachedFrom' AS "detachedFrom", c.id AS "commentId"
       FROM "Thread" t JOIN "CommentV2" c ON c."threadId" = t.id`
    );
    expect(rows).toEqual([{ modelId: null, detachedFrom: { modelId: MODEL_ID }, commentId: 7001 }]);
  });

  it('deletes the model and its thread when no held author commented (control)', async () => {
    await permaDeleteOwnedBy(OWNER_ID, { threadCommenter: OWNER_ID });
    expect((await db.query(`SELECT id FROM "CommentV2"`)).rows).toEqual([]);
  });

  // Its post and image deletes passed no hold check, so they must not commit either.
  it('reports a model another delete removed first as not found, and rolls back', async () => {
    expect(await permaDeleteOwnedBy(OWNER_ID, { exists: false })).toEqual({
      result: 'NOT_FOUND',
      left: 0,
      rolledBack: true,
    });
  });

  it('refuses, and rolls back, when the post and image detaches cannot check their holds', async () => {
    expect(await permaDeleteOwnedBy(OWNER_ID, { detachFails: true })).toEqual({
      result: 'FORBIDDEN',
      left: 1,
      rolledBack: true,
    });
    expect(refusal).toBe(HOLD_UNCONFIRMED);
  });

  it('refuses, and rolls back, when only the post detach cannot check its holds', async () => {
    expect(await permaDeleteOwnedBy(OWNER_ID, { detachFails: 'post' })).toEqual({
      result: 'FORBIDDEN',
      left: 1,
      rolledBack: true,
    });
    expect(refusal).toBe(HOLD_UNCONFIRMED);
  });

  it('refuses, and rolls back, when the hold cannot be checked', async () => {
    expect(await permaDeleteOwnedBy(OWNER_ID, { deleteFails: true })).toEqual({
      result: 'FORBIDDEN',
      left: 1,
      rolledBack: true,
    });
  });
});

import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, it, expect, vi, beforeEach } from 'vitest';

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
  let db: PGlite;
  let refusal: string | undefined;

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
        id serial PRIMARY KEY, "modelId" int, "reviewId" int, "postId" int, "imageId" int,
        "parentThreadId" int, "rootThreadId" int, "commentId" int, metadata jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE "CommentV2" (id serial PRIMARY KEY, "userId" int NOT NULL, "threadId" int NOT NULL);
      CREATE TABLE "Comment" (id serial PRIMARY KEY, "userId" int NOT NULL, "modelId" int, "parentId" int);
      CREATE TABLE "ResourceReview" (id serial PRIMARY KEY, "modelId" int);
      CREATE TABLE "CsamReport" (
        id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
        images jsonb NOT NULL DEFAULT '[]', details jsonb NOT NULL DEFAULT '{}'
      );
    `);
    await db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
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
    } = {}
  ) {
    mockDbWrite.$executeRaw.mockImplementation((async (sql: Prisma.Sql) => {
      const post = sql.text.includes('p."modelVersionId"');
      if (detachFails === true || (detachFails === 'post' && post))
        throw new Error('relation "EvidenceHeldUser" does not exist');
      return 0;
    }) as never);
    await db.exec(`DELETE FROM "Model"; DELETE FROM "Comment";`);
    if (heldCommenter)
      await db.exec(
        `INSERT INTO "Comment" ("userId", "modelId") VALUES (${heldCommenter}, ${MODEL_ID})`
      );
    if (exists) await db.exec(`INSERT INTO "Model" (id, "userId") VALUES (${MODEL_ID}, ${userId})`);
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

  it('deletes a model whose owner is not held, and its files', async () => {
    expect(await permaDeleteOwnedBy(OWNER_ID)).toEqual({
      result: 'deleted',
      left: 0,
      rolledBack: false,
    });
    expect(vi.mocked(deleteModelFileObjects)).toHaveBeenCalledWith(['models/held.safetensors']);
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

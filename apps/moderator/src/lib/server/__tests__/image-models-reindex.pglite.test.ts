import type { PGlite } from '@electric-sql/pglite';
import { childBrowsingTagIds } from '@civitai/shared';
import { REDIS_KEYS } from '@civitai/redis';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../search-index', () => ({ syncSearchIndexBulk: vi.fn(async () => undefined) }));
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));

const { queueModelsForImageChildTagChanges } = await import('../image-models-reindex');
const { syncSearchIndexBulk } = await import('../search-index');
const { bustCachedObject } = await import('../cache');
const { logAxiomError } = await import('../axiom');

const CHILD_TAG = childBrowsingTagIds[0];
const OTHER_TAG = 7;

// Image 1 and 2 are on versions 10 and 11 of model 100; image 3 is on no post.
const SCHEMA = `
CREATE TABLE "ModelVersion" ("id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL);
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER);
CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "postId" INTEGER);
CREATE TABLE "TagsOnImageNew" ("imageId" INTEGER NOT NULL, "tagId" INTEGER NOT NULL);
INSERT INTO "ModelVersion" VALUES (10, 100), (11, 100);
INSERT INTO "Post" VALUES (20, 10), (21, 11);
INSERT INTO "Image" VALUES (1, 20), (2, 21), (3, NULL);
`;

let db: PGlite;
let failNextQuery = false;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(syncSearchIndexBulk).mockReset().mockResolvedValue(undefined);
  vi.mocked(bustCachedObject).mockReset().mockResolvedValue(undefined);
  db = await freshPglite();
  await db.exec(SCHEMA);
  failNextQuery = false;
  const flaky = {
    query: async (sql: string, params?: unknown[]) => {
      if (failNextQuery) {
        failNextQuery = false;
        throw new Error('connection reset');
      }
      return db.query(sql, params);
    },
  } as unknown as PGlite;
  dbHandle.current = new Kysely({ dialect: pgliteDialect(flaky) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const tag = (imageId: number, tagId: number) =>
  db.query(`INSERT INTO "TagsOnImageNew" VALUES ($1, $2)`, [imageId, tagId]);
const queuedModels = () => vi.mocked(syncSearchIndexBulk).mock.calls.map(([batch]) => batch);
const busted = (key: string) =>
  vi
    .mocked(bustCachedObject)
    .mock.calls.filter(([k]) => k === key)
    .map(([, ids]) => ids);

describe('spoke queueModelsForImageChildTagChanges', () => {
  it('queues the model of an image whose child tag was written, once across its versions', async () => {
    await queueModelsForImageChildTagChanges({
      tagWrites: [
        { imageId: 1, tagId: CHILD_TAG },
        { imageId: 2, tagId: CHILD_TAG },
      ],
    });

    expect(queuedModels()).toEqual([{ entityType: 'model', entityIds: [100], action: 'update' }]);
    expect(busted(REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION)).toEqual([[10, 11]]);
    expect(busted(REDIS_KEYS.CACHES.TAG_IDS_FOR_IMAGES)).toEqual([[1, 2]]);
  });

  it('queues nothing for a write of other tags only', async () => {
    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 1, tagId: OTHER_TAG }] });

    expect(syncSearchIndexBulk).not.toHaveBeenCalled();
  });

  it('queues a re-rated image only while it carries a child tag', async () => {
    await tag(1, CHILD_TAG);
    await tag(2, OTHER_TAG);

    await queueModelsForImageChildTagChanges({ levelImageIds: [2] });
    expect(syncSearchIndexBulk).not.toHaveBeenCalled();

    await queueModelsForImageChildTagChanges({ levelImageIds: [1, 2] });
    expect(queuedModels()).toEqual([{ entityType: 'model', entityIds: [100], action: 'update' }]);
    expect(busted(REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION)).toEqual([[10]]);
  });

  // The minor rule reads no tags, so a minor-flag write cannot wait on the child-tag check.
  it('queues the model of an image whose minor flag was written, without a child tag', async () => {
    await tag(2, OTHER_TAG);

    await queueModelsForImageChildTagChanges({ minorImageIds: [2] });

    expect(queuedModels()).toEqual([{ entityType: 'model', entityIds: [100], action: 'update' }]);
    expect(busted(REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION)).toEqual([[11]]);
  });

  it('queues nothing for an image on no post', async () => {
    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 3, tagId: CHILD_TAG }] });

    expect(syncSearchIndexBulk).not.toHaveBeenCalled();
  });

  it('still busts the other cache and queues when one bust fails', async () => {
    vi.mocked(bustCachedObject).mockRejectedValueOnce(new Error('redis down'));

    await queueModelsForImageChildTagChanges({ tagWrites: [{ imageId: 1, tagId: CHILD_TAG }] });

    expect(bustCachedObject).toHaveBeenCalledTimes(2);
    expect(queuedModels()).toEqual([{ entityType: 'model', entityIds: [100], action: 'update' }]);
    expect(logAxiomError).toHaveBeenCalled();
  });

  it('queues in strict mode, so a failed queue call is retried', async () => {
    vi.useFakeTimers();
    vi.mocked(syncSearchIndexBulk).mockRejectedValueOnce(new Error('main app down'));
    try {
      const run = queueModelsForImageChildTagChanges({
        tagWrites: [{ imageId: 1, tagId: CHILD_TAG }],
      });
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }

    expect(syncSearchIndexBulk).toHaveBeenCalledTimes(2);
    expect(vi.mocked(syncSearchIndexBulk).mock.calls[1][1]).toEqual({ strict: true });
    expect(logAxiomError).toHaveBeenCalledTimes(1);
  });

  it('logs the image and model ids when both attempts fail', async () => {
    vi.useFakeTimers();
    vi.mocked(syncSearchIndexBulk).mockRejectedValue(new Error('main app down'));
    try {
      const run = queueModelsForImageChildTagChanges({
        tagWrites: [{ imageId: 1, tagId: CHILD_TAG }],
      });
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }

    expect(syncSearchIndexBulk).toHaveBeenCalledTimes(2);
    expect(vi.mocked(logAxiomError).mock.calls.at(-1)?.[1]).toMatchObject({
      dropped: true,
      imageIds: [1],
      modelIds: [100],
    });
  });

  it('retries a failed read once, then queues', async () => {
    vi.useFakeTimers();
    failNextQuery = true;

    try {
      const run = queueModelsForImageChildTagChanges({
        tagWrites: [{ imageId: 1, tagId: CHILD_TAG }],
      });
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }

    expect(logAxiomError).toHaveBeenCalledTimes(1);
    expect(queuedModels()).toEqual([{ entityType: 'model', entityIds: [100], action: 'update' }]);
  });
});

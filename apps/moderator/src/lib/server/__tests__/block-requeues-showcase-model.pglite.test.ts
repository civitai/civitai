import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const { dbHandle, syncSearchIndexBulk } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  syncSearchIndexBulk: vi.fn(
    async (_batch: { entityType: string; entityIds: number[]; action?: string }) => undefined
  ),
}));

vi.mock('../db', () => ({
  get dbRead() {
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ insert: vi.fn(async () => undefined), query: vi.fn() }),
}));
vi.mock('../axiom', () => ({
  logAxiomError: vi.fn(async () => undefined),
  logToAxiom: vi.fn(async () => undefined),
}));
vi.mock('../notifications', () => ({ getNotifications: vi.fn() }));
vi.mock('../redis', () => ({
  getSysRedis: () => ({ packed: { set: vi.fn(async () => undefined) } }),
  getRedis: vi.fn(),
}));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn(), syncSearchIndexBulk }));
vi.mock('../buzz', () => ({ getBuzz: vi.fn() }));
vi.mock('../cache', () => ({
  bustCacheTag: vi.fn(async () => undefined),
  bustCachedObject: vi.fn(async () => undefined),
}));

const { applyBlockSideEffects } = await import('../image-moderation-effects');

const SCHEMA = `
CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
CREATE TABLE "ModelVersion" ("id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL);
CREATE TABLE "Post" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL,
  "modelVersionId" INTEGER, "model3dId" INTEGER
);
CREATE TABLE "ComicPanel" ("projectId" INTEGER, "imageId" INTEGER);
`;

const OWNER = 42;
const OTHER_USER = 43;
const MODEL_ID = 7;
const SHOWCASE_POST = 100;
const COMMUNITY_POST = 101;

const block = (postId: number, userId: number) =>
  applyBlockSideEffects(
    { pHash: null, needsReview: null, blockedFor: null, nsfwLevel: 4, postId, userId },
    { imageId: 9, actorUserId: 1 }
  );
const queuedModels = () =>
  syncSearchIndexBulk.mock.calls
    .filter(([batch]) => batch.entityType === 'model')
    .flatMap(([batch]) => batch.entityIds);

let db: PGlite;

beforeEach(async () => {
  syncSearchIndexBulk.mockClear();
  db = await freshPglite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "Model" VALUES (${MODEL_ID}, ${OWNER});
    INSERT INTO "ModelVersion" VALUES (70, ${MODEL_ID});
    INSERT INTO "Post" VALUES (${SHOWCASE_POST}, ${OWNER}, 70, NULL),
                              (${COMMUNITY_POST}, ${OTHER_USER}, 70, NULL);
  `);
  dbHandle.current = new Kysely<DB>({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('a moderator block of a model image', () => {
  it("queues the model's search document when the image is on the owner's showcase post", async () => {
    await block(SHOWCASE_POST, OWNER);

    expect(syncSearchIndexBulk).toHaveBeenCalledWith({
      entityType: 'model',
      entityIds: [MODEL_ID],
      action: 'update',
    });
  });

  it("queues no model when the image is on someone else's post on the version", async () => {
    await block(COMMUNITY_POST, OTHER_USER);

    expect(queuedModels()).toEqual([]);
  });
});

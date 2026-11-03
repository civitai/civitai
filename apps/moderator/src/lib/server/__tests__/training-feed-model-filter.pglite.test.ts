import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
// The service's other imports open connections at load; this file only exercises the feed read.
vi.mock('@civitai/orchestration-client', () => ({ getWorkflow: vi.fn() }));
vi.mock('../orchestrator', () => ({}));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));
vi.mock('../axiom', () => ({ logToAxiom: vi.fn() }));
vi.mock('../users.service', () => ({ usersByIds: vi.fn() }));
vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));
vi.mock('../training-orchestration.service', () => ({ TRAINING_STEP_TYPES: [] }));
vi.mock('../search-index', () => ({ syncSearchIndex: vi.fn() }));

const { getTrainingModelsFeed } = await import('../training-moderation.service');

let db: PGlite;

const ids = async (query: Parameters<typeof getTrainingModelsFeed>[0]) =>
  (await getTrainingModelsFeed(query)).items.map((m) => m.id);

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "image" TEXT);
    CREATE TABLE "Model" (
      "id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL DEFAULT 'm', "type" TEXT NOT NULL DEFAULT 'LORA',
      "nsfw" BOOLEAN NOT NULL DEFAULT FALSE, "poi" BOOLEAN NOT NULL DEFAULT FALSE,
      "minor" BOOLEAN NOT NULL DEFAULT FALSE, "tosViolation" BOOLEAN NOT NULL DEFAULT FALSE,
      "status" TEXT NOT NULL DEFAULT 'Published', "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
      "publishedAt" TIMESTAMP, "userId" INTEGER NOT NULL, "uploadType" TEXT NOT NULL DEFAULT 'Trained',
      "deletedAt" TIMESTAMP, "meta" JSONB
    );
    CREATE TABLE "ModelVersion" (
      "id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "name" TEXT NOT NULL DEFAULT 'v1',
      "status" TEXT NOT NULL DEFAULT 'Published', "baseModel" TEXT NOT NULL DEFAULT 'SDXL 1.0',
      "trainingStatus" TEXT, "createdAt" TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE TABLE "ModelFile" (
      "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL, "name" TEXT NOT NULL DEFAULT 'f.zip',
      "sizeKB" DOUBLE PRECISION NOT NULL DEFAULT 1, "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
      "type" TEXT NOT NULL, "dataPurged" BOOLEAN NOT NULL DEFAULT FALSE, "metadata" JSONB
    );
    INSERT INTO "User" ("id","username") VALUES (1,'alice'),(2,'bob');
    -- 10 and 11 are trained on site; 12 is an uploaded model with no training data at all.
    INSERT INTO "Model" ("id","userId","uploadType") VALUES (10,1,'Trained'),(11,2,'Trained'),(12,1,'Created');
    INSERT INTO "ModelVersion" ("id","modelId") VALUES (100,10),(110,11),(120,12);
    INSERT INTO "ModelFile" ("id","modelVersionId","type","metadata") VALUES
      (1000,100,'Training Data','{"trainingResults":{"workflowId":"wf-a"}}'),
      (1100,110,'Training Data','{"trainingResults":{"workflowId":"wf-b"}}');
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('getTrainingModelsFeed modelId filter', () => {
  it('sanity: with no modelId the feed lists every trained model', async () => {
    expect((await ids({ limit: 24 })).sort()).toEqual([10, 11]);
  });

  it('narrows to that one model', async () => {
    expect(await ids({ limit: 24, modelId: 11 })).toEqual([11]);
    expect(await ids({ limit: 24, modelId: 10 })).toEqual([10]);
  });

  it('returns an EMPTY result for an unknown id, never the whole feed', async () => {
    expect(await ids({ limit: 24, modelId: 999 })).toEqual([]);
    expect(await ids({ limit: 24, modelId: 0 })).toEqual([]);
  });

  it('returns nothing for a model that was not trained on site', async () => {
    expect(await ids({ limit: 24, modelId: 12 })).toEqual([]);
  });

  it('composes with the other filters instead of replacing them', async () => {
    expect(await ids({ limit: 24, modelId: 11, workflowId: 'wf-a' })).toEqual([]);
    expect(await ids({ limit: 24, modelId: 11, workflowId: 'wf-b' })).toEqual([11]);
    expect(await ids({ limit: 24, modelId: 11, username: 'alice' })).toEqual([]);
  });
});

import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A purged dataset keeps its `Training Data` row (`dataPurged = true`) while its bytes are gone, and
 * the main-app model page hides it. Moderator surfaces must say it was removed rather than list it as
 * data that still exists: the preview flags the row, and the download route answers 410, not 502.
 */

vi.setConfig({ hookTimeout: 60_000 });

const { dbHandle, callModEndpoint } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  callModEndpoint: vi.fn(),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    return dbHandle.current;
  },
}));
vi.mock('../model-lookup.service', () => ({
  getModel: async (id: number) => ({
    id,
    name: 'm',
    type: 'LORA',
    userId: 1,
    username: 'u',
    userBannedAt: null,
    createdAt: new Date(0),
  }),
  getVersions: async () => [
    { id: 100, name: 'v1', baseModel: 'SDXL 1.0', status: 'Published', publishedAt: null },
  ],
  getTags: async () => [],
  getReports: async () => ({ rows: [], total: 0 }),
}));
vi.mock('../access', () => ({ canAccess: () => true }));
vi.mock('../user-actions.service', () => ({ callModEndpoint }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));

const { getModelPreview } = await import('../model-preview.service');
const { GET } = await import('../../../routes/api/training-data/[versionId]/+server');

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "description" TEXT);
    CREATE TABLE "ModelVersion" ("id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "index" INTEGER);
    CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER, "modelVersionId" INTEGER);
    CREATE TABLE "Image" (
      "id" INTEGER PRIMARY KEY, "postId" INTEGER, "url" TEXT, "type" TEXT, "nsfwLevel" INTEGER,
      "ingestion" TEXT, "minor" BOOLEAN, "acceptableMinor" BOOLEAN, "index" INTEGER
    );
    CREATE TABLE "ModelFile" (
      "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL, "name" TEXT NOT NULL DEFAULT 'f.zip',
      "type" TEXT NOT NULL, "sizeKB" DOUBLE PRECISION NOT NULL DEFAULT 1, "metadata" JSONB,
      "pickleScanResult" TEXT NOT NULL DEFAULT 'Success', "virusScanResult" TEXT NOT NULL DEFAULT 'Success',
      "visibility" TEXT NOT NULL DEFAULT 'Public', "replacedAt" TIMESTAMP,
      "dataPurged" BOOLEAN NOT NULL DEFAULT FALSE
    );
    INSERT INTO "Model" ("id") VALUES (10);
    -- 100: one live dataset, one purged. 200: only purged datasets, beside a live model file.
    -- 300: no training data at all. 400: no training data, one purged file of another type.
    INSERT INTO "ModelVersion" ("id","modelId") VALUES (100,10),(200,20),(300,30),(400,40);
    INSERT INTO "ModelFile" ("id","modelVersionId","type","visibility","dataPurged") VALUES
      (1000,100,'Model','Public',false),
      (1001,100,'Training Data','Private',false),
      (1002,100,'Training Data','Private',true),
      (2000,200,'Model','Public',false),
      (2001,200,'Training Data','Private',true),
      (2002,200,'Training Data','Private',true),
      (3001,300,'Model','Public',false),
      (4001,400,'Model','Public',true);
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
  callModEndpoint.mockReset();
  // Every resolve fails unless a test says otherwise. The real resolver (dataPurged = false only)
  // cannot serve 200, 300 or 400; 100 stands in for a live dataset whose resolve fails anyway.
  callModEndpoint.mockResolvedValue({ ok: false, error: 'No training data on this version' });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

describe('getModelPreview on a purged dataset', () => {
  it('lists the purged row and marks it purged, and leaves live rows unmarked', async () => {
    const preview = await getModelPreview(10, null);
    const files = preview?.versions[0].files ?? [];
    expect(files.map((f) => f.id)).toEqual([1000, 1001, 1002]);
    expect(files.filter((f) => f.purged).map((f) => f.id)).toEqual([1002]);
  });
});

describe('GET /api/training-data/[versionId] on a purged dataset', () => {
  const status = async (versionId: number) => {
    try {
      const res = await GET({
        params: { versionId: String(versionId) },
        locals: { user: { id: 1 } },
        fetch: vi.fn(async () => new Response('zip')),
      } as unknown as Parameters<typeof GET>[0]);
      return res.status;
    } catch (e) {
      return (e as { status?: number }).status;
    }
  };

  it('answers 410 when every training data file on the version was purged', async () => {
    expect(await status(200)).toBe(410);
    expect(callModEndpoint).toHaveBeenCalledTimes(1);
  });

  it('keeps 502 when a live dataset exists, or when there was never any training data', async () => {
    expect(await status(100)).toBe(502);
    expect(await status(300)).toBe(502);
    expect(await status(400)).toBe(502);
  });

  it('streams a live dataset the resolver serves, though a purged one sits beside it', async () => {
    callModEndpoint.mockResolvedValue({
      ok: true,
      body: { url: 'https://store.test/z', name: 'z.zip' },
    });
    expect(await status(100)).toBe(200);
  });
});

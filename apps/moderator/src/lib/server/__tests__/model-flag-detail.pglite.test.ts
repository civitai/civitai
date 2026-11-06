import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** Runs the Model Flags detail-pane query on real Postgres: counts that compile can still count the wrong rows. */

const { dbHandle, memory } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  memory: {
    notes: vi.fn<(userId: number, viewer: string | null) => Promise<unknown[]>>(),
  },
}));

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
vi.mock('../cache', () => ({ createCache: () => ({ get: vi.fn(), bust: vi.fn() }) }));
vi.mock('../moderation-memory.service', () => ({
  getUserNotes: memory.notes,
}));

const { getModelFlagDetail } = await import('../minor-hash.service');

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT, "createdAt" TIMESTAMPTZ NOT NULL);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "userId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Published', "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "lockedProperties" TEXT[] NOT NULL DEFAULT '{}', "meta" JSONB
);
CREATE TABLE "ModelVersion" (
  "id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'Published',
  "createdAt" TIMESTAMPTZ NOT NULL, "publishedAt" TIMESTAMPTZ
);
CREATE TABLE "ModelFile" (
  "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL, "name" TEXT NOT NULL,
  "sizeKB" DOUBLE PRECISION NOT NULL, "type" TEXT NOT NULL DEFAULT 'Model',
  "pickleScanResult" TEXT NOT NULL DEFAULT 'Success', "virusScanResult" TEXT NOT NULL DEFAULT 'Success',
  "replacedAt" TIMESTAMP
);
CREATE TABLE "ModelMetric" ("modelId" INTEGER PRIMARY KEY, "downloadCount" INTEGER, "generationCount" INTEGER);
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER, "userId" INTEGER NOT NULL);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY, "postId" INTEGER, "type" TEXT NOT NULL DEFAULT 'image',
  "minor" BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "Report" ("id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL);
CREATE TABLE "ModelReport" ("modelId" INTEGER NOT NULL, "reportId" INTEGER NOT NULL);
CREATE TABLE "UserStrike" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "status" TEXT NOT NULL,
  "expiresAt" TIMESTAMP NOT NULL, "voidedAt" TIMESTAMP
);
CREATE TABLE "TextScanPrompt" ("id" INTEGER PRIMARY KEY, "key" TEXT NOT NULL, "content" TEXT NOT NULL);
`;

let pg: PGlite;
beforeEach(async () => {
  pg = await freshPglite();
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
  await pg.exec(SCHEMA);
  memory.notes.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
  await pg.exec(`
    INSERT INTO "User" VALUES (1, 'owner', '2024-03-05T00:00:00Z'), (2, 'other', '2025-01-01');
    INSERT INTO "Model" ("id","name","userId","status","nsfwLevel","lockedProperties","meta") VALUES
      (10, 'flagged', 1, 'Published', 4, '{nsfwLevel,minor}', '{}'),
      (11, 'sibling published', 1, 'Published', 1, '{}', '{"minorHashCleared": {"at": "2025-09-04T00:00:00Z"}}'),
      (12, 'mod unpublished', 1, 'UnpublishedViolation', 1, '{}',
        '{"textScanFlags": {"poi": {"appealGranted": {"at": "2025-11-02T00:00:00Z"}}}}'),
      (13, 'draft', 1, 'Draft', 1, '{}', '[]'),
      (20, 'someone else', 2, 'UnpublishedViolation', 1, '{}', '{"minorHashCleared": {"at": "2026-01-01T00:00:00Z"}}');
    INSERT INTO "ModelVersion" VALUES
      (100, 10, 'Published', '2026-01-01', '2026-01-02'),
      (101, 10, 'Published', '2026-02-01', '2026-02-02T00:00:00Z'),
      (102, 10, 'Draft', '2026-03-01', NULL);
    INSERT INTO "ModelFile" VALUES
      (1, 101, 'notes.txt', 1, 'Training Data', 'Success', 'Success', NULL),
      (2, 101, 'main.safetensors', 2048, 'Model', 'Success', 'Pending', NULL),
      (3, 101, 'old.safetensors', 4096, 'Model', 'Success', 'Success', '2026-02-03'),
      (4, 100, 'v1.safetensors', 1024, 'Model', 'Success', 'Success', NULL);
    INSERT INTO "ModelMetric" VALUES (10, 1240, 86);
    INSERT INTO "Post" VALUES (1, 100, 1), (2, 101, 1), (3, 101, 2);
    INSERT INTO "Image" VALUES (1, 1, 'image'), (2, 1, 'image'), (3, 2, 'image'), (4, 2, 'video'), (5, 3, 'image');
    INSERT INTO "Report" VALUES (1, 'Pending'), (2, 'Processing'), (3, 'Actioned'), (4, 'Pending');
    INSERT INTO "ModelReport" VALUES (10, 1), (10, 2), (10, 3), (11, 4);
    INSERT INTO "UserStrike" VALUES
      (1, 1, 'Active', now() + interval '30 days', NULL),
      (2, 1, 'Active', now() + interval '30 days', NULL),
      (3, 1, 'Voided', now() + interval '30 days', now()),
      (4, 1, 'Expired', now() - interval '1 day', NULL),
      -- Past its expiry but not yet swept to Expired.
      (5, 1, 'Active', now() - interval '1 day', NULL),
      (6, 2, 'Active', now() + interval '30 days', NULL);
    INSERT INTO "TextScanPrompt" VALUES (1, 'base', 'a'), (2, 'label:minor', 'b'), (3, 'base', 'c'),
      (4, 'label:minor', 'd'), (5, 'label:minor', 'e');
  `);
});
afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('getModelFlagDetail', () => {
  it('counts the open reports on the model', async () => {
    const detail = await getModelFlagDetail({ modelId: 10 });
    // Pending and Processing only, and only reports on this model.
    expect(detail?.openReports).toBe(2);
  });

  it('describes the model: versions, rating, downloads and the main file of the latest version', async () => {
    const detail = await getModelFlagDetail({ modelId: 10 });
    expect(detail).toMatchObject({
      versionCount: 3,
      nsfwLevel: 4,
      ratingLocked: true,
      downloads: 1240,
      generations: 86,
      // The model file over a training-data file, and never a replaced one.
      mainFile: { name: 'main.safetensors', sizeKB: 2048, scansOk: false, otherFiles: 1 },
    });
    expect(new Date(detail!.latestPublishedAt!).toISOString()).toBe('2026-02-02T00:00:00.000Z');
  });

  it('describes the uploader: joined, published and mod-unpublished, flags reverted elsewhere', async () => {
    const detail = await getModelFlagDetail({ modelId: 10 });
    expect(new Date(detail!.uploaderJoinedAt!).toISOString()).toBe('2024-03-05T00:00:00.000Z');
    expect(detail).toMatchObject({
      uploaderPublished: 2,
      uploaderModUnpublished: 1,
      strikes: 2,
      notes: 3,
    });
    expect(detail?.flagsReverted.count).toBe(2);
    expect(new Date(detail!.flagsReverted.lastAt!).toISOString()).toBe('2025-11-02T00:00:00.000Z');
    expect(memory.notes).toHaveBeenCalledWith(1, null);
  });

  it('does not count as mod-unpublished a model kept when its owner was wiped', async () => {
    await pg.exec(`
      INSERT INTO "Model" ("id","name","userId","status","meta") VALUES
        (90, 'kept', (SELECT "userId" FROM "Model" WHERE id = 10), 'UnpublishedViolation', '{"removedWithOwner": true}')
    `);
    const detail = await getModelFlagDetail({ modelId: 10 });
    expect(detail).toMatchObject({ uploaderModUnpublished: 1 });
  });

  it('ignores a sibling flag whose timestamp does not parse instead of failing the pane', async () => {
    await pg.exec(`
      INSERT INTO "Model" ("id","name","userId","meta") VALUES
        (14, 'bad stamp', 1, '{"minorHashCleared": {"at": "yesterday-ish"}}'),
        (15, 'month 13', 1, '{"textScanFlags": {"minor": {"appealGranted": {"at": "2026-13-01T00:00:00Z"}}}}'),
        (16, 'numeric stamp', 1, '{"textScanFlags": {"poi": {"appealGranted": {"at": 1700000000}}}}');
    `);
    const detail = await getModelFlagDetail({ modelId: 10 });
    // Still reverted flags; only their unreadable times drop out of "latest".
    expect(detail?.flagsReverted.count).toBe(5);
    expect(new Date(detail!.flagsReverted.lastAt!).toISOString()).toBe('2025-11-02T00:00:00.000Z');
  });

  it('numbers each asked-for prompt within its key', async () => {
    const detail = await getModelFlagDetail({ modelId: 10, promptIds: [4, 3, 99] });
    expect(detail?.promptVersions).toEqual({ 4: 2, 3: 2 });
  });

  it('counts only active strikes: not voided, expired or past their expiry', async () => {
    expect((await getModelFlagDetail({ modelId: 10 }))?.strikes).toBe(2);
  });

  it('degrades the strike and note counts to null instead of failing the pane', async () => {
    await pg.exec('DROP TABLE "UserStrike"');
    memory.notes.mockRejectedValue(new Error('down'));
    const detail = await getModelFlagDetail({ modelId: 10 });
    expect(detail).toMatchObject({ strikes: null, notes: null });
  });

  it('copes with a model that has no versions, files or metrics', async () => {
    const detail = await getModelFlagDetail({ modelId: 13 });
    expect(detail).toMatchObject({
      versionCount: 0,
      latestPublishedAt: null,
      mainFile: null,
      downloads: null,
      openReports: 0,
    });
  });

  it('is null for a model that does not exist', async () => {
    expect(await getModelFlagDetail({ modelId: 999 })).toBeNull();
  });
});

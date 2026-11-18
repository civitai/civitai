import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { sweepSearchUploads } from '~/server/jobs/search-upload-sweep';
import {
  findOwnedSearchUpload,
  hasUnscannedSearchUpload,
  writeSearchUploadFaceScan,
} from '~/server/services/search-upload-rows';

/** The search-upload rows' real SQL against an in-process Postgres. Ids are invented. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = new URL(
  '../../../../packages/civitai-db-schema/prisma/migrations/20271118060000_image_search_upload_index/migration.sql',
  import.meta.url
);
// PGlite has no concurrent index builds; the index itself is the migration's.
const createIndex = () => db.exec(readFileSync(MIGRATION, 'utf8').replace('CONCURRENTLY ', ''));

let db: PGlite;
let raw: ReturnType<typeof pgliteRaw>;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "postId" int,
      url text NOT NULL DEFAULT 'key',
      "nsfwLevel" int NOT NULL DEFAULT 1,
      ingestion "ImageIngestionStatus" NOT NULL,
      "tosViolation" boolean NOT NULL DEFAULT false,
      "needsReview" text,
      "blockedFor" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      metadata jsonb,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "ScanLabelItem" ("imageId" int UNIQUE NOT NULL);
    CREATE TABLE "EvidenceHoldImage" ("imageId" int PRIMARY KEY);
  `);
  raw = pgliteRaw(db);
});
afterAll(() => db.close());

beforeEach(() => {
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});

const UPLOAD = `'{"searchUploadAppId": "search-upload", "searchUploadRef": "upload:b1"}'`;
const OLD = `now() - interval '2 hours'`;

describe('search-upload-sweep', () => {
  beforeEach(async () => {
    await db.exec(`
      DELETE FROM "ScanLabelItem"; DELETE FROM "EvidenceHoldImage"; DELETE FROM "Image";
      INSERT INTO "Image" (id, "userId", "postId", ingestion, "needsReview", "blockedFor", minor, metadata, "createdAt") VALUES
        (1, 5, NULL, 'Scanned', NULL, NULL, false, ${UPLOAD}, ${OLD}),
        (2, 5, NULL, 'Scanned', NULL, NULL, false, ${UPLOAD}, now()),
        (3, 5, NULL, 'Scanned', 'minor', NULL, true, ${UPLOAD}, ${OLD}),
        (4, 5, NULL, 'Blocked', NULL, 'Moderated', false, ${UPLOAD}, ${OLD}),
        (5, 5, NULL, 'Scanned', NULL, NULL, true, ${UPLOAD}, ${OLD}),
        (6, 5, NULL, 'Scanned', NULL, NULL, false, ${UPLOAD}, ${OLD}),
        (7, 5, NULL, 'Scanned', NULL, NULL, false, ${UPLOAD}, ${OLD}),
        (8, 5, NULL, 'Pending', NULL, NULL, false, ${UPLOAD}, ${OLD}),
        (9, 5, NULL, 'Scanned', NULL, NULL, false, '{"blockUploadedAppId": "app"}', ${OLD}),
        (10, 5, 77, 'Scanned', NULL, NULL, false, ${UPLOAD}, ${OLD}),
        (11, 5, NULL, 'Scanned', 'poi', NULL, false, ${UPLOAD}, ${OLD});
      INSERT INTO "ScanLabelItem" ("imageId") VALUES (6);
      INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (7);
    `);
  });

  it('deletes only a passed upload older than an hour', async () => {
    await createIndex();
    const deleted: number[] = [];
    const result = await sweepSearchUploads({ deleteImage: async (id) => void deleted.push(id) });
    expect(deleted).toEqual([1]);
    expect(result).toEqual({ swept: 1 });
  });

  it('skips a row held while the batch was running', async () => {
    await createIndex();
    await db.exec(`
      INSERT INTO "Image" (id, "userId", "postId", ingestion, metadata, "createdAt")
        VALUES (12, 5, NULL, 'Scanned', ${UPLOAD}, now() - interval '90 minutes');
    `);
    const deleted: number[] = [];
    await sweepSearchUploads({
      deleteImage: async (id) => {
        deleted.push(id);
        if (id === 1) await db.exec('INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (12)');
      },
    });
    expect(deleted).toEqual([1]);
  });

  it('sweeps nothing until the partial index exists', async () => {
    await db.exec('DROP INDEX IF EXISTS "Image_searchUpload_idx"');
    const deleted: number[] = [];
    const result = await sweepSearchUploads({ deleteImage: async (id) => void deleted.push(id) });
    expect(deleted).toEqual([]);
    expect(result).toEqual({ swept: 0, skipped: true });
  });
});

describe('search-upload rows', () => {
  beforeEach(async () => {
    await db.exec(`
      DELETE FROM "Image";
      INSERT INTO "Image" (id, "userId", "postId", ingestion, metadata, "createdAt") VALUES
        (21, 5, NULL, 'Pending', ${UPLOAD}, now()),
        (22, 6, NULL, 'Scanned', ${UPLOAD}, now()),
        (23, 5, NULL, 'Scanned', '{"blockUploadedAppId": "app"}', now());
    `);
  });

  it("adds the face record without dropping the row's other keys", async () => {
    await writeSearchUploadFaceScan(21, { ran: true, faces: [{ animeProbability: 0.5 }] });
    const { rows } = await db.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM "Image" WHERE id = 21'
    );
    expect(rows[0].metadata).toEqual({
      searchUploadAppId: 'search-upload',
      searchUploadRef: 'upload:b1',
      searchUploadFaceScan: { ran: true, faces: [{ animeProbability: 0.5 }] },
    });
  });

  it("finds the viewer's own upload only", async () => {
    expect((await findOwnedSearchUpload(5, 21))?.id).toBe(21);
    expect(await findOwnedSearchUpload(5, 22)).toBeNull();
    expect(await findOwnedSearchUpload(5, 23)).toBeNull();
  });

  it("sees an unscanned upload of the viewer, and no one else's", async () => {
    const since = new Date(Date.now() - 60_000);
    expect(await hasUnscannedSearchUpload(5, since)).toBe(true);
    expect(await hasUnscannedSearchUpload(6, since)).toBe(false);
  });
});

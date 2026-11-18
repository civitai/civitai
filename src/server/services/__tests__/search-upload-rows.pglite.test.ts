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
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3));
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
      DELETE FROM "ScanLabelItem"; DELETE FROM "EvidenceHoldImage"; DELETE FROM "CsamReport";
      DELETE FROM "Image";
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
        (11, 5, NULL, 'Scanned', 'poi', NULL, false, ${UPLOAD}, ${OLD}),
        (23, 5, NULL, 'Scanned', 'modRule', NULL, false, ${UPLOAD}, ${OLD}),
        (24, 5, NULL, 'Scanned', 'minor', NULL, false, ${UPLOAD}, ${OLD}),
        (25, 5, NULL, 'Scanned', 'csam', NULL, false, ${UPLOAD}, ${OLD});
      INSERT INTO "Image" (id, "userId", "postId", ingestion, "tosViolation", poi, metadata, "createdAt") VALUES
        (13, 5, NULL, 'Scanned', true, false, ${UPLOAD}, ${OLD}),
        (14, 5, NULL, 'Scanned', false, true, ${UPLOAD}, now() - interval '100 minutes'),
        (15, 8, NULL, 'Scanned', false, false, ${UPLOAD}, ${OLD}),
        (16, 9, NULL, 'Scanned', false, false, ${UPLOAD}, ${OLD}),
        (17, 5, NULL, 'Scanned', false, false, ${UPLOAD}, ${OLD}),
        (18, 5, NULL, 'Error', false, false, ${UPLOAD}, ${OLD}),
        (19, 5, NULL, 'Pending', false, false, ${UPLOAD}, now() - interval '2 days'),
        (20, 5, NULL, 'Error', true, false, ${UPLOAD}, ${OLD}),
        (21, 8, NULL, 'Error', false, false, ${UPLOAD}, ${OLD}),
        (22, 8, NULL, 'Pending', false, false, ${UPLOAD}, now() - interval '2 days');
      UPDATE "Image" SET "blockedFor" = 'Moderated' WHERE id = 17;
      -- Uploader 8 has an unsent CSAM report; uploader 9's was sent.
      INSERT INTO "CsamReport" ("userId", "reportSentAt") VALUES (8, NULL), (9, now());
      INSERT INTO "ScanLabelItem" ("imageId") VALUES (6);
      INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (7);
    `);
  });

  it('deletes a passed or failed upload older than an hour, and one never scanned after a day', async () => {
    await createIndex();
    const deleted: number[] = [];
    const result = await sweepSearchUploads({ deleteImage: async (id) => void deleted.push(id) });
    expect(deleted.sort((a, b) => a - b)).toEqual([1, 11, 14, 16, 18, 19, 23]);
    expect(result).toEqual({ swept: 7 });
  });

  it('deletes a row held for a review the moderator app hides, and keeps a minor or csam hold', async () => {
    await createIndex();
    const deleted: number[] = [];
    await sweepSearchUploads({ deleteImage: async (id) => void deleted.push(id) });
    expect(deleted).toEqual(expect.arrayContaining([11, 23]));
    expect(deleted).not.toContain(24);
    expect(deleted).not.toContain(25);
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
        if (deleted.length === 1)
          await db.exec('INSERT INTO "EvidenceHoldImage" ("imageId") VALUES (12)');
      },
    });
    expect(deleted).toContain(1);
    expect(deleted).not.toContain(12);
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

  it('records each face in order, a missing score as null, and no faces as an empty list', async () => {
    await writeSearchUploadFaceScan(21, {
      ran: false,
      faces: [{ animeProbability: 0.25 }, { animeProbability: null }, { animeProbability: 0.75 }],
    });
    await writeSearchUploadFaceScan(22, { ran: true, faces: [] });
    const { rows } = await db.query<{ id: number; scan: unknown }>(
      `SELECT id, metadata->'searchUploadFaceScan' AS scan FROM "Image" WHERE id IN (21, 22) ORDER BY id`
    );
    expect(rows).toEqual([
      {
        id: 21,
        scan: {
          ran: false,
          faces: [
            { animeProbability: 0.25 },
            { animeProbability: null },
            { animeProbability: 0.75 },
          ],
        },
      },
      { id: 22, scan: { ran: true, faces: [] } },
    ]);
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

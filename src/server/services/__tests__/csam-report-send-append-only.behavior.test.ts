import { createHash } from 'crypto';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The NCMEC send flow's write is accepted by the sent-report append-only trigger, and the sha256
 * of each uploaded file is on the row from the moment it is marked sent. Runs the trigger's own
 * migration against a Postgres stand-in. All ids and bytes below are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// `isProd: true` below makes this client variable required at module scope; a local `.env` hides
// that, CI does not.
await vi.hoisted(async () => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
});

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/civitai-db-schema/prisma/migrations/20261112120000_csam_report_append_only/migration.sql'
);

const { uploadFile, finishReport, cancelReport, getObject } = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
}));

vi.mock('@civitai/cybertipline-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof CybertiplineTools>()),
  Client: class {
    getStatus = async () => ({ data: { responseCode: 0 } });
    submitReport = async () => ({ data: { reportId: 900 } });
    uploadFile = uploadFile;
    submitFileDetails = vi.fn();
    finishReport = finishReport;
    cancelReport = cancelReport;
  },
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: undefined,
}));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImageUploadBackend: async () => ({
    bucket: 'test-images',
    backend: 'backblaze',
    s3: { send: () => getObject() },
  }),
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import {
  CSAM_SEND_SHORT_AFTER_HOURS,
  processCsamReport,
  SEND_SHORT_REASON,
} from '~/server/services/csam.service-new';

const stored = Buffer.from('the bytes the user uploaded');

const db = { pg: null as unknown as PGlite };
const JSON_COLUMNS = new Set(['details', 'images']);

/** Applies a Prisma `csamReport.update` to the stand-in, column for column. */
async function applyUpdate({
  where,
  data,
}: {
  where: { id: number };
  data: Record<string, unknown>;
}) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const sets = entries.map(([column, value], i) =>
    JSON_COLUMNS.has(column) ? `"${column}" = $${i + 1}::jsonb` : `"${column}" = $${i + 1}`
  );
  const values = entries.map(([column, value]) =>
    JSON_COLUMNS.has(column) ? JSON.stringify(value) : value
  );
  await db.pg.query(
    `UPDATE "CsamReport" SET ${sets.join(', ')} WHERE id = $${entries.length + 1}`,
    [...values, where.id]
  );
  return {};
}

async function readRow(id: number) {
  const { rows } = await db.pg.query<CsamReportProps>(`SELECT * FROM "CsamReport" WHERE id = $1`, [
    id,
  ]);
  return rows[0];
}

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "CsamReportType" AS ENUM ('Image', 'TrainingData', 'GeneratedImage', 'ExternalLink');
    CREATE TABLE "CsamReport" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "reportedById" INTEGER NOT NULL,
      "reportSentAt" TIMESTAMP(3),
      "archivedAt" TIMESTAMP(3),
      "contentRemovedAt" TIMESTAMP(3),
      "reportId" INTEGER,
      "details" JSONB NOT NULL DEFAULT '{}',
      "images" JSONB NOT NULL DEFAULT '[]',
      "type" "CsamReportType" NOT NULL DEFAULT 'Image'
    );
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(() => {
  getObject.mockReset().mockImplementation(async () => ({
    Body: { transformToByteArray: async () => new Uint8Array(stored) },
    ContentType: 'image/png',
    ContentLength: stored.length,
  }));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network fetch'));
  uploadFile.mockReset().mockResolvedValue({ data: { fileId: 'file-1', hash: 'ncmec-md5' } });
  finishReport.mockReset();
  cancelReport.mockReset();
  dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === 10
      ? { id: 10, email: 'mod@example.invalid', name: 'Mod', isModerator: true }
      : { id: 20, email: 'user@example.invalid', name: 'User', username: 'user' }
  );
  dbMock.dbRead.image.findMany.mockResolvedValue([
    {
      id: 501,
      url: 'stored-key-501',
      name: 'upload.png',
      type: 'image',
      mimeType: 'image/png',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      meta: {},
      post: null,
      tags: [],
    },
  ]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
  dbMock.dbWrite.csamReport.update.mockImplementation(applyUpdate as never);
});

async function sendNewReport(filedHoursAgo = 1) {
  const { rows } = await db.pg.query<{ id: number }>(
    `INSERT INTO "CsamReport" ("userId", "reportedById", "images", "details", "createdAt")
     VALUES (20, 10, '[{"id":501}]', '{}', now() - make_interval(hours => $1::int)) RETURNING id`,
    [filedHoursAgo]
  );
  const report = await readRow(rows[0].id);
  await processCsamReport(report);
  return rows[0].id;
}

describe('sending a report under the append-only trigger', () => {
  it('the trigger is live in the stand-in', async () => {
    const id = await sendNewReport();
    await expect(
      db.pg.query(`UPDATE "CsamReport" SET "details" = '{}'::jsonb WHERE id = $1`, [id])
    ).rejects.toThrow(/may only gain keys/);
  });

  it('accepts the send and records each file sha256 in the row it marks sent', async () => {
    const id = await sendNewReport();

    expect(cancelReport).not.toHaveBeenCalled();
    expect(finishReport).toHaveBeenCalledTimes(1);
    const row = await readRow(id);
    expect(row.reportSentAt).not.toBeNull();
    expect(row.details.images).toEqual([
      expect.objectContaining({
        id: 501,
        source: 'original',
        sha256: createHash('sha256').update(stored).digest('hex'),
        bytes: stored.length,
      }),
    ]);
  });

  it('accepts a report sent without an unreadable file once it is old enough', async () => {
    getObject.mockRejectedValue(
      Object.assign(new Error('synthetic storage outage'), {
        name: 'InternalError',
        $metadata: { httpStatusCode: 500 },
      })
    );

    const id = await sendNewReport(CSAM_SEND_SHORT_AFTER_HOURS + 1);

    expect(cancelReport).not.toHaveBeenCalled();
    const row = await readRow(id);
    expect(row.reportSentAt).not.toBeNull();
    expect(row.details.images).toEqual([{ id: 501, source: 'missing', reason: SEND_SHORT_REASON }]);
  });

  it('refuses a later rewrite of a recorded sha256', async () => {
    const id = await sendNewReport();
    await expect(
      db.pg.query(
        `UPDATE "CsamReport"
         SET "details" = jsonb_set("details", '{images,0,sha256}', '"0000"')
         WHERE id = $1`,
        [id]
      )
    ).rejects.toThrow(/may only gain keys/);
  });
});

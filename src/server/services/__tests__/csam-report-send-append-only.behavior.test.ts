import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The send and archive writes against the append-only trigger: a read-failure count merges into
 * an unsent row, and the archive's later write to a sent row passes. Runs the trigger's own
 * migration against a Postgres stand-in. All ids and bytes below are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// `isProd: true` makes `NEXT_PUBLIC_CIVITAI_LINK` required at module scope; a local `.env` hides
// that, CI does not.
await vi.hoisted(async () => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
});

const migration = (name: string) =>
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    `../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
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
  archiveCsamDataForReport,
  CSAM_SEND_CLAIM_EXPIRY_SECONDS,
  processCsamReport,
} from '~/server/services/csam.service-new';
import { CSAM_SEND_JOB_LOCK_SECONDS } from '~/server/jobs/process-csam';
import { CSAM_SEND_BLOCKED_AFTER_HOURS } from '~/server/services/csam.service-new';
import { logToAxiom } from '~/server/logging/client';
import { createCsamReport } from '~/server/services/csam.service';

const stored = Buffer.from('the bytes the user uploaded');

const db = { pg: null as unknown as PGlite };
const JSON_COLUMNS = new Set(['details', 'images']);

// The Prisma filters the send uses, as SQL: equality, null, `lt` and `OR`.
type Where = { [column: string]: unknown; OR?: Where[] };
function whereSql(where: Where, params: unknown[]): string {
  const parts = Object.entries(where).map(([column, value]) => {
    if (column === 'OR')
      return `(${(value as Where[]).map((w) => whereSql(w, params)).join(' OR ')})`;
    if (value === null) return `"${column}" IS NULL`;
    if (value instanceof Object && 'lt' in value) {
      params.push(value.lt);
      return `"${column}" < $${params.length}`;
    }
    params.push(value);
    return `"${column}" = $${params.length}`;
  });
  return parts.join(' AND ') || 'true';
}

async function applyUpdate({ where, data }: { where: Where; data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const params: unknown[] = entries.map(([column, value]) =>
    JSON_COLUMNS.has(column) ? JSON.stringify(value) : value
  );
  const sets = entries.map(([column], i) =>
    JSON_COLUMNS.has(column) ? `"${column}" = $${i + 1}::jsonb` : `"${column}" = $${i + 1}`
  );
  const result = await db.pg.query(
    `UPDATE "CsamReport" SET ${sets.join(', ')} WHERE ${whereSql(where, params)}`,
    params
  );
  return { count: result.affectedRows ?? 0 };
}

async function findFirst({ where }: { where: Where }) {
  const params: unknown[] = [];
  const { rows } = await db.pg.query(
    `SELECT * FROM "CsamReport" WHERE ${whereSql(where, params)} LIMIT 1`,
    params
  );
  return rows[0] ?? null;
}

async function create({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, value]) => value !== undefined);
  const { rows } = await db.pg.query(
    `INSERT INTO "CsamReport" (${entries.map(([column]) => `"${column}"`).join(', ')})
     VALUES (${entries
       .map(([column], i) => (JSON_COLUMNS.has(column) ? `$${i + 1}::jsonb` : `$${i + 1}`))
       .join(', ')})
     RETURNING *`,
    entries.map(([column, value]) => (JSON_COLUMNS.has(column) ? JSON.stringify(value) : value))
  );
  return rows[0];
}

const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (await db.pg.query(strings.map((part, i) => (i ? `$${i}` : '') + part).join(''), values)).rows;

async function deleteMany({ where }: { where: Where }) {
  const params: unknown[] = [];
  const result = await db.pg.query(
    `DELETE FROM "CsamReport" WHERE ${whereSql(where, params)}`,
    params
  );
  return { count: result.affectedRows ?? 0 };
}

async function readRow(id: number) {
  const { rows } = await db.pg.query<CsamReportProps>(`SELECT * FROM "CsamReport" WHERE id = $1`, [
    id,
  ]);
  return rows[0];
}

beforeAll(async () => {
  // A zone-less timestamp reads back as UTC, as Prisma reads it: otherwise a claim's age read back
  // is shifted by the local offset.
  db.pg = new PGlite({
    parsers: { 1114: (value: string) => new Date(`${value.replace(' ', 'T')}Z`) },
  });
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
  await db.pg.exec(readFileSync(migration('20261112120000_csam_report_append_only'), 'utf8'));
  await db.pg.exec(readFileSync(migration('20261123120000_csam_report_send_claim'), 'utf8'));
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
  cancelReport.mockReset().mockResolvedValue({ data: { responseCode: 0 } });
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
  dbMock.dbWrite.csamReport.update.mockReset().mockImplementation(applyUpdate as never);
  dbMock.dbWrite.csamReport.updateMany.mockReset().mockImplementation(applyUpdate as never);
  dbMock.dbWrite.csamReport.findFirst.mockReset().mockImplementation(findFirst as never);
  dbMock.dbWrite.csamReport.deleteMany.mockReset().mockImplementation(deleteMany as never);
  dbMock.dbWrite.csamReport.create.mockReset().mockImplementation(create as never);
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockReset().mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.map((part, i) => (i ? `$${i}` : '') + part).join('');
    return (await db.pg.query(sql, values)).affectedRows ?? 0;
  }) as never);
});

async function sendNewReport() {
  const { rows } = await db.pg.query<{ id: number }>(
    `INSERT INTO "CsamReport" ("userId", "reportedById", "images", "details")
     VALUES (20, 10, '[{"id":501}]', '{}') RETURNING id`
  );
  await processCsamReport(await readRow(rows[0].id));
  return rows[0].id;
}

describe('sending a report under the append-only trigger', () => {
  it('the trigger is live in the stand-in', async () => {
    const id = await sendNewReport();
    await expect(
      db.pg.query(`UPDATE "CsamReport" SET "details" = '{}'::jsonb WHERE id = $1`, [id])
    ).rejects.toThrow(/may only gain keys/);
  });

  it('lets the archiveSkipped write through to a sent row', async () => {
    const id = await sendNewReport();
    const sent = await readRow(id);

    // No user: the archive's shortest path, which stamps the row and adds a details key.
    await archiveCsamDataForReport({ ...sent, userId: null });

    expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledTimes(1);
    const row = await readRow(id);
    expect(row.archivedAt).not.toBeNull();
    expect(row.details).toEqual({ ...sent.details, archiveSkipped: 'no reported user' });
  });

  it('counts a failed read into the stored details, keeping what a report filed meanwhile wrote', async () => {
    const { rows } = await db.pg.query<{ id: number }>(
      `INSERT INTO "CsamReport" ("userId", "reportedById", "images", "details")
       VALUES (20, 10, '[{"id":501}]', '{}') RETURNING id`
    );
    const id = rows[0].id;
    getObject.mockImplementation(async () => {
      await db.pg.query(
        `UPDATE "CsamReport" SET "details" = "details" || '{"filedMeanwhile":true}' WHERE id = $1`,
        [id]
      );
      throw Object.assign(new Error('synthetic storage outage'), { name: 'InternalError' });
    });

    await processCsamReport({
      ...(await readRow(id)),
      createdAt: new Date(Date.now() - 3_600_000),
    });

    const row = await readRow(id);
    expect(row.reportSentAt).toBeNull();
    expect(row.details).toEqual({ filedMeanwhile: true, readFailures: { 501: 1 } });
  });

  it('counts a failed read on a report whose details are JSON null', async () => {
    const { rows } = await db.pg.query<{ id: number }>(
      `INSERT INTO "CsamReport" ("userId", "reportedById", "images", "details")
       VALUES (20, 10, '[{"id":501}]', 'null'::jsonb) RETURNING id`
    );
    const id = rows[0].id;
    getObject.mockRejectedValue(
      Object.assign(new Error('synthetic storage outage'), { name: 'InternalError' })
    );

    await processCsamReport({
      ...(await readRow(id)),
      createdAt: new Date(Date.now() - 3_600_000),
    });

    expect((await readRow(id)).details).toEqual({ readFailures: { 501: 1 } });
  });
});

describe('the send claim under the append-only trigger', () => {
  const audit = async (id: number) =>
    (
      await db.pg.query<{ op: string; oldDetailsFingerprint: string | null }>(
        `SELECT op, "oldDetailsFingerprint" FROM "CsamReportAudit" WHERE "csamReportId" = $1 ORDER BY id`,
        [id]
      )
    ).rows;

  async function insertClaimed(claimedSecondsAgo: number, userId = 20) {
    const { rows } = await db.pg.query<{ id: number }>(
      `INSERT INTO "CsamReport" ("userId", "reportedById", "images", "details", "reportId", "sendClaimId", "sendClaimedAt")
       VALUES ($2, 10, '[{"id":501}]', '{}', 800, gen_random_uuid(), $1) RETURNING id`,
      [new Date(Date.now() - claimedSecondsAgo * 1000), userId]
    );
    return rows[0].id;
  }
  const runStartCopy = readRow;
  const ANOTHER_RUN = '00000000-0000-4000-8000-000000000001';
  const takeOver = (id: number) =>
    db.pg.query(`UPDATE "CsamReport" SET "sendClaimId" = $2, "sendClaimedAt" = $3 WHERE id = $1`, [
      id,
      ANOTHER_RUN,
      new Date(),
    ]);
  const lines = (subType: string) =>
    vi
      .mocked(logToAxiom)
      .mock.calls.map(([payload]) => payload as Record<string, unknown>)
      .filter((line) => line.subType === subType);
  const newReport = async () =>
    (
      await db.pg.query<{ id: number }>(
        `INSERT INTO "CsamReport" ("userId", "reportedById", "images", "details")
         VALUES (20, 10, '[{"id":501}]', '{}') RETURNING id`
      )
    ).rows[0].id;

  it('a run whose claim was taken over during the send marks nothing sent, and leaves the new claim', async () => {
    vi.mocked(logToAxiom).mockClear();
    const id = await newReport();
    uploadFile.mockImplementationOnce(async () => {
      await takeOver(id);
      return { data: { fileId: 'file-1', hash: 'ncmec-md5' } };
    });

    await processCsamReport(await runStartCopy(id));

    const row = await readRow(id);
    expect(row.reportSentAt).toBeNull();
    expect(row.sendClaimId).toBe(ANOTHER_RUN);
    expect(lines('send-stamp-lost')).toEqual([
      expect.objectContaining({ reportId: id, ncmecReportId: 900 }),
    ]);
  });

  it('a run whose claim was taken over while it held the report back releases nothing', async () => {
    vi.mocked(logToAxiom).mockClear();
    const id = await newReport();
    getObject.mockImplementation(async () => {
      await takeOver(id);
      throw Object.assign(new Error('synthetic storage outage'), { name: 'InternalError' });
    });

    await processCsamReport(await runStartCopy(id));

    const row = await readRow(id);
    expect(row.sendClaimId).toBe(ANOTHER_RUN);
    expect(row.details).toEqual({});
    expect(lines('send-claim-lost')).toEqual([expect.objectContaining({ reportId: id })]);
  });

  it('claims, stores the id and marks the report sent unaudited while unsent; the archive write after is audited', async () => {
    const id = await sendNewReport();

    const sent = await readRow(id);
    expect(sent).toMatchObject({ reportId: 900, sendClaimId: null, sendClaimedAt: null });
    expect(sent.reportSentAt).not.toBeNull();
    expect(await audit(id)).toEqual([]);

    await archiveCsamDataForReport({ ...sent, userId: null });

    expect(await audit(id)).toEqual([
      { op: 'update', oldDetailsFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('takes no claim on a sent report, from a run copy that still reads it unsent', async () => {
    const id = await sendNewReport();
    uploadFile.mockClear();

    await processCsamReport({ ...(await runStartCopy(id)), reportSentAt: null });

    expect(uploadFile).not.toHaveBeenCalled();
    expect(await audit(id)).toEqual([]);
    expect(await readRow(id)).toMatchObject({ reportId: 900, sendClaimId: null });
  });

  it('expires a claim after the job lock, and before a report it held is alerted as blocked', () => {
    expect(CSAM_SEND_CLAIM_EXPIRY_SECONDS).toBeGreaterThan(CSAM_SEND_JOB_LOCK_SECONDS);
    expect(CSAM_SEND_CLAIM_EXPIRY_SECONDS).toBeLessThan(CSAM_SEND_BLOCKED_AFTER_HOURS * 3600);
  });

  it('leaves a report to a run that has held it as long as the job lock', async () => {
    const id = await insertClaimed(CSAM_SEND_JOB_LOCK_SECONDS + 60);
    const held = await readRow(id);

    await processCsamReport(await runStartCopy(id));

    expect(cancelReport).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(await readRow(id)).toEqual(held);
  });

  it('takes over a claim past its expiry, cancelling the CyberTip its run left open first', async () => {
    const id = await insertClaimed(CSAM_SEND_CLAIM_EXPIRY_SECONDS + 60);

    await processCsamReport(await runStartCopy(id));

    expect(cancelReport).toHaveBeenCalledWith({ id: 800 });
    expect(cancelReport.mock.invocationCallOrder[0]).toBeLessThan(
      uploadFile.mock.invocationCallOrder[0]
    );
    const row = await readRow(id);
    expect(row).toMatchObject({ reportId: 900, sendClaimId: null });
    expect(row.reportSentAt).not.toBeNull();
    expect(row.details).toMatchObject({ cancelledReportIds: [800] });
  });

  // Each filing test files for an account of its own: rows from earlier tests stay in the stand-in.
  let account = 1000;
  const unsentOthers = async (id: number) =>
    (
      await db.pg.query<CsamReportProps>(
        `SELECT * FROM "CsamReport" WHERE "userId" = $2 AND id <> $1 AND "reportSentAt" IS NULL`,
        [id, account]
      )
    ).rows;
  const fileImage = (imageId: number) =>
    createCsamReport({ userId: account, reportedById: 10, type: 'Image', imageIds: [imageId] });

  it('sends a report as claimed, and a filing made during the send becomes a report of its own', async () => {
    account++;
    const { rows } = await db.pg.query<{ id: number }>(
      `INSERT INTO "CsamReport" ("userId", "reportedById", "images", "details")
       VALUES ($1, 10, '[{"id":501}]', '{}') RETURNING id`,
      [account]
    );
    const id = rows[0].id;
    uploadFile.mockImplementationOnce(async () => {
      await fileImage(502);
      return { data: { fileId: 'file-1', hash: 'ncmec-md5' } };
    });

    await processCsamReport(await runStartCopy(id));

    const sent = await readRow(id);
    expect(sent.reportSentAt).not.toBeNull();
    expect(sent.images).toEqual([{ id: 501 }]);
    expect(sent.details.images?.map((image) => image.id)).toEqual([501]);
    expect(await unsentOthers(id)).toEqual([
      expect.objectContaining({ images: [{ id: 502 }], sendClaimId: null }),
    ]);
  });

  it('once the claim has expired, takes a filing in and sends the union on the next run', async () => {
    account++;
    const id = await insertClaimed(CSAM_SEND_CLAIM_EXPIRY_SECONDS + 60, account);
    dbMock.dbRead.image.findMany.mockImplementation(
      async ({ where }: { where: { id: { in: number[] } } }) =>
        where.id.in.map((imageId) => ({
          id: imageId,
          url: `stored-key-${imageId}`,
          name: 'upload.png',
          type: 'image',
          mimeType: 'image/png',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          meta: {},
          post: null,
          tags: [],
        }))
    );

    await fileImage(502);

    expect(await unsentOthers(id)).toEqual([]);
    expect(await readRow(id)).toMatchObject({
      images: [{ id: 501 }, { id: 502 }],
      sendClaimId: null,
    });

    await processCsamReport(await runStartCopy(id));

    expect(cancelReport).toHaveBeenCalledWith({ id: 800 });
    expect(uploadFile).toHaveBeenCalledTimes(2);
    const sent = await readRow(id);
    expect(sent.reportSentAt).not.toBeNull();
    expect(sent.details.images?.map((image) => image.id)).toEqual([501, 502]);
  });
});

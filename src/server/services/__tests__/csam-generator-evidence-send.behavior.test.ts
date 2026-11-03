import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as EvidenceStore from '~/server/services/generator-evidence/evidence-store';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Sending a report of preserved generator evidence: files come from the evidence copy only, checked
 * against their sha256, and are described without a URL or storage path. Runs the send job's own
 * code against a Postgres stand-in. All ids and bytes below are invented.
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

const {
  uploadFile,
  finishReport,
  cancelReport,
  getObject,
  submitReport,
  submitFileDetails,
  readEvidenceObject,
} = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
  submitReport: vi.fn(),
  submitFileDetails: vi.fn(),
  readEvidenceObject: vi.fn(),
}));

vi.mock('@civitai/cybertipline-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof CybertiplineTools>()),
  Client: class {
    getStatus = async () => ({ data: { responseCode: 0 } });
    submitReport = submitReport;
    uploadFile = uploadFile;
    submitFileDetails = submitFileDetails;
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

vi.mock('~/server/services/generator-evidence/evidence-store', async (importOriginal) => ({
  ...(await importOriginal<typeof EvidenceStore>()),
  readEvidenceObject,
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import { getCsamsToReport, processCsamReport } from '~/server/services/csam.service-new';
import { createHash } from 'crypto';

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
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "activity" TEXT NOT NULL,
      "entityType" TEXT,
      "entityId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  submitReport.mockReset().mockResolvedValue({ data: { reportId: 900 } });
  submitFileDetails.mockReset().mockResolvedValue({ data: { responseCode: 0 } });
  readEvidenceObject
    .mockReset()
    .mockImplementation(async () => ({ bytes: new Uint8Array(stored) }));
  // A view of the output on THIS report; views of the input on another report or entity, which must not count.
  const views = [
    { entityType: 'csamReport', onThisReport: true, activity: `generatorEvidence:view:${OUTPUT}` },
    { entityType: 'csamReport', onThisReport: false, activity: `generatorEvidence:view:${INPUT}` },
    { entityType: 'image', onThisReport: true, activity: `generatorEvidence:view:${INPUT}` },
  ];
  dbMock.dbWrite.modActivity.findMany
    .mockReset()
    .mockImplementation((async ({
      where,
    }: {
      where: { entityType: string; entityId: number; activity: { in: string[] } };
    }) =>
      views
        .filter(
          (v) =>
            v.entityType === where.entityType &&
            v.onThisReport &&
            where.entityId > 0 &&
            where.activity.in.includes(v.activity)
        )
        .map((v) => ({ activity: v.activity, userId: 10 }))) as never);
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

const INPUT = 'INPUT0000000001.jpeg';
const OUTPUT = 'OUTPUT000000001.png';
const WORKFLOW = '20-20261101000000000000';
const sha = createHash('sha256').update(stored).digest('hex');

function evidenceDetails({ approved = true, outputSha = sha } = {}) {
  const preserved = (blobId: string, role: string, sha256: string) => ({
    blobId,
    role,
    status: 'preserved',
    evidenceKey: `generator-evidence/20/${WORKFLOW}/${blobId}`,
    sha256,
    bytes: stored.length,
    contentType: 'image/png',
  });
  return {
    generatorEvidence: {
      version: 1,
      priorCTReports: [4242],
      ...(approved && { approvedAt: '2026-11-02T00:00:00Z', approvedById: 10 }),
    },
    generatedImages: [
      {
        jobId: WORKFLOW,
        source: 'workflow',
        workflowId: WORKFLOW,
        prompt: 'the prompt text',
        negativePrompt: 'the negative text',
        resources: ['urn:air:sdxl:checkpoint:civitai:1@2'],
        blobs: [
          preserved(OUTPUT, 'output', outputSha),
          { ...preserved(INPUT, 'input', sha), derivedOutputIds: [OUTPUT] },
          { blobId: 'WITHHELD0000001.png', role: 'output', status: 'blocked-unreadable' },
        ],
      },
    ],
  };
}

async function sendEvidenceReport(details: unknown) {
  const { rows } = await db.pg.query<{ id: number }>(
    `INSERT INTO "CsamReport" ("userId", "reportedById", "type", "details")
     VALUES (20, 10, 'GeneratedImage', $1::jsonb) RETURNING id`,
    [JSON.stringify(details)]
  );
  await processCsamReport(await readRow(rows[0].id));
  return rows[0].id;
}

const detailsFor = (blobId: string) =>
  submitFileDetails.mock.calls
    .map(([details]) => details)
    .find((details) => details.originalFileName === blobId);

describe('sending a report of preserved generator evidence', () => {
  it('sends each preserved file from its evidence copy, inputs first, and marks the report sent', async () => {
    const id = await sendEvidenceReport(evidenceDetails());

    expect(readEvidenceObject.mock.calls.map(([key]) => key).sort()).toEqual([
      `generator-evidence/20/${WORKFLOW}/${INPUT}`,
      `generator-evidence/20/${WORKFLOW}/${OUTPUT}`,
    ]);
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(submitFileDetails.mock.calls[0][0].originalFileName).toBe(INPUT);
    expect((await readRow(id)).reportSentAt).not.toBeNull();
  });

  it('opens no CyberTip when a preserved copy no longer matches its sha256', async () => {
    const id = await sendEvidenceReport(evidenceDetails({ outputSha: 'f'.repeat(64) }));

    expect(submitReport).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect((await readRow(id)).reportSentAt).toBeNull();
  });

  it('sends nothing until a moderator approves the report, and the job does not pick it up', async () => {
    const id = await sendEvidenceReport(evidenceDetails({ approved: false }));

    expect(submitReport).not.toHaveBeenCalled();
    expect((await readRow(id)).reportSentAt).toBeNull();
    dbMock.dbRead.csamReport.findMany.mockResolvedValueOnce([await readRow(id)] as never);
    expect(await getCsamsToReport()).toEqual([]);
  });

  it('marks a user-uploaded input as not generative, and an output as generative', async () => {
    await sendEvidenceReport(evidenceDetails());

    expect(detailsFor(INPUT).fileAnnotations).toEqual({ generativeAi: false });
    expect(detailsFor(OUTPUT).fileAnnotations).toEqual({ generativeAi: true });
    expect(detailsFor(INPUT).additionalInfo[0]).toMatch(
      /may be a real photo; outputs .+ were derived from it/
    );
  });

  it('attaches the prompt, negative prompt and resources to every file', async () => {
    await sendEvidenceReport(evidenceDetails());

    for (const blobId of [INPUT, OUTPUT])
      expect(detailsFor(blobId).details).toEqual([
        {
          type: 'EXIF',
          valuePair: [
            { name: 'prompt', value: 'the prompt text' },
            { name: 'negativePrompt', value: 'the negative text' },
            { name: 'resources', value: 'urn:air:sdxl:checkpoint:civitai:1@2' },
          ],
        },
      ]);
  });

  it('puts no URL or storage path anywhere in what NCMEC receives, and says the files were never public', async () => {
    await sendEvidenceReport(evidenceDetails());

    const sent = JSON.stringify([submitReport.mock.calls, submitFileDetails.mock.calls]);
    expect(sent).not.toMatch(/https?:\/\//);
    expect(sent).not.toContain('generator-evidence/');
    expect(sent).not.toContain('locationOfFile');
    for (const blobId of [INPUT, OUTPUT]) expect(detailsFor(blobId).publiclyAvailable).toBe(false);
    expect(submitReport.mock.calls[0][0].personOrUserReported.priorCTReports).toEqual([4242]);
  });

  it('reports a file as viewed only when a moderator view of it on this report is recorded', async () => {
    const id = await sendEvidenceReport(evidenceDetails());

    expect(detailsFor(OUTPUT).fileViewedByEsp).toBe(true);
    expect(detailsFor(INPUT).fileViewedByEsp).toBe(false);
    const [{ where }] = dbMock.dbWrite.modActivity.findMany.mock.calls[0] as [
      { where: { entityId: number } }
    ];
    expect(where.entityId).toBe(id);
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
  });
});

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as EvidenceStore from '~/server/services/generator-evidence/evidence-store';
import type * as EvidencePayload from '~/server/services/generator-evidence/evidence-payload';
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
  streamEvidenceObject,
  hashEvidenceObject,
  evidenceFileDetails,
} = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
  submitReport: vi.fn(),
  submitFileDetails: vi.fn(),
  streamEvidenceObject: vi.fn(),
  hashEvidenceObject: vi.fn(),
  evidenceFileDetails: vi.fn(),
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

// The real details, unless a test stands in for a field the payload might one day leave unescaped.
vi.mock('~/server/services/generator-evidence/evidence-payload', async (importOriginal) => {
  const actual = await importOriginal<typeof EvidencePayload>();
  evidenceFileDetails.mockImplementation(actual.evidenceFileDetails);
  return { ...actual, evidenceFileDetails };
});

vi.mock('~/server/services/generator-evidence/evidence-store', async (importOriginal) => ({
  ...(await importOriginal<typeof EvidenceStore>()),
  streamEvidenceObject,
  hashEvidenceObject,
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import {
  CSAM_EVIDENCE_APPROVAL_OVERDUE_HOURS,
  getCsamsToReport,
  logOverdueEvidenceApprovals,
  processCsamReport,
} from '~/server/services/csam.service-new';
import {
  EXCLUDED_FILES_NOTICE,
  MAX_EVIDENCE_FILES_PER_REPORT,
  MAX_GENERATION_LINE_CHARS,
  TRUNCATION_MARKER,
} from '~/server/services/generator-evidence/evidence-payload';
import { evidenceVersion } from '~/server/services/generator-evidence/evidence-meta';
import {
  approveGeneratorEvidenceReport,
  excludeGeneratorEvidenceFile,
  recopyGeneratorEvidenceFile,
} from '~/server/services/generator-evidence/generator-evidence.service';
import type { EvidenceStore as PreserveStore } from '~/server/services/generator-evidence/preserve-blob';
import { clearUnconfirmedOpens } from '~/server/services/csam-unconfirmed-open';
import { buildReport, buildSubmitFileDetails } from '@civitai/cybertipline-tools';
import { Parser } from 'xml2js';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
    if (value instanceof Object && 'in' in value) {
      params.push(value.in);
      return `"${column}" = ANY($${params.length})`;
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

async function findMany({ where }: { where: Where }) {
  const params: unknown[] = [];
  const { rows } = await db.pg.query(
    `SELECT * FROM "CsamReport" WHERE ${whereSql(where, params)}`,
    params
  );
  return rows;
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

/** As NCMEC answers: XML that is not well-formed is refused. */
function refuseIllFormed(xml: string) {
  if (/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(xml))
    throw new Error('synthetic NCMEC refusal: a character outside XML');
  new Parser({ strict: true, async: false }).parseString(xml, (e: Error | null) => {
    if (e) throw new Error(`synthetic NCMEC refusal: ${e.message}`);
  });
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
  submitReport.mockReset().mockImplementation(async (report) => {
    refuseIllFormed(buildReport(report));
    return { data: { reportId: 900 } };
  });
  submitFileDetails.mockReset().mockImplementation(async (details) => {
    refuseIllFormed(buildSubmitFileDetails(details));
    return { data: { responseCode: 0 } };
  });
  streamEvidenceObject
    .mockReset()
    .mockImplementation(async () => ({ chunks: [new Uint8Array(stored)] }));
  // The streamed hash of whatever the store holds now, without counting as a read of the file.
  hashEvidenceObject.mockReset().mockImplementation(async (key: string) => {
    const hash = createHash('sha256');
    for (const chunk of (await streamEvidenceObject.getMockImplementation()!(key)).chunks)
      hash.update(chunk);
    return hash.digest('hex');
  });
  viewsOf = defaultViews;
  dbMock.dbWrite.modActivity.findMany
    .mockReset()
    .mockImplementation((async ({
      where,
    }: {
      where: { entityType: string; entityId: { in: number[] }; activity: { in: string[] } };
    }) =>
      views
        .filter(
          (v) =>
            v.entityType === where.entityType &&
            where.entityId.in.includes(v.entityId) &&
            where.activity.in.includes(v.activity)
        )
        .map((v) => ({ activity: v.activity, userId: 10, entityId: v.entityId }))) as never);
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
  dbMock.dbWrite.csamReport.findMany.mockReset().mockImplementation(findMany as never);
  dbMock.dbWrite.csamReport.deleteMany.mockReset().mockImplementation(deleteMany as never);
  dbMock.dbWrite.csamReport.create.mockReset().mockImplementation(create as never);
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockReset().mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings
      .map((part, i) => (i ? `$${i}` : '') + part)
      .join('')
      // Prisma sends an id list typed; PGlite cannot infer it.
      .replace(/UNNEST\((\$\d+)\)/g, 'UNNEST($1::int[])');
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

type View = { entityType: string; entityId: number; activity: string };
const viewOf = (blobId: string, entityId: number, entityType = 'csamReport'): View => ({
  entityType,
  entityId,
  activity: `generatorEvidence:view:${blobId}`,
});
// A view of the output on this report; views of the input on a report that is not the user's, and
// on another entity, which must not count.
const defaultViews = (id: number) => [
  viewOf(OUTPUT, id),
  viewOf(INPUT, id + 1000),
  viewOf(INPUT, id, 'image'),
];
let viewsOf: (id: number) => View[] = defaultViews;
let views: View[] = [];

async function insertEvidenceReport(details: unknown, { userId = 20, sent = false } = {}) {
  const { rows } = await db.pg.query<{ id: number }>(
    `INSERT INTO "CsamReport" ("userId", "reportedById", "type", "details", "reportSentAt")
     VALUES ($1, 10, 'GeneratedImage', $2::jsonb, $3) RETURNING id`,
    [userId, JSON.stringify(details), sent ? new Date() : null]
  );
  return rows[0].id;
}

async function sendEvidenceReport(details: unknown) {
  const id = await insertEvidenceReport(details);
  views = viewsOf(id);
  await processCsamReport(await readRow(id));
  return id;
}

const detailsFor = (blobId: string) =>
  submitFileDetails.mock.calls
    .map(([details]) => details)
    .find((details) => details.originalFileName === blobId);

describe('sending a report of preserved generator evidence', () => {
  it('sends each preserved file from its evidence copy, inputs first, and marks the report sent', async () => {
    const id = await sendEvidenceReport(evidenceDetails());

    expect([...new Set(streamEvidenceObject.mock.calls.map(([key]) => key))].sort()).toEqual([
      `generator-evidence/20/${WORKFLOW}/${INPUT}`,
      `generator-evidence/20/${WORKFLOW}/${OUTPUT}`,
    ]);
    expect(uploadFile).toHaveBeenCalledTimes(2);
    for (const [{ file }] of uploadFile.mock.calls)
      expect(Buffer.from(await (file as File).arrayBuffer()).equals(Buffer.from(stored))).toBe(
        true
      );
    expect(submitFileDetails.mock.calls[0][0].originalFileName).toBe(INPUT);
    expect((await readRow(id)).reportSentAt).not.toBeNull();
  });

  it('holds at most one file at a time: checked by streaming, then read once for its upload', async () => {
    let held = 0;
    let mostHeld = 0;
    hashEvidenceObject.mockResolvedValue(sha);
    streamEvidenceObject.mockImplementation(async () => {
      mostHeld = Math.max(mostHeld, ++held);
      return { chunks: [new Uint8Array(stored)] };
    });
    uploadFile.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      held--;
      return { data: { fileId: 'file-1', hash: 'ncmec-md5' } };
    });

    const id = await sendEvidenceReport(evidenceDetails());

    expect(hashEvidenceObject).toHaveBeenCalledTimes(2);
    expect(streamEvidenceObject).toHaveBeenCalledTimes(2);
    expect(mostHeld).toBe(1);
    expect((await readRow(id)).reportSentAt).not.toBeNull();
  });

  it('opens no CyberTip for a report over the file limit, and reads none of its files', async () => {
    loggingMock.logToAxiom.mockClear();
    const details = evidenceDetails();
    const [output] = details.generatedImages[0].blobs;
    details.generatedImages.push({
      ...details.generatedImages[0],
      jobId: 'more',
      blobs: Array.from({ length: MAX_EVIDENCE_FILES_PER_REPORT }, (_, i) => ({
        ...output,
        blobId: `MORE${String(i).padStart(11, '0')}.png`,
      })),
    });

    const id = await sendEvidenceReport(details);

    expect(submitReport).not.toHaveBeenCalled();
    expect(hashEvidenceObject).not.toHaveBeenCalled();
    expect((await readRow(id)).reportSentAt).toBeNull();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ subType: 'evidence-too-large', reportId: id })
    );
  });

  it('opens no CyberTip when a preserved copy no longer matches its sha256', async () => {
    const id = await sendEvidenceReport(evidenceDetails({ outputSha: 'f'.repeat(64) }));

    expect(submitReport).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect((await readRow(id)).reportSentAt).toBeNull();
  });

  it('cancels the CyberTip when a preserved copy changes after the check, sending none of its bytes', async () => {
    const OTHER = new Uint8Array([9, 9, 9]);
    submitReport.mockImplementationOnce(async (report) => {
      refuseIllFormed(buildReport(report));
      streamEvidenceObject.mockImplementation(async (key: string) => ({
        chunks: [key.endsWith(OUTPUT) ? OTHER : new Uint8Array(stored)],
      }));
      return { data: { reportId: 900 } };
    });

    const id = await sendEvidenceReport(evidenceDetails());

    expect(cancelReport).toHaveBeenCalledTimes(1);
    expect(detailsFor(OUTPUT)).toBeUndefined();
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

  it('sends the same bytes to NCMEC whether or not the report keeps each output’s job id', async () => {
    const JOB = 'a1b2c3d4-0000-4000-8000-000000000001';
    const sent = () =>
      JSON.stringify([
        submitReport.mock.calls,
        submitFileDetails.mock.calls,
        uploadFile.mock.calls,
      ]);
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-07T00:00:00Z') });
    try {
      await sendEvidenceReport(evidenceDetails());
      const without = sent();
      for (const fn of [submitReport, submitFileDetails, uploadFile]) fn.mockClear();

      const withJob = evidenceDetails();
      for (const blob of withJob.generatedImages[0].blobs)
        if (blob.role === 'output') Object.assign(blob, { orchestratorJobId: JOB });
      await sendEvidenceReport(withJob);

      expect(submitFileDetails).toHaveBeenCalled();
      expect(sent()).toBe(without);
      expect(sent()).not.toContain(JOB);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a file as viewed only when a moderator view of it on one of the user's reports is recorded", async () => {
    await sendEvidenceReport(evidenceDetails());

    expect(detailsFor(OUTPUT).fileViewedByEsp).toBe(true);
    expect(detailsFor(INPUT).fileViewedByEsp).toBe(false);
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
  });

  describe("a file viewed on the user's earlier report", () => {
    const earlierWith = (inputSha: string) => {
      const details = evidenceDetails();
      Object.assign(details.generatedImages[0].blobs[1], { sha256: inputSha });
      return details;
    };

    it('counts as viewed when the earlier report held the same bytes', async () => {
      const earlier = await insertEvidenceReport(earlierWith(sha), { sent: true });
      viewsOf = (id) => [viewOf(OUTPUT, id), viewOf(INPUT, earlier)];

      await sendEvidenceReport(evidenceDetails());

      expect(detailsFor(INPUT).fileViewedByEsp).toBe(true);
    });

    it('does not count when the earlier report held other bytes under the same id', async () => {
      const earlier = await insertEvidenceReport(earlierWith('0'.repeat(64)), { sent: true });
      viewsOf = (id) => [viewOf(OUTPUT, id), viewOf(INPUT, earlier)];

      await sendEvidenceReport(evidenceDetails());

      expect(detailsFor(INPUT).fileViewedByEsp).toBe(false);
    });

    it("does not count when the earlier report is another user's", async () => {
      const other = await insertEvidenceReport(earlierWith(sha), { userId: 21, sent: true });
      viewsOf = (id) => [viewOf(OUTPUT, id), viewOf(INPUT, other)];

      await sendEvidenceReport(evidenceDetails());

      expect(detailsFor(INPUT).fileViewedByEsp).toBe(false);
    });
  });

  it('also writes the prompt, negative prompt and resources into each file as plain text', async () => {
    await sendEvidenceReport(evidenceDetails());

    for (const blobId of [INPUT, OUTPUT])
      expect(detailsFor(blobId).additionalInfo[1]).toBe(
        [
          'Prompt: the prompt text',
          'Negative prompt: the negative text',
          'Resources: urn:air:sdxl:checkpoint:civitai:1@2',
        ].join('\n')
      );
  });

  it('cuts a prompt past the limit within the limit, and says the full text is preserved', async () => {
    const details = evidenceDetails();
    const long = 'p'.repeat(MAX_GENERATION_LINE_CHARS + 50);
    details.generatedImages[0].prompt = long;

    await sendEvidenceReport(details);

    const [promptLine, ...rest] = detailsFor(OUTPUT).additionalInfo[1].split('\n');
    expect(promptLine).toMatch(/^Prompt: p+… \[truncated; full text preserved\]$/);
    expect([...promptLine]).toHaveLength(MAX_GENERATION_LINE_CHARS);
    expect(rest).toEqual([
      'Negative prompt: the negative text',
      'Resources: urn:air:sdxl:checkpoint:civitai:1@2',
    ]);
    expect(detailsFor(OUTPUT).details[0].valuePair[0].value).toBe(long);
  });

  describe('a file one workflow produced and another used as its input', () => {
    const LATER = '20-20261102000000000000';
    const reusing = () => {
      const details = evidenceDetails();
      details.generatedImages.push({
        ...details.generatedImages[0],
        jobId: LATER,
        workflowId: LATER,
        blobs: [
          {
            ...details.generatedImages[0].blobs[0],
            role: 'input',
            derivedOutputIds: ['OTHER000000001.png'],
          },
        ],
      });
      return details;
    };

    it('is sent once, as a generated output', async () => {
      await sendEvidenceReport(reusing());

      expect(uploadFile).toHaveBeenCalledTimes(2);
      expect(detailsFor(OUTPUT).fileAnnotations).toEqual({ generativeAi: true });
      expect(detailsFor(OUTPUT).additionalInfo[0]).not.toMatch(/real photo/);
    });

    it('is a generated output even when its producing workflow was added to the report later', async () => {
      const details = reusing();
      details.generatedImages.reverse();

      await sendEvidenceReport(details);

      expect(detailsFor(OUTPUT).fileAnnotations).toEqual({ generativeAi: true });
      expect(detailsFor(OUTPUT).additionalInfo[0]).toContain(WORKFLOW);
      expect(detailsFor(INPUT).fileAnnotations).toEqual({ generativeAi: false });
    });
  });

  it('opens no CyberTip when a preserved file is recorded with a type that is not evidence media', async () => {
    const details = evidenceDetails();
    Object.assign(details.generatedImages[0].blobs[0], { contentType: 'text/html' });

    const id = await sendEvidenceReport(details);

    expect(submitReport).not.toHaveBeenCalled();
    expect((await readRow(id)).reportSentAt).toBeNull();
  });

  it('sends the rest of the report without a file a moderator excluded', async () => {
    const details = evidenceDetails({ outputSha: 'f'.repeat(64) });
    Object.assign(details.generatedImages[0].blobs[0], {
      status: 'excluded',
      excluded: {
        reason: 'damaged copy',
        byId: 10,
        at: '2026-11-02T00:00:00Z',
        status: 'preserved',
      },
    });

    const id = await sendEvidenceReport(details);

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(submitFileDetails.mock.calls.map(([d]) => d.originalFileName)).toEqual([INPUT]);
    expect((await readRow(id)).reportSentAt).not.toBeNull();
  });
});

describe('a preserved-evidence report left waiting for approval', () => {
  const filedHoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000 - 60_000);
  const overdueLines = () =>
    loggingMock.logToAxiom.mock.calls
      .map(([line]) => line as { subType?: string; awaiting?: string; reportId?: number })
      .filter((line) => line.subType === 'send-blocked' && line.awaiting === 'evidence-approval');

  it('raises a blocked line once it has waited past the threshold, and not once approved', async () => {
    loggingMock.logToAxiom.mockClear();
    dbMock.dbWrite.csamReport.findMany.mockResolvedValueOnce([
      {
        id: 1,
        createdAt: filedHoursAgo(CSAM_EVIDENCE_APPROVAL_OVERDUE_HOURS),
        details: evidenceDetails({ approved: false }),
      },
      {
        id: 2,
        createdAt: filedHoursAgo(CSAM_EVIDENCE_APPROVAL_OVERDUE_HOURS),
        details: evidenceDetails(),
      },
    ] as never);

    await logOverdueEvidenceApprovals();

    const [{ where }] = dbMock.dbWrite.csamReport.findMany.mock.calls.at(-1) as [
      { where: { createdAt: { lt: Date }; reportSentAt: null } }
    ];
    expect(where.reportSentAt).toBeNull();
    expect(Date.now() - where.createdAt.lt.getTime()).toBeGreaterThanOrEqual(
      CSAM_EVIDENCE_APPROVAL_OVERDUE_HOURS * 3_600_000 - 1000
    );
    expect(overdueLines()).toEqual([expect.objectContaining({ reportId: 1, type: 'error' })]);
  });
});

describe('free text NCMEC cannot carry as XML', () => {
  it('sends a prompt whose cut falls inside an emoji, cut on whole characters', async () => {
    const details = evidenceDetails();
    details.generatedImages[0].prompt = 'p' + '\u{1F600}'.repeat(MAX_GENERATION_LINE_CHARS);

    const id = await sendEvidenceReport(details);

    expect((await readRow(id)).reportSentAt).not.toBeNull();
    const [promptLine] = detailsFor(OUTPUT).additionalInfo[1].split('\n');
    expect([...promptLine].length).toBeLessThanOrEqual(MAX_GENERATION_LINE_CHARS);
    expect(promptLine.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('sends a prompt holding a control character, which is replaced in every field', async () => {
    const details = evidenceDetails();
    details.generatedImages[0].prompt = 'before\u0008after';

    const id = await sendEvidenceReport(details);

    expect((await readRow(id)).reportSentAt).not.toBeNull();
    expect(detailsFor(OUTPUT).additionalInfo[1]).toContain('Prompt: before\uFFFDafter');
    expect(detailsFor(OUTPUT).details[0].valuePair[0].value).toBe('before\uFFFDafter');
  });
});

describe('a file a moderator excluded', () => {
  const excluded = {
    reason: 'damaged copy',
    byId: 10,
    at: '2026-11-02T00:00:00Z',
    status: 'preserved',
  };

  it('tells NCMEC only that more content is preserved, and nothing when no file is excluded', async () => {
    await sendEvidenceReport(evidenceDetails());
    expect(submitReport.mock.calls[0][0].additionalInfo ?? '').not.toContain(EXCLUDED_FILES_NOTICE);

    submitReport.mockClear();
    const details = evidenceDetails();
    Object.assign(details.generatedImages[0].blobs[0], { status: 'excluded', excluded });
    await sendEvidenceReport(details);

    const info: string = submitReport.mock.calls[0][0].additionalInfo;
    expect(info.split('\n')).toContain(
      'Civitai has preserved additional content from this account and will provide it on lawful request.'
    );
    expect(info).not.toContain('damaged copy');
  });

  it('is not sent even where another workflow names the same file as preserved', async () => {
    const details = evidenceDetails();
    const [job] = details.generatedImages;
    details.generatedImages.push({
      ...job,
      jobId: '20-20261102000000000000',
      workflowId: '20-20261102000000000000',
      blobs: [{ ...job.blobs[0] }],
    });
    Object.assign(job.blobs[0], { status: 'excluded', excluded });

    await sendEvidenceReport(details);

    expect(submitFileDetails.mock.calls.map(([d]) => d.originalFileName)).toEqual([INPUT]);
  });

  describe('changing or approving a report that is sent or being sent', () => {
    const config = {
      base: 'https://orchestrator.example.invalid',
      origin: 'https://orchestrator.example.invalid',
      token: 'test-token',
    };
    const objects = new Map<string, Buffer>();
    const store: PreserveStore = {
      read: async (key) => new Uint8Array(objects.get(key) ?? Buffer.alloc(0)),
      upload: async (key, body) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk));
        objects.set(key, Buffer.concat(chunks));
      },
      head: async (key) => (objects.has(key) ? { bytes: objects.get(key)!.length } : null),
      sha256: async (key) =>
        createHash('sha256')
          .update(objects.get(key) ?? Buffer.alloc(0))
          .digest('hex'),
    };
    // The send fakes read Prisma's JSON-path filter as plain equality; the report's id is enough here.
    const findById = async ({ where }: { where: Record<string, unknown> }) => {
      const { details: _details, type: _type, ...rest } = where;
      const params: unknown[] = [];
      const { rows } = await db.pg.query(
        `SELECT * FROM "CsamReport" WHERE ${whereSql(rest, params)} LIMIT 1`,
        params
      );
      return rows[0] ?? null;
    };

    async function seedReport(state: 'unsent' | 'sent' | 'claimed', details = evidenceDetails()) {
      const { rows } = await db.pg.query<{ id: number }>(
        `INSERT INTO "CsamReport" ("userId", "reportedById", "type", "details", "reportSentAt", "sendClaimId", "sendClaimedAt")
         VALUES (20, 10, 'GeneratedImage', $1::jsonb, $2, $3, $4) RETURNING id`,
        [
          JSON.stringify(details),
          state === 'sent' ? new Date() : null,
          state === 'claimed' ? '00000000-0000-4000-8000-000000000001' : null,
          state === 'claimed' ? new Date() : null,
        ]
      );
      return rows[0].id;
    }
    const outputStatus = async (id: number) =>
      ((await readRow(id)).details as unknown as ReturnType<typeof evidenceDetails>)
        .generatedImages[0].blobs[0].status;

    beforeEach(() => {
      dbMock.dbWrite.csamReport.findFirst.mockImplementation(findById as never);
      vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith('/v2/consumer/blobs/content/'))
          return new Response(stored, { status: 200, headers: { 'content-type': 'image/png' } });
        return new Response(null, {
          status: 308,
          headers: { location: '/v2/consumer/blobs/content/token' },
        });
      });
    });

    it('changes an unsent, unclaimed report (control)', async () => {
      const id = await seedReport('unsent');
      await excludeGeneratorEvidenceFile({
        reportId: id,
        userId: 20,
        moderatorId: 10,
        blobId: OUTPUT,
        reason: 'damaged copy',
      });
      expect(await outputStatus(id)).toBe('excluded');
    });

    for (const state of ['sent', 'claimed'] as const)
      it(`refuses to exclude or re-copy a file of a ${state} report`, async () => {
        const id = await seedReport(state);
        const file = { reportId: id, userId: 20, moderatorId: 10, blobId: OUTPUT };

        await expect(
          excludeGeneratorEvidenceFile({ ...file, reason: 'damaged copy' })
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(recopyGeneratorEvidenceFile(file, { config, store })).rejects.toMatchObject({
          code: 'CONFLICT',
        });
        expect(await outputStatus(id)).toBe('preserved');
      });

    const unapproved = evidenceDetails({ approved: false });
    const approval = (reportId: number, userId = 20) =>
      approveGeneratorEvidenceReport({
        reportId,
        userId,
        moderatorId: 10,
        version: evidenceVersion(unapproved as never),
      });
    const approvedById = async (id: number) =>
      ((await readRow(id)).details as unknown as ReturnType<typeof evidenceDetails>)
        .generatorEvidence.approvedById;

    it('approves an unsent, unclaimed report (control)', async () => {
      const id = await seedReport('unsent', unapproved);
      await expect(approval(id)).resolves.toEqual({ approved: true });
      expect(await approvedById(id)).toBe(10);
    });

    for (const state of ['sent', 'claimed'] as const)
      it(`refuses to approve a ${state} report`, async () => {
        const id = await seedReport(state, unapproved);
        await expect(approval(id)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await approvedById(id)).toBeUndefined();
      });

    it("refuses to approve another user's report", async () => {
      const id = await seedReport('unsent', unapproved);
      await expect(approval(id, 21)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await approvedById(id)).toBeUndefined();
    });
  });
});

describe('a file one workflow preserved and others could not read', () => {
  it('is sent, and NCMEC is not told it is missing', async () => {
    const details = evidenceDetails();
    const [job] = details.generatedImages;
    const output = job.blobs.find((b) => b.blobId === OUTPUT)!;
    for (const [n, status] of [
      [21, 'unavailable'],
      [22, 'blocked-unreadable'],
    ] as const)
      details.generatedImages.push({
        ...job,
        jobId: `${n}-20261102000000000000`,
        workflowId: `${n}-20261102000000000000`,
        blobs: [{ ...output, status }],
      });

    await sendEvidenceReport(details);

    expect(submitFileDetails.mock.calls.map(([d]) => d.originalFileName)).toContain(OUTPUT);
    // The fixture's own withheld file is the only one counted.
    const info: string = submitReport.mock.calls[0][0].additionalInfo ?? '';
    expect(info).toMatch(/^1 generated file\(s\) were withheld/m);
    expect(info).not.toMatch(/file\(s\) could not be read for this report/);
  });
});

describe('markup characters in what NCMEC is sent', () => {
  const markup = 'cat <lora:x:0.8> & "q" dog';
  const escaped = 'cat &lt;lora:x:0.8&gt; &amp; "q" dog';

  it('sends a prompt, negative prompt and resources holding markup, escaped once', async () => {
    const details = evidenceDetails();
    Object.assign(details.generatedImages[0], {
      prompt: markup,
      negativePrompt: markup,
      resources: [markup],
    });

    const id = await sendEvidenceReport(details);

    expect((await readRow(id)).reportSentAt).not.toBeNull();
    expect(detailsFor(OUTPUT).details[0].valuePair.map((p: { value: string }) => p.value)).toEqual([
      escaped,
      escaped,
      escaped,
    ]);
    expect(detailsFor(OUTPUT).additionalInfo[1]).toBe(
      [`Prompt: ${escaped}`, `Negative prompt: ${escaped}`, `Resources: ${escaped}`].join('\n')
    );
  });

  it('counts a line against the limit before escaping', async () => {
    const details = evidenceDetails();
    details.generatedImages[0].prompt = '&'.repeat(MAX_GENERATION_LINE_CHARS - 'Prompt: '.length);

    await sendEvidenceReport(details);

    const [promptLine] = detailsFor(OUTPUT).additionalInfo[1].split('\n');
    expect(promptLine).not.toContain(TRUNCATION_MARKER);
    expect(promptLine).toBe(`Prompt: ${'&amp;'.repeat(MAX_GENERATION_LINE_CHARS - 8)}`);
  });

  it('sends a report whose moderator name and reported username hold markup', async () => {
    dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
      where.id === 10
        ? { id: 10, email: 'mod@example.invalid', name: 'Mod & <Co>', isModerator: true }
        : { id: 20, email: 'user@example.invalid', name: 'User', username: '<user>' }
    );

    const id = await sendEvidenceReport(evidenceDetails());

    expect((await readRow(id)).reportSentAt).not.toBeNull();
    const [report] = submitReport.mock.calls[0];
    expect(report.reporter.reportingPerson.firstName).toBe('Mod &amp; &lt;Co&gt;');
    expect(report.personOrUserReported.screenName).toBe('&lt;user&gt;');
  });

  it("opens no CyberTip when one file's details would not be well-formed XML", async () => {
    const actual = evidenceFileDetails.getMockImplementation()!;
    evidenceFileDetails.mockImplementationOnce((...args: Parameters<typeof actual>) => ({
      ...actual(...args),
      originalFileName: 'unescaped & name',
    }));

    const id = await sendEvidenceReport(evidenceDetails());

    expect(submitReport).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect((await readRow(id)).reportSentAt).toBeNull();
  });

  it('opens no CyberTip when any part of it would not be well-formed XML', async () => {
    const details = {
      ...evidenceDetails(),
      userActivity: [{ type: 'Login', ip: '192.0.2.1 & more', time: '2026-11-01 00:00:00' }],
    };

    const id = await sendEvidenceReport(details);

    expect(submitReport).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect((await readRow(id)).reportSentAt).toBeNull();
  });
});

describe('an open whose answer cannot be read', () => {
  // What the client throws for a 2xx answer whose reportId is not a whole number.
  const unreadable = () =>
    submitReport.mockRejectedValue(new Error('Response "reportId" must be a number, got: string'));
  const linesOf = (subType: string, id: number) =>
    loggingMock.logToAxiom.mock.calls
      .map(([line]) => line as { subType?: string; reportId?: number })
      .filter((line) => line.subType === subType && line.reportId === id);

  it('opens exactly once over three runs, and holds the report for a decision', async () => {
    loggingMock.logToAxiom.mockClear();
    unreadable();

    const id = await sendEvidenceReport(evidenceDetails());
    await processCsamReport(await readRow(id));
    await processCsamReport(await readRow(id));

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
    const row = await readRow(id);
    expect(row.reportSentAt).toBeNull();
    expect(row.details.unconfirmedOpens).toHaveLength(1);
    expect(linesOf('send-open-unconfirmed', id)).toHaveLength(1);
    expect(linesOf('send-decision-needed', id)).toHaveLength(3);
  });

  it('sends again once a moderator clears it, recording who and why', async () => {
    unreadable();
    const id = await sendEvidenceReport(evidenceDetails());
    submitReport.mockReset().mockResolvedValue({ data: { reportId: 900 } });

    await clearUnconfirmedOpens({ reportId: id, moderatorId: 10, note: 'checked with NCMEC' });
    await processCsamReport(await readRow(id));

    expect(submitReport).toHaveBeenCalledTimes(1);
    const row = await readRow(id);
    expect(row.reportSentAt).not.toBeNull();
    expect(row.details.unconfirmedOpens).toBeUndefined();
    expect(row.details.clearedUnconfirmedOpens).toMatchObject([
      { clearedById: 10, note: 'checked with NCMEC' },
    ]);
    const { rows: activity } = await db.pg.query(
      `SELECT "userId", "entityType", activity FROM "ModActivity" WHERE "entityId" = $1`,
      [id]
    );
    expect(activity).toEqual([
      { userId: 10, entityType: 'csamReport', activity: 'csamReport:clearUnconfirmedOpen' },
    ]);
  });

  it('holds the report even when the run lost its claim during the open', async () => {
    const id = await insertEvidenceReport(evidenceDetails());
    views = viewsOf(id);
    // Another run takes the report while this one waits on NCMEC, then its claim expires.
    submitReport.mockImplementation(async () => {
      await db.pg.query(
        `UPDATE "CsamReport" SET "sendClaimId" = '00000000-0000-4000-8000-000000000002', "sendClaimedAt" = $2 WHERE id = $1`,
        [id, new Date(Date.now() - 6 * 3_600_000)]
      );
      throw new Error('Response "reportId" must be a number, got: string');
    });

    await processCsamReport(await readRow(id));
    await processCsamReport(await readRow(id));

    expect(submitReport).toHaveBeenCalledTimes(1);
    expect((await readRow(id)).details.unconfirmedOpens).toHaveLength(1);
  });

  const heldWithClaim = async (claimedHoursAgo: number) => {
    const id = await insertEvidenceReport({
      ...evidenceDetails(),
      unconfirmedOpens: [{ at: '2026-11-03T00:00:00Z', message: 'unreadable' }],
    });
    await db.pg.query(
      `UPDATE "CsamReport" SET "sendClaimId" = '00000000-0000-4000-8000-000000000003', "sendClaimedAt" = $2 WHERE id = $1`,
      [id, new Date(Date.now() - claimedHoursAgo * 3_600_000)]
    );
    return id;
  };

  it('refuses to clear while a send run holds the report', async () => {
    const id = await heldWithClaim(0);

    await expect(
      clearUnconfirmedOpens({ reportId: id, moderatorId: 10, note: 'checked with NCMEC' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await readRow(id)).details.unconfirmedOpens).toHaveLength(1);
  });

  it('takes the report from a run whose claim expired, so nothing it writes lands after the clear', async () => {
    const id = await heldWithClaim(6);

    await clearUnconfirmedOpens({ reportId: id, moderatorId: 10, note: 'checked with NCMEC' });

    const row = await readRow(id);
    expect(row.details.unconfirmedOpens).toBeUndefined();
    expect(row.sendClaimId).toBeNull();
  });

  it('refuses to clear a report that is not held', async () => {
    const id = await insertEvidenceReport(evidenceDetails());

    await expect(
      clearUnconfirmedOpens({ reportId: id, moderatorId: 10, note: 'checked with NCMEC' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('still lets a refusal or an outage fail the run, to be retried', async () => {
    submitReport.mockRejectedValue(
      new Error('Request failed with http status 500 (Request-ID: x)')
    );

    const id = await insertEvidenceReport(evidenceDetails());
    views = viewsOf(id);

    await expect(processCsamReport(await readRow(id))).rejects.toThrow('http status 500');
    expect((await readRow(id)).details.unconfirmedOpens).toBeUndefined();
  });
});

import { S3Client } from '@aws-sdk/client-s3';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import fsAsync from 'fs/promises';
import JSZip from 'jszip';
import type { Readable } from 'stream';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `fileViewedByEsp` per file, from the `heldMedia:view` rows written before the CyberTip is opened.
 * The view lookup runs against a Postgres stand-in holding ModActivity. All ids and bytes below are
 * invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// `isProd: true` makes `NEXT_PUBLIC_CIVITAI_LINK` required at module scope; a local `.env` hides
// that, CI does not.
await vi.hoisted(async () => {
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
});

const {
  submitReport,
  uploadFile,
  submitFileDetails,
  finishReport,
  cancelReport,
  getObject,
  csamBucketObject,
  fetchBlobAsFile,
  getFileForModelVersion,
} = vi.hoisted(() => ({
  submitReport: vi.fn(),
  uploadFile: vi.fn(),
  submitFileDetails: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
  csamBucketObject: vi.fn(),
  fetchBlobAsFile: vi.fn(),
  getFileForModelVersion: vi.fn(),
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
    s3: {
      send: (command: { constructor: { name: string }; input: { Key: string } }) =>
        command.constructor.name === 'HeadObjectCommand'
          ? getObject(command.input.Key).then((object: { ContentLength: number }) => ({
              ContentLength: object.ContentLength,
              ContentType: 'image/png',
            }))
          : getObject(command.input.Key),
    },
  }),
}));

vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBlobAsFile,
}));

vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFileForModelVersion,
}));

import type { CsamReportProps } from '~/server/services/csam.service-new';
import { processCsamReport as processClaimedReport } from '~/server/services/csam.service-new';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

const stored = Buffer.from('the bytes the user uploaded');
const db = { pg: null as unknown as PGlite };

// Prisma's tagged template as a parameterised query.
const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (await db.pg.query(strings.map((part, i) => (i ? `$${i}` : '') + part).join(''), values)).rows;

const view = (
  entityId: number,
  {
    activity = 'reportMedia:select:original',
    entityType = 'image',
    // PGlite's clock ticks in whole milliseconds, so a row stamped "now" often equals the send's cutoff.
    createdAt = `CURRENT_TIMESTAMP - interval '1 second'`,
  } = {}
) =>
  db.pg.query(
    `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId", "createdAt")
     VALUES (10, $1, $2, $3, ${createdAt})`,
    [entityType, activity, entityId]
  );

const imageRow = (id: number) => ({
  id,
  url: `stored-key-${id}`,
  name: `upload-${id}.png`,
  type: 'image',
  mimeType: 'image/png',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  meta: {},
  post: null,
  tags: [],
});

const imageReport = (ids: number[]) =>
  ({
    id: 1,
    userId: 20,
    reportedById: 10,
    type: 'Image',
    createdAt: new Date(Date.now() - 3_600_000),
    reportSentAt: null,
    images: ids.map((id) => ({ id })),
    details: {},
  } as unknown as CsamReportProps);

// The send claims the report and works from the row it re-reads: here, the report passed in.
let filed: CsamReportProps | undefined;
const processCsamReport = (report: CsamReportProps) => {
  filed = report;
  return processClaimedReport(report);
};

/** `fileViewedByEsp` as sent, by the file's name. */
const viewedByName = () =>
  Object.fromEntries(
    submitFileDetails.mock.calls.map(([details]) => [
      details.originalFileName,
      'fileViewedByEsp' in details ? details.fileViewedByEsp : 'unset',
    ])
  );
const sentImages = () =>
  dbMock.dbWrite.csamReport.updateMany.mock.calls
    .map(([args]) => args.data)
    .find((data) => data.reportSentAt)?.details?.images ??
  dbMock.dbWrite.csamReport.updateMany.mock.calls
    .map(([args]) => args.data)
    .find((data) => data.reportSentAt)?.images;
const lines = (subType: string) =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((line) => line.subType === subType);

async function zipOf(names: string[]) {
  const zip = new JSZip();
  for (const name of names) zip.file(name, stored);
  return zip.generateAsync({ type: 'nodebuffer' });
}

beforeAll(async () => {
  // A zone-less timestamp reads back as UTC, as Prisma reads it.
  db.pg = new PGlite({
    parsers: { 1114: (value: string) => new Date(`${value.replace(' ', 'T')}Z`) },
  });
  // Production's shape: append-only, no unique index.
  await db.pg.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "activity" TEXT NOT NULL,
      "entityType" TEXT,
      "entityId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "host" TEXT
    );
    CREATE INDEX ON "ModActivity" ("entityType", "entityId", "createdAt");
  `);
});

beforeEach(async () => {
  await db.pg.exec(`TRUNCATE "ModActivity"`);
  vi.mocked(logToAxiom).mockClear();
  submitReport.mockReset().mockResolvedValue({ data: { reportId: 99 } });
  uploadFile.mockReset().mockResolvedValue({ data: { fileId: 'file-1', hash: 'ncmec-md5' } });
  submitFileDetails.mockReset().mockResolvedValue({});
  finishReport.mockReset();
  cancelReport.mockReset().mockResolvedValue({ data: { responseCode: 0 } });
  getObject.mockReset().mockImplementation(async () => ({
    Body: { transformToByteArray: async () => new Uint8Array(stored) },
    ContentType: 'image/png',
    ContentLength: stored.length,
  }));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network fetch'));
  dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === 10
      ? { id: 10, email: 'mod@example.invalid', name: 'Mod', isModerator: true }
      : { id: 20, email: 'user@example.invalid', name: 'User', username: 'user' }
  );
  dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501), imageRow(502)]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
  dbMock.dbWrite.csamReport.updateMany.mockReset().mockResolvedValue({ count: 1 });
  dbMock.dbWrite.csamReport.findFirst.mockReset().mockImplementation(async () => filed);
  dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(queryRaw as never);
});

describe('image report: fileViewedByEsp per file', () => {
  it('is false for a file with no view record', async () => {
    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': false, 'upload-502.png': false });
  });

  it('is true for a file viewed before the send, and only for that file', async () => {
    await view(501);

    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': true, 'upload-502.png': false });
  });

  it.each([
    'reportMedia:open:original',
    'reportMedia:open:cdn-450',
    'reportMedia:select:original',
    'reportMedia:select:cdn-450',
  ])('counts a %s row', async (activity) => {
    await view(501, { activity });

    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': true, 'upload-502.png': false });
  });

  it('stores what was sent for each file, and the rendition of its earliest record', async () => {
    await view(501, {
      activity: 'reportMedia:select:cdn-450',
      createdAt: `CURRENT_TIMESTAMP - interval '2 minutes'`,
    });
    await view(501, {
      activity: 'reportMedia:open:original',
      createdAt: `CURRENT_TIMESTAMP - interval '1 minute'`,
    });
    await view(502, { activity: 'reportMedia:open:original' });
    await view(503, { activity: 'heldMedia:view' });
    dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501), imageRow(502), imageRow(503)]);

    await processCsamReport(imageReport([501, 502, 503]));

    const images = sentImages() as { id: number; viewedByEsp?: boolean; viewRendition?: string }[];
    expect(
      images.map(({ id, viewedByEsp, viewRendition }) => ({ id, viewedByEsp, viewRendition }))
    ).toEqual([
      { id: 501, viewedByEsp: true, viewRendition: 'cdn-450' },
      { id: 502, viewedByEsp: true, viewRendition: 'original' },
      { id: 503, viewedByEsp: false, viewRendition: undefined },
    ]);
  });

  it('is false for a file whose only record is that it was served', async () => {
    await view(501, { activity: 'heldMedia:view' });
    await view(501, {
      activity: 'heldMedia:view',
      createdAt: `CURRENT_TIMESTAMP - interval '1 day'`,
    });

    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': false, 'upload-502.png': false });
  });

  it('counts no record that only resembles one', async () => {
    await view(501, { activity: 'reportMedia:hover:original' });
    await view(502, { activity: 'reportMedia:select:cdn-1080' });

    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': false, 'upload-502.png': false });
  });

  it('is false for a view recorded after the CyberTip is opened', async () => {
    submitReport.mockImplementation(async () => {
      await view(501);
      return { data: { reportId: 99 } };
    });

    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': false, 'upload-502.png': false });
  });

  it('is false for a view stamped later than the send', async () => {
    await view(501, { createdAt: `CURRENT_TIMESTAMP + interval '1 hour'` });

    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': false, 'upload-502.png': false });
  });

  it('reads a UTC-stamped view in a session with another time zone', async () => {
    await view(501, { createdAt: `(now() AT TIME ZONE 'UTC') - interval '1 minute'` });
    await db.pg.exec(`SET TIME ZONE 'America/Denver'`);
    try {
      await processCsamReport(imageReport([501, 502]));
    } finally {
      await db.pg.exec(`SET TIME ZONE 'UTC'`);
    }

    expect(viewedByName()).toEqual({ 'upload-501.png': true, 'upload-502.png': false });
  });

  it('counts no view of another kind of entity with the same id', async () => {
    await view(501, { entityType: 'modelVersion' });

    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': false, 'upload-502.png': false });
  });

  it("reads the views of the report's own images only", async () => {
    await view(501);
    await view(900);
    await view(901, { activity: 'reportMedia:open:cdn-450' });

    await processCsamReport(imageReport([501, 502]));

    const { calls, results } = dbMock.dbWrite.$queryRaw.mock;
    const lookups = calls.flatMap(([strings], i) =>
      (strings as TemplateStringsArray).join('').includes('"ModActivity"') ? [results[i].value] : []
    );
    expect(lookups).toHaveLength(1);
    expect((await lookups[0]).map((row: { entityId: number }) => row.entityId)).toEqual([501]);
  });

  it('counts no other record for the same id', async () => {
    await view(501, { activity: 'heldMedia:grid', entityType: 'heldMediaGrid' });
    await view(502, { activity: 'trainingData:download', entityType: 'modelVersion' });
    await view(502, { activity: 'review' });

    await processCsamReport(imageReport([501, 502]));

    expect(viewedByName()).toEqual({ 'upload-501.png': false, 'upload-502.png': false });
  });

  it('opens no CyberTip and raises a send failure when the view lookup fails', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('synthetic replica outage'));

    await processCsamReport(imageReport([501, 502]));

    expect(submitReport).not.toHaveBeenCalled();
    expect(submitFileDetails).not.toHaveBeenCalled();
    expect(lines('send-view-check')).toEqual([
      expect.objectContaining({
        type: 'error',
        reportId: 1,
        message: 'synthetic replica outage',
      }),
    ]);
  });
});

describe('zip and generated files: fileViewedByEsp is false', () => {
  it('sends every external evidence and supplemental file as not viewed', async () => {
    // A view row for every numeric id an entry could be mistaken for.
    for (const id of [0, 1, 2, 501]) await view(id);
    const evidence = await zipOf(['a.png', 'b.png']);
    const supplemental = await zipOf(['chat.png']);
    // The CSAM bucket's client, which reads the evidence zips.
    Object.assign(env, {
      CSAM_UPLOAD_KEY: 'key',
      CSAM_UPLOAD_SECRET: 'secret',
      CSAM_UPLOAD_REGION: 'region',
      CSAM_UPLOAD_ENDPOINT: 'https://csam-bucket.example.invalid',
      CSAM_BUCKET_NAME: 'csam-bucket',
    });
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: {
      input: { Key: string };
    }) => csamBucketObject(command.input.Key)) as never);
    csamBucketObject.mockImplementation(async (key: string) => ({
      Body: {
        transformToByteArray: async () =>
          new Uint8Array(key === 'evidence-key' ? evidence : supplemental),
      },
    }));
    const report = {
      ...imageReport([]),
      type: 'ExternalLink',
      details: {
        email: 'x@example.invalid',
        evidence: { bucketKey: 'evidence-key' },
        supplementalEvidence: { bucketKey: 'supplemental-key' },
      },
    } as unknown as CsamReportProps;

    await processCsamReport(report);

    expect(viewedByName()).toEqual({ 'a.png': false, 'b.png': false, 'chat.png': false });
  });

  it('sends every training data file as not viewed', async () => {
    const zip = await zipOf(['a.png', 'b.png']);
    getFileForModelVersion.mockResolvedValue({
      status: 'success',
      url: 'https://example.invalid/td.zip',
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(new Uint8Array(zip)));
    // The zip passes through the job's disk; here, through memory.
    let written = Buffer.alloc(0);
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'rmSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fsAsync, 'writeFile').mockImplementation(async (_, data) => {
      const chunks: Buffer[] = [];
      for await (const chunk of data as Readable) chunks.push(Buffer.from(chunk));
      written = Buffer.concat(chunks);
    });
    vi.spyOn(fs, 'readFile').mockImplementation(((
      _: unknown,
      done: (e: Error | null, data: Buffer) => void
    ) => done(null, written)) as never);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([{ id: 7, model: { id: 3 } }]);
    const report = {
      ...imageReport([]),
      type: 'TrainingData',
      details: { modelVersionIds: [7] },
    } as unknown as CsamReportProps;

    await processCsamReport(report);

    expect(viewedByName()).toEqual({ 'a.png': false, 'b.png': false });
  });

  it('sends every generated file as not viewed', async () => {
    fetchBlobAsFile.mockResolvedValue(new File(['generated'], 'generated.png'));
    const report = {
      ...imageReport([]),
      type: 'GeneratedImage',
      details: { generatedImages: [{ jobId: 'job-1', blobs: [{ url: 'blob-1' }] }] },
    } as unknown as CsamReportProps;

    await processCsamReport(report);

    expect(submitFileDetails).toHaveBeenCalledTimes(1);
    expect(submitFileDetails.mock.calls[0][0]).toHaveProperty('fileViewedByEsp', false);
  });
});

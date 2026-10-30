import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Sending a supplemental report: what it tells NCMEC, and that it opens no CyberTip with a file no
 * reviewer was shown. The view lookup runs against a Postgres stand-in holding ModActivity. All ids
 * and bytes below are invented.
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
  fetchBlobAsFile,
  getFileForModelVersion,
} = vi.hoisted(() => ({
  submitReport: vi.fn(),
  uploadFile: vi.fn(),
  submitFileDetails: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
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
    // The report's filer.
    userId = 10,
    // PGlite's clock ticks in whole milliseconds, so a row stamped "now" often equals the send's cutoff.
    createdAt = `CURRENT_TIMESTAMP - interval '1 second'`,
  } = {}
) =>
  db.pg.query(
    `INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId", "createdAt")
     VALUES ($4, $1, $2, $3, ${createdAt})`,
    [entityType, activity, entityId, userId]
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
const lines = (subType: string) =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((line) => line.subType === subType);

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

const supplementalReport = (ids: number[], unreviewedImageIds: number[]) =>
  ({
    ...imageReport(ids),
    details: {
      supplemental: { priorCsamReportId: 7, priorReportNumbers: [900, 905], unreviewedImageIds },
    },
  } as unknown as CsamReportProps);

const sentTip = () => submitReport.mock.calls[0]?.[0];

describe('a supplemental image report', () => {
  it('refers to every earlier report on the user', async () => {
    await view(501);
    await view(502);

    await processCsamReport(supplementalReport([501, 502], []));

    expect(sentTip().personOrUserReported.priorCTReports).toEqual([900, 905]);
  });

  it.each([
    [0, 'A Civitai reviewer confirmed the attached image(s).'],
    [
      1,
      'A Civitai reviewer confirmed the attached image(s). The account has 1 further image that was flagged for review and not individually reviewed. It is preserved and available in response to legal process.',
    ],
    [
      7,
      'A Civitai reviewer confirmed the attached image(s). The account has 7 further images that were flagged for review and not individually reviewed. They are preserved and available in response to legal process.',
    ],
  ])('tells NCMEC about %i unreviewed image(s) in exactly the agreed words', async (n, text) => {
    await view(501);
    await view(502);

    await processCsamReport(
      supplementalReport(
        [501, 502],
        Array.from({ length: n }, (_, i) => 600 + i)
      )
    );

    expect(sentTip().additionalInfo).toBe(text);
    expect(viewedByName()).toEqual({ 'upload-501.png': true, 'upload-502.png': true });
  });

  it('opens no CyberTip while one of its files has no view record', async () => {
    await view(501);

    await processCsamReport(supplementalReport([501, 502], [600]));

    expect(submitReport).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(lines('supplemental-unviewed')).toHaveLength(1);
  });

  it('leaves an ordinary report as it was: no earlier reports and no added text', async () => {
    await view(501);

    await processCsamReport(imageReport([501, 502]));

    expect(sentTip().personOrUserReported).not.toHaveProperty('priorCTReports');
    expect(sentTip()).not.toHaveProperty('additionalInfo');
    expect(viewedByName()).toEqual({ 'upload-501.png': true, 'upload-502.png': false });
  });
});

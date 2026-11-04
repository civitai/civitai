import { S3Client } from '@aws-sdk/client-s3';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import fsAsync from 'fs/promises';
import JSZip from 'jszip';
import type { Readable } from 'stream';
import { Parser } from 'xml2js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CybertiplineTools from '@civitai/cybertipline-tools';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as NcmecXml from '~/server/services/ncmec-xml';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Every send path, against an NCMEC that refuses XML that is not well-formed: free text is escaped
 * before it is sent, and XML NCMEC would refuse opens no CyberTip. All ids, names and bytes below are
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
  cyberTipXmlProblem,
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
  cyberTipXmlProblem: vi.fn(),
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

// The real check, watched: what it was given is what was checked before the CyberTip opened.
vi.mock('~/server/services/ncmec-xml', async (importOriginal) => {
  const actual = await importOriginal<typeof NcmecXml>();
  cyberTipXmlProblem.mockImplementation(actual.cyberTipXmlProblem);
  return { ...actual, cyberTipXmlProblem };
});

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

import { buildReport, buildSubmitFileDetails } from '@civitai/cybertipline-tools';
import type { CsamReportProps } from '~/server/services/csam.service-new';
import { processCsamReport as processClaimedReport } from '~/server/services/csam.service-new';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';

const stored = Buffer.from('the bytes the user uploaded');
const db = { pg: null as unknown as PGlite };

const markup = 'a <b> & c';
const escaped = 'a &lt;b&gt; &amp; c';

/** As NCMEC answers: XML that is not well-formed is refused. */
function refuseIllFormed(xml: string) {
  if (/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(xml))
    throw new Error('synthetic NCMEC refusal: a character outside XML');
  new Parser({ strict: true, async: false }).parseString(xml, (e: Error | null) => {
    if (e) throw new Error(`synthetic NCMEC refusal: ${e.message}`);
  });
}

const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) =>
  (await db.pg.query(strings.map((part, i) => (i ? `$${i}` : '') + part).join(''), values)).rows;

const imageRow = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  url: `stored-key-${id}`,
  name: `upload-${id}.png`,
  type: 'image',
  mimeType: 'image/png',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  meta: {},
  post: null,
  tags: [],
  ...overrides,
});

const report = (type: string, details: Record<string, unknown>, images: { id: number }[] = []) =>
  ({
    id: 1,
    userId: 20,
    reportedById: 10,
    type,
    createdAt: new Date(Date.now() - 3_600_000),
    reportSentAt: null,
    images,
    details,
  } as unknown as CsamReportProps);

// The send claims the report and works from the row it re-reads: here, the report passed in.
let filed: CsamReportProps | undefined;
const processCsamReport = (report: CsamReportProps) => {
  filed = report;
  return processClaimedReport(report);
};

const markedSent = () =>
  dbMock.dbWrite.csamReport.updateMany.mock.calls.some(([args]) => args.data?.reportSentAt);
const lines = (subType: string) =>
  vi
    .mocked(logToAxiom)
    .mock.calls.map(([payload]) => payload as Record<string, unknown>)
    .filter((line) => line.subType === subType);
const fileDetailsSent = () => submitFileDetails.mock.calls.map(([details]) => details);
/** Each file's details as sent, but for the ids, were among those checked before the CyberTip opened. */
function expectSentDetailsChecked() {
  const checked = cyberTipXmlProblem.mock.calls.flatMap(([, fileDetails]) => fileDetails);
  const sent = fileDetailsSent().map(({ reportId, fileId, ...details }) => details);
  expect(sent.length).toBeGreaterThan(0);
  expect(checked).toEqual(expect.arrayContaining(sent));
  expect(checked).toHaveLength(sent.length);
}

async function zipOf(names: string[]) {
  const zip = new JSZip();
  for (const name of names) zip.file(name, stored);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function serveCsamBucket(zips: Record<string, Buffer>) {
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
    Body: { transformToByteArray: async () => new Uint8Array(zips[key]) },
  }));
}

function serveTrainingData(zip: Buffer) {
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
}

beforeAll(async () => {
  db.pg = new PGlite({
    parsers: { 1114: (value: string) => new Date(`${value.replace(' ', 'T')}Z`) },
  });
  await db.pg.exec(`
    CREATE TABLE "ModActivity" (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER,
      "activity" TEXT NOT NULL,
      "entityType" TEXT,
      "entityId" INTEGER,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
});

beforeEach(() => {
  vi.mocked(logToAxiom).mockClear();
  cyberTipXmlProblem.mockClear();
  submitReport.mockReset().mockImplementation(async (report) => {
    refuseIllFormed(buildReport(report));
    return { data: { reportId: 99 } };
  });
  uploadFile.mockReset().mockResolvedValue({ data: { fileId: 'file-1', hash: 'ncmec-md5' } });
  submitFileDetails.mockReset().mockImplementation(async (details) => {
    refuseIllFormed(buildSubmitFileDetails(details));
    return { data: { responseCode: 0 } };
  });
  finishReport.mockReset();
  cancelReport.mockReset().mockResolvedValue({ data: { responseCode: 0 } });
  getObject.mockReset().mockImplementation(async () => ({
    Body: { transformToByteArray: async () => new Uint8Array(stored) },
    ContentType: 'image/png',
    ContentLength: stored.length,
  }));
  fetchBlobAsFile.mockReset().mockResolvedValue(new File(['generated'], 'generated.png'));
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network fetch'));
  dbMock.dbRead.user.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === 10
      ? { id: 10, email: 'mod@example.invalid', name: 'Mod', isModerator: true }
      : { id: 20, email: 'user@example.invalid', name: 'User', username: 'user' }
  );
  dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501)]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
  dbMock.dbWrite.csamReport.updateMany.mockReset().mockResolvedValue({ count: 1 });
  dbMock.dbWrite.csamReport.findFirst.mockReset().mockImplementation(async () => filed);
  dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(queryRaw as never);
});

describe('an external report holding markup in every field a moderator fills in', () => {
  beforeEach(async () => {
    serveCsamBucket({
      'evidence-key': await zipOf([`evidence ${markup}.png`]),
      'supplemental-key': await zipOf([`chat ${markup}.png`]),
    });
    dbMock.dbRead.user.findUnique.mockImplementation(async () => ({
      id: 10,
      email: 'mod&1@example.invalid',
      name: `Mod ${markup}`,
      isModerator: true,
    }));
  });

  const external = () =>
    report('ExternalLink', {
      email: 'x&y@example.invalid',
      screenName: `screen ${markup}`,
      reportedName: `name ${markup}`,
      profileUrls: ['https://example.invalid/u?a=1&b=2'],
      secondaryUserId: 30,
      secondaryEmail: 'second&z@example.invalid',
      externalUrls: ['https://example.invalid/p?a=1&b=2'],
      chatPlatform: `platform ${markup}`,
      chatLogs: `logs ${markup}`,
      additionalInfo: `notes ${markup}`,
      evidence: { bucketKey: 'evidence-key', filename: 'evidence.zip' },
      supplementalEvidence: { bucketKey: 'supplemental-key', filename: 'chat.zip' },
    });

  it('is sent, every file with it', async () => {
    await processCsamReport(external());

    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(finishReport).toHaveBeenCalledTimes(1);
    expect(markedSent()).toBe(true);
    expectSentDetailsChecked();
  });

  it('carries each field escaped once', async () => {
    await processCsamReport(external());

    const [sent] = submitReport.mock.calls[0];
    expect(sent.reporter.reportingPerson).toEqual({
      email: [{ email: 'mod&amp;1@example.invalid' }],
      firstName: `Mod ${escaped}`,
    });
    expect(sent.personOrUserReported).toMatchObject({
      screenName: `screen ${escaped}`,
      personOrUserReportedPerson: {
        firstName: `name ${escaped}`,
        email: [{ email: 'x&amp;y@example.invalid' }],
      },
      profileUrl: ['https://example.invalid/u?a=1&amp;b=2'],
    });
    expect(sent.personOrUserReported.additionalInfo).toContain('second&amp;z@example.invalid');
    expect(sent.incidentDetails).toEqual({
      webPageIncidents: [
        { url: ['https://example.invalid/p?a=1&amp;b=2'], thirdPartyHostedContent: true },
      ],
      chatImIncidents: [{ chatClient: `platform ${escaped}`, content: `logs ${escaped}` }],
    });
    expect(sent.additionalInfo).toContain(`notes ${escaped}`);
    expect(
      fileDetailsSent().map(({ originalFileName, locationOfFile }) => ({
        originalFileName,
        locationOfFile,
      }))
    ).toEqual([
      {
        originalFileName: `evidence ${escaped}.png`,
        locationOfFile: 'https://example.invalid/p?a=1&amp;b=2',
      },
      { originalFileName: `chat ${escaped}.png`, locationOfFile: undefined },
    ]);
  });

  it('opens no CyberTip when its evidence cannot be read', async () => {
    csamBucketObject.mockRejectedValue(new Error('synthetic bucket failure'));

    await processCsamReport(external());

    expect(submitReport).not.toHaveBeenCalled();
    expect(lines('archive-data')).toHaveLength(1);
  });
});

describe('a file name and location holding markup', () => {
  it('is sent escaped on an image report', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([
      imageRow(501, { name: `photo ${markup}.png?x=1`, url: 'stored-key&501' }),
    ]);

    await processCsamReport(report('Image', {}, [{ id: 501 }]));

    expect(markedSent()).toBe(true);
    expect(fileDetailsSent()).toEqual([
      expect.objectContaining({
        originalFileName: `photo ${escaped}.png`,
        locationOfFile: expect.stringContaining('stored-key&amp;501'),
      }),
    ]);
    expectSentDetailsChecked();
  });

  it('is sent escaped on a training data report', async () => {
    serveTrainingData(await zipOf([`td ${markup}.png`]));

    await processCsamReport(report('TrainingData', { modelVersionIds: [7] }));

    expect(markedSent()).toBe(true);
    expect(fileDetailsSent()).toEqual([
      expect.objectContaining({ originalFileName: `td ${escaped}.png` }),
    ]);
    expectSentDetailsChecked();
  });
});

describe('a generated-image report fetched by URL', () => {
  it("has each file's details checked before the CyberTip opens", async () => {
    await processCsamReport(
      report('GeneratedImage', {
        generatedImages: [{ jobId: 'job-1', blobs: [{ url: 'blob-1' }] }],
      })
    );

    expect(markedSent()).toBe(true);
    expectSentDetailsChecked();
  });
});

describe('XML NCMEC would refuse', () => {
  // An address stored on the report goes into the CyberTip as stored.
  const userActivity = [{ type: 'Login', ip: '192.0.2.1 & more', time: '2026-11-01 00:00:00' }];

  it.each([
    ['an image report', () => report('Image', { userActivity }, [{ id: 501 }])],
    [
      'a generated-image report',
      () =>
        report('GeneratedImage', {
          userActivity,
          generatedImages: [{ jobId: 'job-1', blobs: [{ url: 'blob-1' }] }],
        }),
    ],
  ])('opens no CyberTip for %s, and asks for a decision on the first run', async (_, filing) => {
    await processCsamReport(filing());

    expect(submitReport).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(markedSent()).toBe(false);
    expect(lines('send-xml')).toEqual([
      expect.objectContaining({ type: 'error', reportId: 1, hoursPending: 1 }),
    ]);
    expect(lines('send-decision-needed')).toEqual([
      expect.objectContaining({
        type: 'error',
        reportId: 1,
        message: expect.stringContaining('would not be well-formed XML'),
      }),
    ]);
  });

  it('opens no CyberTip for a training data report', async () => {
    serveTrainingData(await zipOf(['td.png']));

    await processCsamReport(report('TrainingData', { userActivity, modelVersionIds: [7] }));

    expect(submitReport).not.toHaveBeenCalled();
    expect(lines('send-decision-needed')).toHaveLength(1);
  });

  it('names a CyberTip an earlier run left open, so whoever decides can cancel it', async () => {
    await processCsamReport({
      ...report('Image', { userActivity }, [{ id: 501 }]),
      reportId: 4242,
    } as CsamReportProps);

    expect(cancelReport).not.toHaveBeenCalled();
    expect(lines('send-decision-needed')).toEqual([
      expect.objectContaining({ ncmecReportId: 4242 }),
    ]);
  });
});

import { S3Client } from '@aws-sdk/client-s3';
import { PGlite } from '@electric-sql/pglite';
import JSZip from 'jszip';
import { Readable } from 'stream';
import { Parser } from 'xml2js';
import { crc32 } from 'zlib';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  generatedFile,
  getFileForModelVersion,
  cyberTipXmlProblem,
  spoolCap,
} = vi.hoisted(() => ({
  submitReport: vi.fn(),
  uploadFile: vi.fn(),
  submitFileDetails: vi.fn(),
  finishReport: vi.fn(),
  cancelReport: vi.fn(),
  getObject: vi.fn(),
  csamBucketObject: vi.fn(),
  generatedFile: vi.fn(),
  getFileForModelVersion: vi.fn(),
  cyberTipXmlProblem: vi.fn(),
  // The bytes one report's send may write to disk, when a test sets it.
  spoolCap: { bytes: undefined as number | undefined },
}));

vi.mock('~/server/services/csam-evidence-spool', async (importOriginal) => {
  const actual = await importOriginal<typeof EvidenceSpool>();
  return {
    ...actual,
    spoolBudget: (...caps: Parameters<typeof actual.spoolBudget>) =>
      spoolCap.bytes === undefined
        ? actual.spoolBudget(...caps)
        : actual.spoolBudget(spoolCap.bytes),
  };
});

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

vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFileForModelVersion,
}));

import { buildReport, buildSubmitFileDetails } from '@civitai/cybertipline-tools';
import type * as EvidenceSpool from '~/server/services/csam-evidence-spool';
import { MAX_SPOOL_FILE_BYTES } from '~/server/services/csam-evidence-spool';
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
    Body: Object.assign(Readable.from([Buffer.from(zips[key])]), {
      transformToByteArray: async () => new Uint8Array(zips[key]),
    }),
  }));
}

function serveTrainingData(zip: Buffer) {
  getFileForModelVersion.mockResolvedValue({
    status: 'success',
    url: 'https://example.invalid/td.zip',
  });
  vi.mocked(globalThis.fetch).mockResolvedValue(new Response(new Uint8Array(zip)));
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
  generatedFile.mockReset().mockResolvedValue(new File(['generated'], 'generated.png'));
  // Each generated-image URL answers with `generatedFile`'s file, or an error response for null.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const file = await generatedFile(String(input));
    return file ? new Response(file) : new Response(null, { status: 404 });
  });
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

const MiB = 1024 * 1024;
/**
 * A stored zip, streamed as it is built, holding `stored` as a.png beside `pad` zero bytes in a file
 * that is not media: an archive that passes `pad` bytes and sends one small image.
 */
async function* paddedZip(pad: number) {
  const zeros = Buffer.alloc(MiB);
  const padChunks = function* () {
    for (let left = pad; left > 0; left -= MiB) yield left >= MiB ? zeros : zeros.subarray(0, left);
  };
  let padCrc = 0;
  for (const chunk of padChunks()) padCrc = crc32(chunk, padCrc);
  const entries = [
    { name: Buffer.from('a.png'), size: stored.length, crc: crc32(stored), body: [stored] },
    { name: Buffer.from('pad.bin'), size: pad, crc: padCrc, body: padChunks() },
  ];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, size, crc, body } of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    yield Buffer.concat([local, name]);
    yield* body;
    offset += local.length + name.length + size;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  yield directory;
  yield end;
}

describe('an archive past the per-file cap, at the real caps', () => {
  const PAD = MAX_SPOOL_FILE_BYTES + MiB;
  const sentWhole = () => {
    expect(lines('evidence-too-large')).toEqual([]);
    expect(markedSent()).toBe(true);
    expect(fileDetailsSent()).toEqual([expect.objectContaining({ originalFileName: 'a.png' })]);
  };

  it('is sent as training data', async () => {
    serveTrainingData(Buffer.alloc(0));
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(ReadableStream.from(paddedZip(PAD)))
    );

    await processCsamReport(report('TrainingData', { modelVersionIds: [7] }));

    sentWhole();
  });

  it('is sent as external evidence', async () => {
    serveCsamBucket({});
    csamBucketObject.mockImplementation(async () => ({ Body: Readable.from(paddedZip(PAD)) }));

    await processCsamReport(
      report('ExternalLink', {
        email: 'x@example.invalid',
        evidence: { bucketKey: 'evidence-key', filename: 'evidence.zip' },
      })
    );

    sentWhole();
  });
});

describe('an archive with entries yauzl would refuse by name, or that are empty', () => {
  it('is sent with every image it holds, and records what it skipped', async () => {
    const zip = new JSZip();
    zip.file('../x.txt', 'not media');
    zip.file('/abs.jpg', stored);
    zip.file('C:\\y.jpg', stored);
    zip.file('empty.png', '');
    zip.file('ok.png', stored);
    serveTrainingData(await zip.generateAsync({ type: 'nodebuffer' }));

    await processCsamReport(report('TrainingData', { modelVersionIds: [7] }));

    expect(markedSent()).toBe(true);
    expect(fileDetailsSent().map(({ originalFileName }) => originalFileName)).toEqual([
      '/abs.jpg',
      'C:/y.jpg',
      'ok.png',
    ]);
    const recorded = dbMock.dbWrite.$executeRaw.mock.calls.find(([strings]) =>
      strings.join('').includes('skippedArchiveEntries')
    );
    expect(JSON.parse(recorded?.[1] as string)).toMatchObject({
      count: 1,
      empty: 1,
      unreadable: 0,
    });
    expect(lines('send-entries-skipped')).toHaveLength(1);
  });
});

describe('a report whose files pass what one send may write', () => {
  const CAP = 64 * 1024;
  // Compresses to almost nothing and inflates past the cap.
  const bombOf = async (name: string) => {
    const zip = new JSZip();
    zip.file(name, Buffer.alloc(16 * CAP));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  };
  beforeEach(() => {
    spoolCap.bytes = CAP;
    vi.mocked(logToAxiom).mockClear();
  });
  afterEach(() => {
    spoolCap.bytes = undefined;
  });
  const refused = () => {
    expect(submitReport).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(lines('evidence-too-large')).toEqual([expect.objectContaining({ reportId: 1 })]);
    expect(markedSent()).toBe(false);
  };

  it('opens no CyberTip for training data that inflates past it', async () => {
    const zip = await bombOf('td.png');
    expect(zip.byteLength).toBeLessThan(CAP / 8);
    serveTrainingData(zip);

    await processCsamReport(report('TrainingData', { modelVersionIds: [7] }));

    refused();
  });

  it('opens no CyberTip for external evidence that inflates past it, across both zips', async () => {
    const half = await zipOf(['a.png']);
    const big = new JSZip();
    big.file('b.png', Buffer.alloc(CAP));
    serveCsamBucket({
      'evidence-key': half,
      'supplemental-key': await big.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    });

    await processCsamReport(
      report('ExternalLink', {
        email: 'x@example.invalid',
        evidence: { bucketKey: 'evidence-key', filename: 'evidence.zip' },
        supplementalEvidence: { bucketKey: 'supplemental-key', filename: 'chat.zip' },
      })
    );

    refused();
  });

  it('opens no CyberTip for generated images that pass it together', async () => {
    generatedFile.mockImplementation(async () => new File([Buffer.alloc(CAP / 2 + 1)], 'g.png'));

    await processCsamReport(
      report('GeneratedImage', {
        generatedImages: [
          { jobId: 'job-1', blobs: [{ url: 'blob-1' }] },
          { jobId: 'job-2', blobs: [{ url: 'blob-2' }] },
        ],
      })
    );

    refused();
  });

  it('uploads external files one at a time, since each upload holds its file whole', async () => {
    spoolCap.bytes = undefined;
    serveCsamBucket({
      'evidence-key': await zipOf(['a.png', 'b.png']),
      'supplemental-key': await zipOf(['c.png']),
    });
    let inFlight = 0;
    let most = 0;
    uploadFile.mockImplementation(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { data: { fileId: 'file-1', hash: 'ncmec-md5' } };
    });

    await processCsamReport(
      report('ExternalLink', {
        email: 'x@example.invalid',
        evidence: { bucketKey: 'evidence-key', filename: 'evidence.zip' },
        supplementalEvidence: { bucketKey: 'supplemental-key', filename: 'chat.zip' },
      })
    );

    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  it('sends what stays under it', async () => {
    generatedFile.mockImplementation(async () => new File([Buffer.alloc(CAP / 2 - 1)], 'g.png'));

    await processCsamReport(
      report('GeneratedImage', {
        generatedImages: [
          { jobId: 'job-1', blobs: [{ url: 'blob-1' }] },
          { jobId: 'job-2', blobs: [{ url: 'blob-2' }] },
        ],
      })
    );

    expect(uploadFile).toHaveBeenCalledTimes(2);
    for (const [{ file }] of uploadFile.mock.calls) expect((file as File).size).toBe(CAP / 2 - 1);
    expect(lines('evidence-too-large')).toEqual([]);
  });
});

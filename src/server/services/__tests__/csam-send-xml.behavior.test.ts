import { S3Client } from '@aws-sdk/client-s3';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
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
  escape,
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
  escape: { off: false },
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
  // The positive control: with escaping off (illegal characters still scrubbed), nothing may open.
  const xmlText = (text: string) => (escape.off ? actual.xmlSafe(text) : actual.xmlText(text));
  return { ...actual, cyberTipXmlProblem, xmlText };
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
  escape.off = false;
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
    const chunks = paddedZip(PAD);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      },
    });
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(body));

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

  it('waits for every fetch before giving up, and starts none once past it', async () => {
    let slowAnswered = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (String(input) === 'blob-big') return new Response(new Uint8Array(CAP + 1));
      if (String(input) !== 'blob-slow') return new Response(new Uint8Array(8));
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          slowAnswered = true;
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      });
      return new Response(body);
    });

    await processCsamReport(
      report('GeneratedImage', {
        generatedImages: [
          { jobId: 'job-1', blobs: [{ url: 'blob-big' }] },
          { jobId: 'job-2', blobs: [{ url: 'blob-slow' }] },
          { jobId: 'job-3', blobs: [{ url: 'blob-late' }] },
        ],
      })
    );

    expect(slowAnswered).toBe(true);
    expect(vi.mocked(globalThis.fetch).mock.calls.map(([url]) => String(url))).not.toContain(
      'blob-late'
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

describe('a downloaded archive', () => {
  // The send's scratch root, as `isProd` (mocked on) resolves it.
  const zipsUnder = (scratch: string) => {
    const root = `${env.DIRNAME || process.cwd()}/csam/${scratch}`;
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.zip'));
  };
  const uploadsSeeing = (scratch: string, seen: string[][]) =>
    uploadFile.mockImplementation(async () => {
      seen.push(zipsUnder(scratch));
      return { data: { fileId: 'file-1', hash: 'ncmec-md5' } };
    });
  // The archive's bytes, then what is on disk once they are written: the zip being downloaded, in
  // the send's own `<reportId>-<claimId>` directory. Shows `zipsUnder` reads the root the send uses.
  const downloading = (bytes: Buffer, scratch: string, during: string[][]) => {
    let sent = false;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) {
          sent = true;
          return controller.enqueue(new Uint8Array(bytes));
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        during.push(zipsUnder(scratch));
        controller.close();
      },
    });
  };
  const inSendDir = (zip: string) => expect.stringMatching(new RegExp(`^1-[0-9a-f-]{36}/${zip}$`));

  it('is off disk before the next archive downloads, and before any upload', async () => {
    serveCsamBucket({});
    const zips: Record<string, Buffer> = {
      'evidence-key': await zipOf(['a.png']),
      'supplemental-key': await zipOf(['b.png']),
    };
    const seen: string[][] = [];
    const during: string[][] = [];
    csamBucketObject.mockImplementation(async (key: string) => {
      seen.push(zipsUnder('external-send'));
      return {
        Body: Readable.fromWeb(downloading(zips[key], 'external-send', during) as never),
      };
    });
    uploadsSeeing('external-send', seen);

    await processCsamReport(
      report('ExternalLink', {
        email: 'x@example.invalid',
        evidence: { bucketKey: 'evidence-key', filename: 'evidence.zip' },
        supplementalEvidence: { bucketKey: 'supplemental-key', filename: 'chat.zip' },
      })
    );

    expect(markedSent()).toBe(true);
    expect(during).toEqual([[inSendDir('evidence.zip')], [inSendDir('supplemental.zip')]]);
    expect(seen).toEqual([[], [], [], []]);
  });

  it('of training data is off disk before any upload', async () => {
    const zip = await zipOf(['a.png']);
    serveTrainingData(zip);
    const during: string[][] = [];
    vi.mocked(globalThis.fetch).mockImplementation(
      async () => new Response(downloading(zip, 'training-data', during))
    );
    const seen: string[][] = [];
    uploadsSeeing('training-data', seen);

    await processCsamReport(report('TrainingData', { modelVersionIds: [7] }));

    expect(markedSent()).toBe(true);
    expect(during).toEqual([[expect.stringMatching(/^1-[0-9a-f-]{36}\/\w+_training-data\.zip$/)]]);
    expect(seen).toEqual([[]]);
  });
});

describe('prompts sent with each file', () => {
  const HOSTILE = [
    '<lora:style_v2:0.8> R&D > less',
    ']]> <![CDATA[ x ]]> <script>alert(1)</script> &amp;',
    'nul\u0000 bell\u0007 lone\uD800 surrogate',
    'emoji 😀 "quotes"',
  ].join('\n');
  const scrubbed = HOSTILE.replace(/[\u0000\u0007\uD800]/g, '\uFFFD');

  /** Each sent file's details as NCMEC reads them, from the XML the real builder writes. */
  async function sentAsParsed() {
    return Promise.all(
      submitFileDetails.mock.calls.map(async ([details]) => {
        const doc = await new Parser({ strict: true, explicitArray: true }).parseStringPromise(
          buildSubmitFileDetails(details)
        );
        const root = doc.fileDetails;
        const pairs = (root.details?.[0]?.nameValuePair ?? []) as {
          name: string[];
          value: string[];
        }[];
        return {
          additionalInfo: (root.additionalInfo ?? []) as string[],
          pairs: Object.fromEntries(pairs.map((p) => [p.name[0], p.value[0]])),
        };
      })
    );
  }

  const generated = () =>
    report('GeneratedImage', {
      generatedImages: [
        {
          jobId: 'job-1',
          prompt: HOSTILE,
          negativePrompt: 'blurry & <bad>',
          resources: ['urn:air:x&y'],
          blobs: [{ url: 'blob-1' }],
        },
      ],
    });

  it('on an image report: read back as stored on the image, checked before the CyberTip opens', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([
      imageRow(501, { meta: { prompt: HOSTILE, negativePrompt: 'blurry & <bad>' } }),
    ]);

    await processCsamReport(report('Image', {}, [{ id: 501 }]));

    expect(markedSent()).toBe(true);
    expectSentDetailsChecked();
    const [file] = await sentAsParsed();
    expect(file.additionalInfo).toEqual([
      `Prompt, as stored on the image: ${scrubbed}\nNegative prompt, as stored on the image: blurry & <bad>`,
    ]);
    // The EXIF pair is trimmed of leading and trailing symbols, as on the preserved-evidence send.
    expect(file.pairs.prompt).toBe(scrubbed.slice(1, -1));
    expect(file.pairs.negativePrompt).toBe('blurry & <bad');
  });

  it('on an image report: a meta prompt that is not text, and meta resources, are not sent', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([
      imageRow(501, {
        meta: { prompt: { nested: '<x>' }, negativePrompt: 7, resources: ['urn:air:x'] },
      }),
    ]);

    await processCsamReport(report('Image', {}, [{ id: 501 }]));

    expect(markedSent()).toBe(true);
    const [file] = await sentAsParsed();
    expect(file).toEqual({ additionalInfo: [], pairs: {} });
  });

  it.each([
    ['an image report', 'Image', '[truncated]'],
    ['a generated-image report', 'GeneratedImage', '[truncated; full text preserved]'],
  ])('on %s: a long prompt is cut with its marker', async (_, type, marker) => {
    const long = 'p'.repeat(5_000);
    dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501, { meta: { prompt: long } })]);
    const filing =
      type === 'Image'
        ? report('Image', {}, [{ id: 501 }])
        : report('GeneratedImage', {
            generatedImages: [{ jobId: 'job-1', prompt: long, blobs: [{ url: 'blob-1' }] }],
          });

    await processCsamReport(filing);

    const [file] = await sentAsParsed();
    expect(file.additionalInfo[0].endsWith(`… ${marker}`)).toBe(true);
    if (type === 'Image') expect(file.additionalInfo[0]).not.toContain('preserved');
  });

  it('on a generated-image report: read back as the generation stored them, checked before the CyberTip opens', async () => {
    await processCsamReport(generated());

    expect(markedSent()).toBe(true);
    expectSentDetailsChecked();
    const [file] = await sentAsParsed();
    expect(file.additionalInfo).toEqual([
      `Prompt: ${scrubbed}\nNegative prompt: blurry & <bad>\nResources: urn:air:x&y`,
    ]);
    expect(file.pairs.resources).toBe('urn:air:x&y');
    expect(file.pairs.prompt).toBe(scrubbed.slice(1, -1));
  });

  it.each([
    [
      'an image report',
      () => {
        dbMock.dbRead.image.findMany.mockResolvedValue([
          imageRow(501, { meta: { prompt: 'R&D <b>bold</b> > less' } }),
        ]);
        return report('Image', {}, [{ id: 501 }]);
      },
    ],
    ['a generated-image report', generated],
  ])('with escaping off, opens no CyberTip for %s', async (_, filing) => {
    escape.off = true;

    await processCsamReport(filing());

    expect(submitReport).not.toHaveBeenCalled();
    expect(lines('send-xml')).toHaveLength(1);
  });

  it('on a generated-image report: only text resources are sent', async () => {
    await processCsamReport(
      report('GeneratedImage', {
        generatedImages: [
          { jobId: 'job-1', resources: [{ a: 1 }, '', 'ok'], blobs: [{ url: 'blob-1' }] },
        ],
      })
    );

    const [file] = await sentAsParsed();
    expect(file.pairs).toEqual({ resources: 'ok' });
  });

  it('on an image report: a very long meta prompt is cut before it is trimmed, and sent', async () => {
    const long = `a${'!'.repeat(200_000)}b`;
    dbMock.dbRead.image.findMany.mockResolvedValue([imageRow(501, { meta: { prompt: long } })]);

    const started = Date.now();
    await processCsamReport(report('Image', {}, [{ id: 501 }]));

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(markedSent()).toBe(true);
    const [file] = await sentAsParsed();
    // The cut leaves 'a' and a run of symbols, which the trim removes.
    expect(file.pairs.prompt).toBe('a… [truncated]');
    expect(file.additionalInfo[0].endsWith('… [truncated]')).toBe(true);
  });
});

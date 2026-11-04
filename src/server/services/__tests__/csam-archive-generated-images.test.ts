import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `archiveGeneratedImages`, end to end through `archiveCsamDataForReport` on the disk-staged path:
 * the flagged-consumer strikes read, files preserved by `evidenceKey` (archived, or listed missing
 * when they never can be), and files named by URL.
 *
 * The strikes read is the real `getConsumerStrikes` behind a stubbed `fetch`; the evidence store
 * read is stubbed at `streamEvidenceObject`, below the verified read.
 */

const csamBaseDir = await vi.hoisted(async () => {
  const [{ default: nodeFs }, { default: nodeOs }, { default: nodePath }, { setEnv }] =
    await Promise.all([
      import('fs'),
      import('os'),
      import('path'),
      import('~/__tests__/mocks/env.mock'),
    ]);
  const dirname = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'csam-genimg-test-'));
  setEnv({ DIRNAME: dirname });
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
  return nodePath.join(dirname, 'csam');
});

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

const { storedObjects, FakeS3Client } = vi.hoisted(() => {
  const storedObjects = new Map<string, Buffer>();
  const pending = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  let nextUploadId = 0;
  const objectName = (key: string) => key.slice(key.indexOf('_') + 1);
  const toBuffer = (body: unknown) =>
    Buffer.isBuffer(body)
      ? body
      : body instanceof Uint8Array
      ? Buffer.from(body)
      : Buffer.from(String(body));

  class FakeS3Client {
    config = {
      region: 'test-region',
      forcePathStyle: false,
      requestHandler: {},
      requestChecksumCalculation: async () => 'WHEN_REQUIRED',
      endpoint: async () => ({
        hostname: 'example.invalid',
        protocol: 'https:',
        path: '/',
        port: 443,
      }),
    };
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const input = command.input;
      switch (command.constructor.name) {
        case 'CreateMultipartUploadCommand': {
          const UploadId = `upload-${nextUploadId++}`;
          pending.set(UploadId, { key: input.Key as string, parts: new Map() });
          return { UploadId };
        }
        case 'UploadPartCommand':
          pending
            .get(input.UploadId as string)!
            .parts.set(input.PartNumber as number, toBuffer(input.Body));
          return { ETag: `"etag-${input.PartNumber}"` };
        case 'CompleteMultipartUploadCommand': {
          const upload = pending.get(input.UploadId as string)!;
          pending.delete(input.UploadId as string);
          const numbers = [...upload.parts.keys()].sort((a, b) => a - b);
          storedObjects.set(
            objectName(upload.key),
            Buffer.concat(numbers.map((n) => upload.parts.get(n)!))
          );
          return { ETag: '"etag-complete"' };
        }
        case 'PutObjectCommand':
          storedObjects.set(objectName(input.Key as string), toBuffer(input.Body));
          return { ETag: '"etag-put"' };
        case 'AbortMultipartUploadCommand':
          return {};
        default:
          throw new Error(`fake S3: unexpected command ${command.constructor.name}`);
      }
    }
    destroy() {
      return undefined;
    }
  }
  return { storedObjects, FakeS3Client };
});

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const mocked = { ...(await importOriginal<Record<string, unknown>>()), S3Client: FakeS3Client };
  return { ...mocked, default: mocked };
});

vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBlob: (...args: unknown[]) => mockFetchBlob(...args),
}));

vi.mock('~/server/services/generator-evidence/evidence-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  streamEvidenceObject: (key: string) => mockStreamEvidenceObject(key),
}));

// The read limit, lowered so a copy can exceed it without a quarter-gigabyte fixture. Above the
// 30-byte fixture file, so every other case reads under it.
vi.mock('~/server/services/generator-evidence/preserve-blob', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MAX_EVIDENCE_BYTES: 64,
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isFlipt: async () => false,
}));

let mockFetchBlob: (...args: unknown[]) => unknown = async () => null;
let mockStreamEvidenceObject: (key: string) => Promise<unknown> = async () => {
  throw new Error('no evidence object');
};
let strikesResponse: () => Response = () => new Response('[]', { status: 200 });
let strikesRequests: string[] = [];

import { archiveCsamDataForReport } from '~/server/services/csam.service-new';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const USER_ID = 31337;

const PRESERVED_BYTES = Buffer.from('preserved-png-bytes-0123456789');
const PRESERVED_SHA = createHash('sha256').update(PRESERVED_BYTES).digest('hex');

/** One file of the fixture; every recorded field optional, as on a stored report. */
type FixtureBlob = {
  blobId: string;
  role: string;
  status: string;
  evidenceKey?: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  preservedAt?: string;
};

/** A report filed with preserved generator evidence: one file with a copy, one without. */
const evidenceReport = (sha256 = PRESERVED_SHA) => ({
  id: 501,
  userId: USER_ID,
  reportedById: 5,
  reportId: null,
  type: 'GeneratedImage',
  images: [],
  details: {
    generatorEvidence: { version: 1 },
    generatedImages: [
      {
        jobId: 'job-a',
        source: 'workflow',
        workflowId: 'wf-a',
        blobs: [
          {
            blobId: 'blob-kept',
            role: 'output',
            status: 'preserved',
            evidenceKey: 'generator-evidence/key-kept',
            sha256,
            bytes: PRESERVED_BYTES.length,
            contentType: 'image/png',
            preservedAt: '2026-11-01T00:00:00.000Z',
          },
          { blobId: 'blob-expired', role: 'output', status: 'gone' },
        ] as FixtureBlob[],
      },
    ],
  },
});

/** A report filed the older way, naming its files by URL. */
const urlReport = {
  id: 502,
  userId: USER_ID,
  reportedById: 5,
  reportId: null,
  type: 'GeneratedImage',
  images: [],
  details: {
    generatedImages: [
      { jobId: 'job-b', blobs: [{ url: 'https://media.invalid/a/named-one.jpeg' }] },
    ],
  },
};

const URL_BYTES: Record<string, Buffer> = {
  'https://media.invalid/a/named-one.jpeg': Buffer.from('named-one-bytes'),
  'https://media.invalid/p/strike-preview.jpeg': Buffer.from('strike-preview-bytes'),
};

async function storedZip() {
  const bytes = storedObjects.get('generated-images.zip');
  if (!bytes) throw new Error('no generated-images.zip was stored');
  return JSZip.loadAsync(bytes);
}

const archiveRecord = () =>
  (
    dbMock.dbWrite.csamReportArchiveObject.createMany.mock.calls.at(-1)?.[0] as {
      data: { kind: string; entries?: number; namedExpected?: number; namedMissing?: number }[];
    }
  )?.data.find((row) => row.kind === 'generatedImages');

beforeEach(() => {
  storedObjects.clear();
  strikesRequests = [];
  strikesResponse = () => new Response('[]', { status: 200 });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/v1/manager/consumers/flagged/')) {
      strikesRequests.push(url);
      return strikesResponse();
    }
    throw new Error(`unexpected network fetch: ${url}`);
  });
  mockFetchBlob = async (url: unknown) => {
    const bytes = URL_BYTES[String(url)];
    return bytes ? new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }) : null;
  };
  mockStreamEvidenceObject = async (key) => {
    if (key !== 'generator-evidence/key-kept') throw new Error(`no evidence object at ${key}`);
    return { chunks: [new Uint8Array(PRESERVED_BYTES)], contentType: 'image/png' };
  };
  setEnv({
    CSAM_UPLOAD_KEY: 'test-key',
    CSAM_UPLOAD_SECRET: 'test-secret',
    CSAM_UPLOAD_REGION: 'test-region',
    CSAM_UPLOAD_ENDPOINT: 'https://example.invalid',
    CSAM_BUCKET_NAME: 'test-bucket',
  });
  dbMock.dbRead.user.findUnique.mockResolvedValue({ id: USER_ID, username: 'u' });
  dbMock.dbWrite.csamReport.update.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

afterAll(() => {
  fs.rmSync(path.dirname(csamBaseDir), { recursive: true, force: true });
});

describe('archiveGeneratedImages: flagged-consumer strikes', () => {
  it('archives with no strikes when the orchestrator has no record of the consumer (404)', async () => {
    strikesResponse = () => new Response('', { status: 404, statusText: 'Not Found' });

    await archiveCsamDataForReport(evidenceReport() as never);

    // Positive control: the strikes read was actually made, and answered 404.
    expect(strikesRequests).toHaveLength(1);
    expect(strikesRequests[0]).toContain(`/civitai-${USER_ID}/strikes`);
    expect(storedObjects.has('generated-images.zip')).toBe(true);
    expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 501 }, data: { archivedAt: expect.any(Date) } })
    );
  });

  it('logs every strikes 404 with the consumer and the response body', async () => {
    strikesResponse = () => new Response('no such consumer', { status: 404 });

    await archiveCsamDataForReport(evidenceReport() as never);

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith({
      name: 'orchestrator-flagged-consumers',
      type: 'warning',
      message: 'strikes read answered 404; treated as no strikes',
      consumerId: `civitai-${USER_ID}`,
      body: 'no such consumer',
    });
  });

  it('still fails the archive when the strikes read answers any other error (500)', async () => {
    strikesResponse = () => new Response('', { status: 500, statusText: 'Internal Server Error' });

    await expect(archiveCsamDataForReport(evidenceReport() as never)).rejects.toThrow(
      'Orchestrator fetch failed: 500 Internal Server Error'
    );
    expect(strikesRequests).toHaveLength(1);
    expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { archivedAt: expect.any(Date) } })
    );
  });
});

describe('archiveGeneratedImages: preserved evidence', () => {
  it('archives a file preserved by evidenceKey, and lists one with no copy as missing', async () => {
    await archiveCsamDataForReport(evidenceReport() as never);

    const zip = await storedZip();
    expect(Object.keys(zip.files).sort()).toEqual(['evidence/blob-kept.png', 'manifest.json']);
    expect(await zip.file('evidence/blob-kept.png')!.async('nodebuffer')).toEqual(PRESERVED_BYTES);
    expect(JSON.parse(await zip.file('manifest.json')!.async('string'))).toEqual({
      files: [
        {
          blobId: 'blob-kept',
          source: 'preserved',
          sha256: PRESERVED_SHA,
          bytes: 30,
          contentType: 'image/png',
        },
        { blobId: 'blob-expired', source: 'missing', reason: 'gone' },
      ],
    });
    expect(archiveRecord()).toMatchObject({ entries: 2, namedExpected: 1, namedMissing: 0 });
  });

  it('records a preserved copy that no longer matches its sha256 as missing, and counts it', async () => {
    await archiveCsamDataForReport(evidenceReport('f'.repeat(64)) as never);

    const zip = await storedZip();
    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json']);
    expect(JSON.parse(await zip.file('manifest.json')!.async('string')).files[0]).toEqual({
      blobId: 'blob-kept',
      source: 'missing',
      reason: 'the preserved copy no longer matches its sha256',
    });
    expect(archiveRecord()).toMatchObject({ entries: 1, namedExpected: 1, namedMissing: 1 });
  });

  it('archives a file once, by the occurrence holding a copy, when two jobs name it', async () => {
    const report = evidenceReport();
    const kept = report.details.generatedImages[0].blobs[0];
    report.details.generatedImages.unshift({
      jobId: 'job-z',
      source: 'workflow',
      workflowId: 'wf-z',
      blobs: [{ blobId: 'blob-kept', role: 'input', status: 'unavailable' } as typeof kept],
    });

    await archiveCsamDataForReport(report as never);

    const zip = await storedZip();
    expect(Object.keys(zip.files).sort()).toEqual(['evidence/blob-kept.png', 'manifest.json']);
    expect(
      JSON.parse(await zip.file('manifest.json')!.async('string')).files.map(
        (f: { blobId: string; source: string }) => `${f.blobId}:${f.source}`
      )
    ).toEqual(['blob-kept:preserved', 'blob-expired:missing']);
    expect(archiveRecord()).toMatchObject({ entries: 2, namedExpected: 1, namedMissing: 0 });
  });

  /** Runs one report whose single preserved file fails permanently, and returns what it recorded. */
  async function permanentFailure(report: ReturnType<typeof evidenceReport>) {
    await archiveCsamDataForReport(report as never);
    const zip = await storedZip();
    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json']);
    expect(archiveRecord()).toMatchObject({ entries: 1, namedExpected: 1, namedMissing: 1 });
    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls);
    expect(logged).not.toContain('generator-evidence/key-kept');
    return {
      manifestEntry: JSON.parse(await zip.file('manifest.json')!.async('string')).files[0],
      logged,
    };
  }

  it('records a preserved copy missing from the evidence store as missing, not a retry', async () => {
    mockStreamEvidenceObject = async () => {
      throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
    };

    const { manifestEntry, logged } = await permanentFailure(evidenceReport());

    expect(manifestEntry).toEqual({
      blobId: 'blob-kept',
      source: 'missing',
      reason: 'preserved copy not found in the evidence store',
    });
    expect(logged).toContain('preserved file could not be archived: preserved copy not found');
  });

  it.each([
    ['NotFound', { name: 'NotFound', $metadata: { httpStatusCode: 404 } }],
    ['a plain 404', { name: 'UnknownError', $metadata: { httpStatusCode: 404 } }],
  ])(
    'retries the report on %s without NoSuchKey: a wrong bucket answers that too',
    async (_case, fields) => {
      mockStreamEvidenceObject = async () => {
        throw Object.assign(new Error('not found'), fields);
      };

      await expect(archiveCsamDataForReport(evidenceReport() as never)).rejects.toThrow(
        'preserved file blob-kept could not be read: read failed: not found'
      );
    }
  );

  it('records a copy whose stored type is not evidence media as missing, when none was recorded', async () => {
    const report = evidenceReport();
    delete report.details.generatedImages[0].blobs[0].contentType;
    mockStreamEvidenceObject = async () => ({
      chunks: [new Uint8Array(PRESERVED_BYTES)],
      contentType: 'text/html',
    });

    const { manifestEntry } = await permanentFailure(report);

    expect(manifestEntry).toEqual({
      blobId: 'blob-kept',
      source: 'missing',
      reason: 'stored type is not an evidence media type',
    });
  });

  it('retries the report when a read fails mid-stream, whatever type the store reported', async () => {
    const report = evidenceReport();
    delete report.details.generatedImages[0].blobs[0].contentType;
    mockStreamEvidenceObject = async () => ({
      chunks: (async function* () {
        yield new Uint8Array(PRESERVED_BYTES.subarray(0, 4));
        throw new Error('connection reset');
      })(),
      contentType: 'text/html',
    });

    await expect(archiveCsamDataForReport(report as never)).rejects.toThrow(
      'preserved file blob-kept could not be read: read failed: connection reset'
    );
  });

  it('records a preserved copy whose recorded type is not evidence media as missing', async () => {
    const report = evidenceReport();
    report.details.generatedImages[0].blobs[0].contentType = 'text/html';

    const { manifestEntry, logged } = await permanentFailure(report);

    expect(manifestEntry).toEqual({
      blobId: 'blob-kept',
      source: 'missing',
      reason: 'recorded type is not an evidence media type',
    });
    expect(logged).toContain('recorded type is not an evidence media type');
  });

  it('records a preserved copy larger than the read limit as missing, not a retry', async () => {
    const report = evidenceReport();
    delete report.details.generatedImages[0].blobs[0].bytes;
    mockStreamEvidenceObject = async () => ({
      chunks: [new Uint8Array(40), new Uint8Array(40)],
      contentType: 'image/png',
    });

    const { manifestEntry, logged } = await permanentFailure(report);

    expect(manifestEntry).toEqual({
      blobId: 'blob-kept',
      source: 'missing',
      reason: 'the preserved copy is larger than 64 bytes',
    });
    expect(logged).toContain('the preserved copy is larger than 64 bytes');
  });

  it('records a preserved copy with no recorded sha256 as missing', async () => {
    const report = evidenceReport();
    delete (report.details.generatedImages[0].blobs[0] as { sha256?: string }).sha256;

    const { manifestEntry, logged } = await permanentFailure(report);

    expect(manifestEntry).toEqual({
      blobId: 'blob-kept',
      source: 'missing',
      reason: 'no sha256 recorded for the preserved copy',
    });
    expect(logged).toContain('no sha256 recorded for the preserved copy');
  });

  it('gives two blob ids that reduce to one safe name distinct entries', async () => {
    const report = evidenceReport();
    const kept = report.details.generatedImages[0].blobs[0];
    report.details.generatedImages[0].blobs = [
      { ...kept, blobId: 'a/b', evidenceKey: 'generator-evidence/key-kept' },
      { ...kept, blobId: 'a_b', evidenceKey: 'generator-evidence/key-kept' },
    ];

    await archiveCsamDataForReport(report as never);

    const zip = await storedZip();
    expect(Object.keys(zip.files).sort()).toEqual([
      'evidence/a_b-2.png',
      'evidence/a_b.png',
      'manifest.json',
    ]);
    expect(archiveRecord()).toMatchObject({ entries: 3, namedExpected: 2, namedMissing: 0 });
  });

  it('retries the report when the evidence store cannot be read', async () => {
    mockStreamEvidenceObject = async () => {
      throw new Error('store unavailable');
    };

    await expect(archiveCsamDataForReport(evidenceReport() as never)).rejects.toThrow(
      'preserved file blob-kept could not be read: read failed: store unavailable'
    );
  });
});

describe('archiveGeneratedImages: files named by URL', () => {
  it('archives the named URLs and strike previews as before, with no manifest', async () => {
    strikesResponse = () =>
      new Response(
        JSON.stringify([
          {
            status: 'active',
            strikes: [
              { job: { blobs: [{ previewUrl: 'https://media.invalid/p/strike-preview.jpeg' }] } },
            ],
          },
        ]),
        { status: 200 }
      );

    await archiveCsamDataForReport(urlReport as never);

    const zip = await storedZip();
    expect(Object.keys(zip.files).sort()).toEqual(['named-one.jpeg', 'strike-preview.jpeg']);
    expect(await zip.file('named-one.jpeg')!.async('string')).toBe('named-one-bytes');
    expect(archiveRecord()).toMatchObject({ entries: 2, namedExpected: 1, namedMissing: 0 });
  });

  it('counts a named URL that could not be fetched as missing', async () => {
    mockFetchBlob = async () => null;

    await archiveCsamDataForReport(urlReport as never);

    expect(Object.keys((await storedZip()).files)).toEqual([]);
    expect(archiveRecord()).toMatchObject({ entries: 0, namedExpected: 1, namedMissing: 1 });
  });
});

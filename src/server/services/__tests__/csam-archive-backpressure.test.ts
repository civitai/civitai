import fs from 'fs';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Archiver } from 'archiver';
import type * as ArchiverModule from 'archiver';

/**
 * Seam coverage for the CSAM evidence archiver.
 *
 * `archive-helpers.test.ts` pins the mechanism in isolation. This file pins the thing that
 * isolation cannot see: that `archiveCsamDataForReport` actually routes its appends through the
 * bounded appender. A perfectly-correct helper nobody calls fixes nothing.
 *
 * The defect being guarded: every image belonging to the reported user was downloaded, fully
 * buffered, and handed to `archive.append()` with nothing bounding the archiver's queue, so
 * resident memory tracked total downloaded bytes and the process was killed on its memory limit
 * partway through. All numbers below are invented.
 */

/** Instrumentation over the real archiver: counts appended vs. processed entries per archive. */
type ArchiveProbe = {
  appended: number;
  processed: number;
  peakOutstanding: number;
  peakRetainedBytes: number;
  entryNames: string[];
  options: { zlib?: { level?: number } } | undefined;
};
const probes: ArchiveProbe[] = [];

vi.mock('archiver', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof ArchiverModule }>();
  const create = (actual.default ?? actual) as unknown as (
    format: string,
    options?: unknown
  ) => Archiver;
  return {
    default: (format: string, options?: unknown) => {
      const archive = create(format, options);
      const probe: ArchiveProbe = {
        appended: 0,
        processed: 0,
        peakOutstanding: 0,
        peakRetainedBytes: 0,
        entryNames: [],
        options: options as ArchiveProbe['options'],
      };
      probes.push(probe);
      let retained = 0;
      const sizes: number[] = [];
      const originalAppend = archive.append.bind(archive);
      archive.append = ((source: Buffer, data: { name: string }) => {
        probe.appended++;
        probe.entryNames.push(data.name);
        sizes.push(Buffer.isBuffer(source) ? source.byteLength : 0);
        retained += Buffer.isBuffer(source) ? source.byteLength : 0;
        const outstanding = probe.appended - probe.processed;
        if (outstanding > probe.peakOutstanding) probe.peakOutstanding = outstanding;
        if (retained > probe.peakRetainedBytes) probe.peakRetainedBytes = retained;
        return originalAppend(source, data as never);
      }) as typeof archive.append;
      archive.on('entry', () => {
        retained -= sizes[probe.processed] ?? 0;
        probe.processed++;
      });
      return archive;
    },
  };
});

vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBlob: (...args: unknown[]) => mockFetchBlob(...args),
}));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    private readonly body: NodeJS.ReadableStream;
    constructor({ params }: { params: { Body: NodeJS.ReadableStream } }) {
      this.body = params.Body;
    }
    async done() {
      // Drain, so the PassThrough the service pipes into does not stall the caller.
      for await (const _chunk of this.body) {
        void _chunk;
      }
      return {};
    }
  },
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  S3Client: class {
    send() {
      return Promise.resolve({});
    }
    destroy() {
      return undefined;
    }
  },
}));

vi.mock('~/server/http/orchestrator/flagged-consumers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConsumerStrikes: (...args: unknown[]) => mockGetConsumerStrikes(...args),
}));

let mockFetchBlob: (...args: unknown[]) => unknown = () => null;
let mockGetConsumerStrikes: (...args: unknown[]) => unknown = async () => [];

import { archiveCsamDataForReport, getCsamsToArchive } from '~/server/services/csam.service-new';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  MAX_PENDING_ARCHIVE_ENTRIES,
  MEDIA_ARCHIVE_COMPRESSION_LEVEL,
} from '~/server/utils/archive-helpers';

// Overshoot the bound by a wide, non-multiple margin so the fixture cannot sit on the boundary
// it is testing. Invented figures — the real report was a different size entirely.
const IMAGE_COUNT = 53;
const IMAGE_BYTES = 97 * 1024;

const csamBaseDir = path.join(process.cwd(), 'csam');

function fakeBlob(bytes: number) {
  return {
    type: 'image/jpeg',
    arrayBuffer: async () => {
      const buffer = Buffer.alloc(bytes, 0xab);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

beforeEach(() => {
  probes.length = 0;
  mockFetchBlob = async () => fakeBlob(IMAGE_BYTES);
  mockGetConsumerStrikes = async () => [];
  setEnv({
    CSAM_UPLOAD_KEY: 'test-key',
    CSAM_UPLOAD_SECRET: 'test-secret',
    CSAM_UPLOAD_REGION: 'test-region',
    CSAM_UPLOAD_ENDPOINT: 'https://example.invalid',
    CSAM_BUCKET_NAME: 'test-bucket',
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  fs.rmSync(csamBaseDir, { recursive: true, force: true });
});

describe('getCsamsToArchive', () => {
  it('orders the batch deterministically so one bad report cannot permanently starve the rest', async () => {
    await getCsamsToArchive();
    const args = dbMock.dbRead.csamReport.findMany.mock.calls.at(-1)?.[0];
    expect(args?.orderBy).toBeDefined();
    expect(args?.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('archiveCsamDataForReport (Image report)', () => {
  const report = {
    id: 4242,
    userId: 909090,
    reportedById: 5,
    reportId: 77,
    type: 'Image',
    details: {},
    images: [],
  };

  function seedDb() {
    dbMock.dbRead.image.findMany.mockResolvedValue(
      Array.from({ length: IMAGE_COUNT }, (_, i) => ({
        id: i + 1,
        url: `image-uuid-${i}`,
        name: `picture-${i}.jpeg`,
        type: 'image',
        width: 1024,
        userId: report.userId,
      }))
    );
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      id: report.userId,
      name: 'n',
      email: 'e',
      username: 'u',
    });
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    dbMock.dbWrite.csamReport.update.mockResolvedValue({});
  }

  it('holds a bounded number of image buffers no matter how many images the user has', async () => {
    seedDb();

    await archiveCsamDataForReport(report as never);

    const imageArchive = probes.find((p) => p.appended > 0);
    expect(
      imageArchive,
      'no archive received any entries — the probe is wired to nothing'
    ).toBeDefined();

    // Positive control on the instrument, and it must come FIRST: a bounded reading is
    // indistinguishable from a probe that observed nothing. `appended` is the right control here
    // because it is the only counter that reads IMAGE_COUNT on BOTH the fixed and the unfixed
    // code — asserting the processed count instead would kill this test on the un-awaited
    // finalize defect before the bound assertion below ever ran, i.e. green for the wrong reason.
    expect(imageArchive!.appended).toBe(IMAGE_COUNT);

    // The regression. Pre-fix this reads IMAGE_COUNT, because every append was fire-and-forget.
    expect(imageArchive!.peakOutstanding).toBeLessThanOrEqual(MAX_PENDING_ARCHIVE_ENTRIES);
    expect(imageArchive!.peakRetainedBytes).toBeLessThanOrEqual(
      MAX_PENDING_ARCHIVE_ENTRIES * IMAGE_BYTES
    );
    // Stated the way the incident was observed: retained bytes must not track downloaded bytes.
    expect(imageArchive!.peakRetainedBytes).toBeLessThan(IMAGE_COUNT * IMAGE_BYTES);
  });

  it('returns only once every entry has been written — not while the zip is still being built', async () => {
    seedDb();

    await archiveCsamDataForReport(report as never);

    // Pre-fix `archive.finalize()` was not awaited, so this returned with the archive still
    // draining and `fs.createReadStream(outPath)` opened a partial file.
    const imageArchive = probes.find((p) => p.appended > 0);
    expect(imageArchive!.appended).toBe(IMAGE_COUNT);
    expect(imageArchive!.processed).toBe(IMAGE_COUNT);
  });

  it('archives every image exactly once — backpressure must not change what is stored', async () => {
    seedDb();

    await archiveCsamDataForReport(report as never);

    const imageArchive = probes.find((p) => p.appended > 0);
    expect(imageArchive!.entryNames).toHaveLength(IMAGE_COUNT);
    expect(new Set(imageArchive!.entryNames).size).toBe(IMAGE_COUNT);
    expect(imageArchive!.entryNames).toContain('picture-0.jpeg');
    expect(imageArchive!.entryNames).toContain(`picture-${IMAGE_COUNT - 1}.jpeg`);
  });

  // INVARIANT GUARD, not regression coverage: this pins a deliberate decision rather than a
  // behaviour the bug violated. Level 9 deflate on already-compressed image bytes is what made
  // the compressor the bottleneck; with backpressure in place it is no longer a memory hazard,
  // only a slow one, so nothing else in this suite would notice it coming back.
  it('builds the archive with the shared low compression level, not a re-hardcoded level 9', async () => {
    seedDb();

    await archiveCsamDataForReport(report as never);

    const imageArchive = probes.find((p) => p.appended > 0);
    expect(imageArchive!.options?.zlib?.level).toBe(MEDIA_ARCHIVE_COMPRESSION_LEVEL);
    expect(MEDIA_ARCHIVE_COMPRESSION_LEVEL).toBeLessThanOrEqual(1);
  });

  it('stamps archivedAt only after the archive has been written and uploaded', async () => {
    seedDb();

    await archiveCsamDataForReport(report as never);

    expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: report.id },
        data: expect.objectContaining({ archivedAt: expect.any(Date) }),
      })
    );
  });

  it('does not stamp archivedAt when the archive fails', async () => {
    seedDb();
    mockFetchBlob = async () => {
      throw new Error('synthetic download failure');
    };

    await expect(archiveCsamDataForReport(report as never)).rejects.toThrow(
      'synthetic download failure'
    );
    expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
  });
});

describe('archiveCsamDataForReport (GeneratedImage report)', () => {
  // The generated-image path had the identical unbounded-append shape and must be bounded too.
  const report = {
    id: 4343,
    userId: 808080,
    reportedById: 5,
    reportId: 78,
    type: 'GeneratedImage',
    details: {},
    images: [],
  };

  beforeEach(() => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      id: report.userId,
      name: 'n',
      email: 'e',
      username: 'u',
    });
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    dbMock.dbWrite.csamReport.update.mockResolvedValue({});
    mockGetConsumerStrikes = async () => [
      {
        strikes: Array.from({ length: IMAGE_COUNT }, (_, i) => ({
          job: { blobs: [{ previewUrl: `https://example.invalid/blob-${i}.jpeg` }] },
        })),
      },
    ];
  });

  it('holds a bounded number of generated-image buffers', async () => {
    await archiveCsamDataForReport(report as never);

    const generatedArchive = probes.find((p) => p.appended > 0);
    expect(
      generatedArchive,
      'no archive received any entries — the probe is wired to nothing'
    ).toBeDefined();

    // Positive control first, for the same reason as in the Image case above.
    expect(generatedArchive!.appended).toBe(IMAGE_COUNT);
    expect(generatedArchive!.peakOutstanding).toBeLessThanOrEqual(MAX_PENDING_ARCHIVE_ENTRIES);
    expect(generatedArchive!.peakRetainedBytes).toBeLessThan(IMAGE_COUNT * IMAGE_BYTES);
    expect(generatedArchive!.processed).toBe(IMAGE_COUNT);
  });
});

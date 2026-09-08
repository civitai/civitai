import fs from 'fs';
import os from 'os';
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

/**
 * 🔴 Redirect the service's on-disk scratch space into a private temp dir, BEFORE the service
 * module is evaluated.
 *
 * `csam.service-new` computes `baseDir` once, at module scope, as
 * `${isProd && env.DIRNAME ? env.DIRNAME : process.cwd()}/csam`. Left alone, this suite writes
 * real zips and evidence JSON into `<repo>/csam` — a path that is NOT gitignored — and then
 * `rm -rf`s it, which is also where a `pnpm dev` run puts its own CSAM scratch files. A unit run
 * deleting a developer's local artefacts is not an acceptable side effect.
 *
 * `vi.hoisted` runs after `setup.ts` (so its `resetSharedMocks()` has already cleared per-file env
 * overrides) and before this file's imports are evaluated, which is the only window in which a
 * module-scope env read can still be answered. See the KNOWN LIMIT note in `env.mock.ts`.
 */
const csamBaseDir = await vi.hoisted(async () => {
  const [{ default: nodeFs }, { default: nodeOs }, { default: nodePath }, { setEnv }] =
    await Promise.all([
      import('fs'),
      import('os'),
      import('path'),
      import('~/__tests__/mocks/env.mock'),
    ]);
  const dirname = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'csam-archive-test-'));
  setEnv({ DIRNAME: dirname });
  // `isProd: true` below also reaches `~/env/client-schema`, which makes this variable required
  // and throws at module scope without it. Additive and `??=`, matching how `setup.ts` seeds the
  // env its own packages validate directly.
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
  return nodePath.join(dirname, 'csam');
});

// The other half of the redirect: `baseDir` only honours `env.DIRNAME` when `isProd`. Scoped to
// this file's module graph — no `process.cwd()` monkey-patching, which would leak to every other
// file sharing the worker.
vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

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

/**
 * Captures every uploaded object by its S3 key. The service deletes its scratch directories
 * before returning, so what reaches this mock is the only observable copy of what was archived —
 * which makes it the right place to assert bundle CONTENT.
 */
const uploads = new Map<string, Buffer>();
let uploadFailure: Error | undefined;

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    private readonly body: NodeJS.ReadableStream;
    private readonly key: string;
    constructor({ params }: { params: { Body: NodeJS.ReadableStream; Key: string } }) {
      this.body = params.Body;
      this.key = params.Key;
    }
    async done() {
      // Drain, so the PassThrough the service pipes into does not stall the caller.
      const chunks: Buffer[] = [];
      for await (const chunk of this.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      if (uploadFailure) throw uploadFailure;
      uploads.set(this.key.slice(this.key.indexOf('_') + 1), Buffer.concat(chunks));
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

import {
  archiveCsamDataForReport,
  ARCHIVE_SCAN_PAGE_SIZE,
  getCsamsToArchive,
} from '~/server/services/csam.service-new';
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
  uploads.clear();
  uploadFailure = undefined;
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
  // The whole mkdtemp dir this suite owns — never a path shared with a dev checkout.
  fs.rmSync(path.dirname(csamBaseDir), { recursive: true, force: true });
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

  it('archives images from EVERY page, not just the first round-trip', async () => {
    // `archiveImages` used to iterate one in-memory array of every row the user owns. It now
    // walks the same cursor-paged scan the bundle uses, so a stop-after-the-first-page defect
    // would silently archive a prefix of the library and stamp the report as complete. A single
    // short page cannot see that — the fixture has to cross a full page boundary.
    // Taken from the production constant, never hardcoded: a fixture pinned to 500 silently
    // stops crossing a page boundary the day that number is raised, and then passes vacuously.
    const PAGE_SIZE = ARCHIVE_SCAN_PAGE_SIZE;
    const TOTAL = PAGE_SIZE + 3;
    expect(TOTAL).toBeGreaterThan(PAGE_SIZE);
    const rows = Array.from({ length: TOTAL }, (_, i) => ({
      id: i + 1,
      url: `image-uuid-${i}`,
      name: `picture-${i}.jpeg`,
      type: 'image',
      width: 1024,
      userId: report.userId,
    }));
    // A real keyset-pagination fake rather than a fixed script of pages, so it answers both the
    // bundle's scan and the archive's scan without depending on their call order.
    dbMock.dbRead.image.findMany.mockImplementation(
      async (args: { where?: { id?: { gt?: number } }; take?: number } = {}) => {
        const after = args.where?.id?.gt ?? 0;
        return rows.filter((row) => row.id > after).slice(0, args.take ?? rows.length);
      }
    );
    dbMock.dbRead.user.findUnique.mockResolvedValue({ id: report.userId });
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    dbMock.dbWrite.csamReport.update.mockResolvedValue({});
    mockFetchBlob = async () => fakeBlob(8);

    await archiveCsamDataForReport(report as never);

    const imageArchive = probes.find((p) => p.appended > 0);
    expect(imageArchive, 'no archive received any entries').toBeDefined();
    expect(imageArchive!.entryNames).toHaveLength(TOTAL);
    // Named explicitly at both ends of the boundary: the last entry of page 1, the first of
    // page 2, and the last overall.
    expect(imageArchive!.entryNames).toContain(`picture-${PAGE_SIZE - 1}.jpeg`);
    expect(imageArchive!.entryNames).toContain(`picture-${PAGE_SIZE}.jpeg`);
    expect(imageArchive!.entryNames).toContain(`picture-${TOTAL - 1}.jpeg`);
    // The bound still holds across page boundaries — a per-page drain must not become a
    // per-page burst.
    expect(imageArchive!.peakOutstanding).toBeLessThanOrEqual(MAX_PENDING_ARCHIVE_ENTRIES);
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

/**
 * The base evidence bundle — `<userId>_data.json`.
 *
 * Pre-fix this was `JSON.stringify({ user, reportId, models, modelVersions, images }, replacer)`
 * over three unpaginated `findMany`s. Two ceilings, and the second is the one that matters:
 * `JSON.stringify` returns ONE JavaScript string, and a JS string cannot exceed V8's maximum
 * length (~512 MB on 64-bit). Past that it throws `RangeError: Invalid string length` — a hard,
 * permanent failure for that report, on every retry, forever.
 *
 * 🔴 The bundle is NCMEC evidence, so "uses less memory" is not the bar. Every assertion below
 * that concerns size is paired with one that concerns CONTENT.
 */
describe('archiveCsamDataForReport (base evidence bundle)', () => {
  // Overshoots the cap ~10x, while any single row is ~40x under it — so a page-at-a-time
  // serialiser is safe by a wide margin and a one-shot serialiser is not. Invented figures.
  const ROW_COUNT = 400;
  const STRING_CAP = 24_000;

  const report = {
    id: 4444,
    userId: 707070,
    reportedById: 5,
    reportId: 79,
    // ExternalLink archives the base bundle and nothing else, which isolates this path.
    type: 'ExternalLink',
    details: {},
    images: [],
  };

  const user = { id: report.userId, name: 'n', email: 'e', username: 'u' };
  const images = Array.from({ length: ROW_COUNT }, (_, i) => ({
    id: i + 1,
    url: `image-uuid-${i}`,
    name: `picture-${i}.jpeg`,
    type: 'image',
    width: 1024,
    userId: report.userId,
    // A bigint column (`Image.pHash` is one) — the replacer is the reason the bundle cannot
    // simply be `JSON.stringify(rows)`, so the fixture has to contain one.
    pHash: BigInt('900719925474099') + BigInt(i),
    createdAt: new Date(Date.UTC(2019, 2, 4, 5, 6, 7, 89)),
    meta: { prompt: `p${i}-${'x'.repeat(500)}` },
  }));
  const models = [{ id: 11, name: 'm-eleven', userId: report.userId }];
  const modelVersions = [{ id: 21, modelId: 11, name: 'v-twenty-one' }];

  /** Exactly the document the pre-fix code produced, built the pre-fix way. */
  const expectedBundle = () =>
    JSON.stringify({ user, reportId: report.reportId, models, modelVersions, images }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v
    );

  function seedDb() {
    dbMock.dbRead.image.findMany.mockResolvedValue(images);
    dbMock.dbRead.user.findUnique.mockResolvedValue(user);
    dbMock.dbRead.model.findMany.mockResolvedValue(models);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue(modelVersions);
    dbMock.dbWrite.csamReport.update.mockResolvedValue({});
  }

  /**
   * Reproduces V8's string-length failure at a small, test-chosen size. Not an approximation:
   * `JSON.stringify` genuinely cannot return a string longer than the engine's maximum, and this
   * makes that boundary reachable from a fixture that fits in a unit test.
   */
  async function withMaxStringLength<T>(cap: number, fn: () => Promise<T>) {
    const real = JSON.stringify;
    let longest = 0;
    (JSON as { stringify: typeof JSON.stringify }).stringify = ((
      value: unknown,
      replacer?: unknown,
      space?: unknown
    ) => {
      const out = (real as (v: unknown, r?: unknown, s?: unknown) => string | undefined)(
        value,
        replacer,
        space
      );
      if (typeof out === 'string') {
        if (out.length > longest) longest = out.length;
        if (out.length > cap) throw new RangeError('Invalid string length');
      }
      return out;
    }) as typeof JSON.stringify;
    try {
      return { result: await fn(), longest };
    } finally {
      (JSON as { stringify: typeof JSON.stringify }).stringify = real;
    }
  }

  it('POSITIVE CONTROL: the fixture really does exceed the injected cap', () => {
    expect(expectedBundle().length).toBeGreaterThan(STRING_CAP * 5);
    expect(
      JSON.stringify(images[0], (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).length
    ).toBeLessThan(STRING_CAP / 10);
  });

  it('archives a library whose bundle exceeds the maximum JavaScript string length', async () => {
    seedDb();

    // Pre-fix this rejects with `RangeError: Invalid string length` and the report is never
    // archived. There is no retry that fixes it and no memory limit that raises it.
    const { longest } = await withMaxStringLength(STRING_CAP, () =>
      archiveCsamDataForReport(report as never)
    );

    expect(longest).toBeLessThanOrEqual(STRING_CAP);
    expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ archivedAt: expect.any(Date) }) })
    );
  });

  it('uploads a bundle byte-identical to the one the pre-fix serialiser produced', async () => {
    seedDb();

    await archiveCsamDataForReport(report as never);

    const uploaded = uploads.get('data.json');
    // Positive control on the instrument: an absent upload would make the comparison below
    // vacuous, and `undefined === undefined` is a very quiet way to pass.
    expect(uploaded, 'nothing was uploaded — the capture is wired to nothing').toBeDefined();
    expect(uploaded!.length).toBeGreaterThan(STRING_CAP);
    expect(uploaded!.toString('utf8')).toBe(expectedBundle());
  });

  it('never issues an unbounded scan for the rows that go into the bundle', async () => {
    seedDb();

    await archiveCsamDataForReport(report as never);

    // Structural, and deliberately stated over EVERY call rather than the last one: a single
    // surviving unpaginated `findMany` reinstates the ceiling regardless of how many paged ones
    // sit beside it.
    for (const model of ['image', 'model', 'modelVersion'] as const) {
      const calls = dbMock.dbRead[model].findMany.mock.calls;
      expect(calls.length, `${model}.findMany was never called`).toBeGreaterThan(0);
      for (const [args] of calls) {
        expect(typeof args?.take, `${model}.findMany call without a page size`).toBe('number');
        expect(args?.orderBy, `${model}.findMany call without a stable cursor order`).toEqual({
          id: 'asc',
        });
      }
    }
  });

  it('walks every page rather than archiving only the first', async () => {
    // Three short pages behind a page size of 500 would be indistinguishable from one page, so
    // the fixture returns FULL pages until it runs out — which is the only shape that can catch
    // a scan that stops after its first round-trip.
    const pageSize = ARCHIVE_SCAN_PAGE_SIZE;
    const pages = [
      Array.from({ length: pageSize }, (_, i) => ({ ...images[0], id: i + 1 })),
      Array.from({ length: pageSize }, (_, i) => ({ ...images[0], id: pageSize + i + 1 })),
      [{ ...images[0], id: 2 * pageSize + 1 }],
    ];
    seedDb();
    dbMock.dbRead.image.findMany
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1])
      .mockResolvedValueOnce(pages[2])
      .mockResolvedValue([]);

    await archiveCsamDataForReport(report as never);

    const bundle = JSON.parse(uploads.get('data.json')!.toString('utf8'));
    expect(bundle.images).toHaveLength(2 * pageSize + 1);
    expect(bundle.images.at(-1).id).toBe(2 * pageSize + 1);
    // The cursor has to advance, or the same page is re-read forever.
    const cursors = dbMock.dbRead.image.findMany.mock.calls.map(([a]) => a?.where?.id?.gt);
    expect(cursors.slice(0, 3)).toEqual([undefined, pageSize, 2 * pageSize]);
  });

  it('filters model versions by the COMPLETE set of model ids, not a partially-scanned one', async () => {
    // The ordering invariant in `archiveBaseReportData`: `modelVersions` is filtered by ids
    // accumulated while `models` streams, so its first query must not be issued until that scan
    // has finished. Two full model pages make a premature query observable.
    const pageSize = ARCHIVE_SCAN_PAGE_SIZE;
    seedDb();
    dbMock.dbRead.model.findMany
      .mockResolvedValueOnce(Array.from({ length: pageSize }, (_, i) => ({ id: i + 1 })))
      .mockResolvedValueOnce([{ id: pageSize + 1 }])
      .mockResolvedValue([]);

    await archiveCsamDataForReport(report as never);

    const versionCalls = dbMock.dbRead.modelVersion.findMany.mock.calls;
    expect(versionCalls.length).toBeGreaterThan(0);
    expect(versionCalls[0][0]?.where?.modelId?.in).toHaveLength(pageSize + 1);
  });
});

describe('archiveCsamDataForReport (upload failure)', () => {
  const report = {
    id: 4545,
    userId: 606060,
    reportedById: 5,
    reportId: 80,
    type: 'ExternalLink',
    details: {},
    images: [],
  };

  it('rejects with a real Error, so the batch loop can read .message without throwing', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);
    dbMock.dbRead.user.findUnique.mockResolvedValue({ id: report.userId });
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    uploadFailure = new Error('synthetic s3 failure');

    // Pre-fix `uploadStream` rejected with a bare `reject()`, i.e. `undefined`. The caller's
    // `catch (e) { … e.message }` then raised a TypeError INSIDE the catch block, which escapes
    // the per-report try/catch in `process-csam` and abandons the rest of the batch.
    // A sentinel, not `undefined`: the pre-fix rejection VALUE is `undefined`, so mapping
    // success to `undefined` would make "resolved" and "rejected with undefined" identical here.
    const RESOLVED = Symbol('resolved');
    const caught: unknown = await archiveCsamDataForReport(report as never).then(
      () => RESOLVED,
      (e: unknown) => e
    );

    expect(caught, 'the archive resolved — the upload failure never propagated').not.toBe(RESOLVED);
    expect(caught).toBeInstanceOf(Error);
    expect(() => (caught as Error).message).not.toThrow();
    expect((caught as Error).message).toContain('data.json');
    // The original failure has to survive, or the log line says nothing useful.
    expect((caught as Error).cause).toBe(uploadFailure);
  });
});

describe('archiveCsamDataForReport (unnameable generated-image URL)', () => {
  const report = {
    id: 4646,
    userId: 505050,
    reportedById: 5,
    reportId: 81,
    type: 'GeneratedImage',
    details: {},
    images: [],
  };

  beforeEach(() => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);
    dbMock.dbRead.user.findUnique.mockResolvedValue({ id: report.userId });
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
    dbMock.dbWrite.csamReport.update.mockResolvedValue({});
  });

  it('archives the entry under a fallback name instead of poisoning the report forever', async () => {
    // `https://host/blob/` and `https://host/?x` both reduce to '' under the basename
    // expression. Since archive errors now latch and rethrow from finalize(), an empty name
    // makes archiver emit ENTRYNAMEREQUIRED and the report is never stamped — so it is
    // re-selected and fails again on every hourly run, permanently.
    mockGetConsumerStrikes = async () => [
      {
        strikes: [
          { job: { blobs: [{ previewUrl: 'https://example.invalid/blob/' }] } },
          { job: { blobs: [{ previewUrl: 'https://example.invalid/?x=1' }] } },
          { job: { blobs: [{ previewUrl: 'https://example.invalid/ok-2.jpeg' }] } },
        ],
      },
    ];

    await archiveCsamDataForReport(report as never);

    const generatedArchive = probes.find((p) => p.appended > 0);
    expect(generatedArchive, 'no archive received any entries').toBeDefined();
    expect(generatedArchive!.entryNames).toEqual(['unnamed-0-blob', 'unnamed-1', 'ok-2.jpeg']);
    // Every entry name must be non-empty — that is the property archiver enforces.
    for (const name of generatedArchive!.entryNames) expect(name.length).toBeGreaterThan(0);

    // And the whole point: the report reaches a terminal state.
    expect(dbMock.dbWrite.csamReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ archivedAt: expect.any(Date) }) })
    );
  });
});

describe('test harness', () => {
  it('writes its scratch files under a private temp dir, not into the repository', () => {
    // Declared last so the suites above have already driven a real archive through `baseDir`.
    // If the `env.DIRNAME` redirect silently stops working this file goes back to writing zips
    // into `<repo>/csam` — a path that is not gitignored — and `rm -rf`-ing it in afterAll,
    // which is also where a local dev run keeps its own CSAM scratch files.
    expect(csamBaseDir.startsWith(os.tmpdir())).toBe(true);
    expect(csamBaseDir.startsWith(process.cwd())).toBe(false);
    // Positive control: the service really did write somewhere, and it was here — without it a
    // redirect pointing at a path nothing ever touches would read as a pass.
    expect(fs.existsSync(csamBaseDir)).toBe(true);
    // Deliberately NOT asserting that `<repo>/csam` is absent: a developer's own `pnpm dev` run
    // legitimately creates that directory, and a test that fails on somebody else's local state
    // is a test people learn to ignore. The two assertions above pin what this file controls.
  });
});

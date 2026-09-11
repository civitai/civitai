import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Equivalence proof for streaming an evidence archive straight to object storage.
 *
 * THE DEFECT: each media archive was written to the container's local scratch volume, read back,
 * and then uploaded. That volume has a size limit, so a reported account with a large enough
 * media library exceeded it and the container was evicted before the archive could finish —
 * every time, for that account. Raising the limit only moves the ceiling; removing local staging
 * removes it.
 *
 * WHAT THIS FILE PROVES, and it is deliberately not "the zips are byte-identical": a zip embeds a
 * timestamp per entry, so two runs of correct code differ byte-for-byte. The claim that actually
 * matters for an evidence bundle is that it CONTAINS the same things, so what is compared is the
 * content inventory — sorted entry names, each entry's uncompressed size, and a SHA-256 of each
 * entry's uncompressed bytes.
 *
 * 🔴 AND COMPARING THE TWO PATHS TO EACH OTHER IS NOT ENOUGH ON ITS OWN. Two arms of the same
 * comparison are blind to a defect they share — a bug in the appending code both paths run would
 * produce two identical, identically-wrong inventories and a green test. So every inventory is
 * also checked against the bytes the fixture generated, independently of either path.
 *
 * The uploader here is the REAL `@aws-sdk/lib-storage` `Upload` driving a fake S3 that reassembles
 * parts. The fixture is sized to exceed one part, so multipart splitting, part ordering and part
 * reassembly are exercised rather than assumed — and the part count is asserted, because a
 * single-shot `PutObject` would make every other assertion in this file vacuous.
 */

/**
 * 🔴 Redirect the service's on-disk scratch space into a private temp dir, BEFORE the service
 * module is evaluated — `csam.service-new` computes its base directory once, at module scope.
 * Same reasoning (and the same `isProd` half below) as `csam-archive-backpressure.test.ts`.
 */
const csamBaseDir = await vi.hoisted(async () => {
  const [{ default: nodeFs }, { default: nodeOs }, { default: nodePath }, { setEnv }] =
    await Promise.all([
      import('fs'),
      import('os'),
      import('path'),
      import('~/__tests__/mocks/env.mock'),
    ]);
  const dirname = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'csam-stream-test-'));
  setEnv({ DIRNAME: dirname });
  process.env.NEXT_PUBLIC_CIVITAI_LINK ??= 'https://example.invalid/civitai-link';
  return nodePath.join(dirname, 'csam');
});

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isProd: true,
}));

// ---------------------------------------------------------------------------------------------
// Fake S3 — reassembles multipart uploads so the stored object can be inspected.
// ---------------------------------------------------------------------------------------------

type StoredObject = {
  /** Reassembled body. */
  body: Buffer;
  /** Number of multipart parts, or 0 when the object went up as a single `PutObject`. */
  partCount: number;
  /** Byte length of each part, in part order. */
  partSizes: number[];
};

// Hoisted: the `vi.mock` factory below is lifted above every module-scope statement in this file,
// so anything it closes over has to be initialised in a hoisted block or it is a TDZ error at
// mock time. The maps live here too, so the class and the assertions read the same instances.
const { storedObjects, pendingUploads, FakeS3Client } = vi.hoisted(() => {
  const storedObjects = new Map<string, StoredObject>();
  const pendingUploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  let nextUploadId = 0;

  /** Strips the `<userId>/<timestamp>_` prefix the service puts on every key. */
  const objectName = (key: string) => key.slice(key.indexOf('_') + 1);

  function toBuffer(body: unknown): Buffer {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body === 'string') return Buffer.from(body);
    throw new Error(`fake S3: unsupported part body of type ${typeof body}`);
  }

  class FakeS3Client {
    // `Upload` reads these off the client before it sends anything.
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
      const name = command.constructor.name;
      const input = command.input;

      switch (name) {
        case 'CreateMultipartUploadCommand': {
          const UploadId = `upload-${nextUploadId++}`;
          pendingUploads.set(UploadId, { key: input.Key as string, parts: new Map() });
          return { UploadId };
        }
        case 'UploadPartCommand': {
          const pending = pendingUploads.get(input.UploadId as string);
          if (!pending) throw new Error(`fake S3: UploadPart for unknown upload ${input.UploadId}`);
          const partNumber = input.PartNumber as number;
          pending.parts.set(partNumber, toBuffer(input.Body));
          return { ETag: `"etag-${partNumber}"` };
        }
        case 'CompleteMultipartUploadCommand': {
          const pending = pendingUploads.get(input.UploadId as string);
          if (!pending) throw new Error(`fake S3: Complete for unknown upload ${input.UploadId}`);
          pendingUploads.delete(input.UploadId as string);
          // Reassemble in PART NUMBER order, not arrival order — parts are uploaded concurrently,
          // so arrival order is not the object's order and reassembling by it would corrupt the
          // object in a way that looks exactly like a streaming bug.
          const numbers = [...pending.parts.keys()].sort((a, b) => a - b);
          const chunks = numbers.map((n) => pending.parts.get(n)!);
          storedObjects.set(objectName(pending.key), {
            body: Buffer.concat(chunks),
            partCount: numbers.length,
            partSizes: chunks.map((c) => c.length),
          });
          return { ETag: '"etag-complete"' };
        }
        case 'PutObjectCommand': {
          const body = toBuffer(input.Body);
          storedObjects.set(objectName(input.Key as string), {
            body,
            partCount: 0,
            partSizes: [body.length],
          });
          return { ETag: '"etag-put"' };
        }
        case 'AbortMultipartUploadCommand': {
          pendingUploads.delete(input.UploadId as string);
          return {};
        }
        default:
          // Loud by design. A silently-successful unknown command would let an upload "succeed"
          // while storing nothing, and every content assertion below would read `undefined`.
          throw new Error(`fake S3: unexpected command ${name}`);
      }
    }

    destroy() {
      return undefined;
    }
  }

  return { storedObjects, pendingUploads, FakeS3Client };
});

vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  // Only the client is replaced. The command classes stay real, which is what lets the fake
  // dispatch on their constructor names and what keeps `Upload`'s own behaviour untouched.
  ...(await importOriginal<Record<string, unknown>>()),
  S3Client: FakeS3Client,
}));

vi.mock('~/utils/file-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBlob: (...args: unknown[]) => mockFetchBlob(...args),
}));

vi.mock('~/server/http/orchestrator/flagged-consumers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConsumerStrikes: (...args: unknown[]) => mockGetConsumerStrikes(...args),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isFlipt: (...args: unknown[]) => mockIsFlipt(...args),
}));

let mockFetchBlob: (...args: unknown[]) => unknown = () => null;
let mockGetConsumerStrikes: (...args: unknown[]) => unknown = async () => [];
let mockIsFlipt: (...args: unknown[]) => unknown = async () => false;

import { archiveCsamDataForReport } from '~/server/services/csam.service-new';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import {
  deriveUploadPartGeometry,
  ESTIMATED_BYTES_PER_ARCHIVED_IMAGE,
  S3_MIN_PART_SIZE_BYTES,
} from '~/server/utils/archive-helpers';

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

/**
 * Entry payloads must be INCOMPRESSIBLE, and this is the load-bearing detail of the fixture.
 *
 * The archives are written at deflate level 1, but a run of identical bytes still compresses
 * ~1000:1 — a fixture built with `Buffer.alloc(n, 0xab)` produces a few-KB zip that goes up as a
 * single `PutObject`, and every multipart assertion in this file would then pass vacuously while
 * measuring nothing. Pseudo-random bytes keep the zip roughly the size of its inputs.
 *
 * Deterministic per index, and cached, so the two runs being compared are fed byte-identical
 * input. A comparison of two runs over two different inputs proves nothing.
 */
const entryBytesCache = new Map<number, Buffer>();
function entryBytes(index: number): Buffer {
  const cached = entryBytesCache.get(index);
  if (cached) return cached;
  const out = Buffer.allocUnsafe(ENTRY_BYTES);
  // xorshift32, seeded off the index so entry N is the same bytes in every run.
  let x = (index * 2654435761 + 12345) >>> 0 || 1;
  for (let i = 0; i < ENTRY_BYTES; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  entryBytesCache.set(index, out);
  return out;
}

/**
 * 73 entries of 192 KiB is ~13.7 MiB of incompressible payload, which is ~2.7x the 5 MiB minimum
 * part size — so the upload splits into 3 parts and the test sees real multipart behaviour
 * including a short final part. Both figures are deliberately non-round and the total is
 * deliberately not a whole multiple of the part size: a fixture that lands exactly on a part
 * boundary never exercises the short-final-part path.
 */
const ENTRY_COUNT = 73;
const ENTRY_BYTES = 192 * 1024;

/**
 * 🔴 Fixture size for the anti-hang probe, and the ONLY thing that makes that probe able to
 * observe anything at all.
 *
 * `Upload` pulls eagerly: it absorbs roughly `queueSize * partSize` out of the `PassThrough`
 * before it stops reading — 20 MiB for these fixtures, whose estimate is small enough that the
 * derived part clamps to the 5 MiB minimum and the queue stays at 4. An archive SMALLER than that
 * window is fully absorbed and fully appended before the upload's first part can fail, so nothing
 * is ever parked on the pending-entry ceiling and the report fails correctly whether or not the
 * producer is actually stopped. Measured: at
 * `ENTRY_COUNT` (73 x 192 KiB = 13.7 MiB) the probe settles in under a second against code with
 * the hang fully present. It was testing nothing.
 *
 * 160 x 192 KiB = 30 MiB is comfortably past that window, so the archiver is still mid-archive
 * with `append()` callers parked when the upload rejects — which is the state the defect strands
 * forever. Asserted in the test rather than trusted from this comment, and asserted against the
 * geometry THIS RUN derives rather than the default pair, because the window moves with the
 * size estimate as well as with the two clamps.
 *
 * Wall clock, measured on this file: the two anti-hang probes cost ~0.7 s of ~5 s of test time
 * across 8 tests. Most of the larger fixture is free because `entryBytes` caches per index and
 * the first three tests have already generated indices 0..72.
 */
const HANG_PROBE_ENTRY_COUNT = 160;

function fakeBlob(index: number) {
  const buffer = entryBytes(index);
  return {
    type: 'image/jpeg',
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

/** Name the service derives for image row `i` — `picture-<i>.jpeg` minus its extension, plus the blob's. */
const entryNameForIndex = (index: number) => `picture-${index}.jpeg`;

type InventoryEntry = { name: string; size: number; sha256: string };

/**
 * The comparable content of an archive: what is in it, how big each thing is, and what each
 * thing's bytes are. Everything a zip records ABOUT an entry that is not its content — the
 * per-entry modification time above all — is excluded, because it legitimately differs between
 * two correct runs and would make a byte-comparison of the archives useless.
 */
async function zipInventory(bytes: Buffer): Promise<InventoryEntry[]> {
  const zip = await JSZip.loadAsync(bytes);
  const out: InventoryEntry[] = [];
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.files[name];
    if (file.dir) continue;
    const content = await file.async('nodebuffer');
    out.push({
      name,
      size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return out;
}

/** What the inventory MUST be, derived from the fixture rather than from either code path. */
function expectedInventory(): InventoryEntry[] {
  return Array.from({ length: ENTRY_COUNT }, (_, i) => ({
    name: entryNameForIndex(i),
    size: ENTRY_BYTES,
    sha256: createHash('sha256').update(entryBytes(i)).digest('hex'),
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const report = {
  id: 4242,
  userId: 909090,
  reportedById: 5,
  reportId: 77,
  type: 'Image',
  details: {},
  images: [],
};

function seedDb(entryCount: number = ENTRY_COUNT) {
  const rows = Array.from({ length: entryCount }, (_, i) => ({
    id: i + 1,
    url: `image-uuid-${i}`,
    name: entryNameForIndex(i),
    type: 'image',
    width: 1024,
    userId: report.userId,
  }));
  dbMock.dbRead.image.findMany.mockImplementation(
    async (args: { where?: { id?: { gt?: number } }; take?: number } = {}) => {
      const after = args.where?.id?.gt ?? 0;
      return rows.filter((r) => r.id > after).slice(0, args.take ?? rows.length);
    }
  );
  dbMock.dbRead.image.count.mockResolvedValue(entryCount);
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

/** Runs one full archive, with the streaming flag in the given state, and returns the stored zip. */
async function runArchive(streaming: boolean) {
  storedObjects.clear();
  pendingUploads.clear();
  const flagsSeen: unknown[] = [];
  mockIsFlipt = async (flag: unknown) => {
    flagsSeen.push(flag);
    return flag === FLIPT_FEATURE_FLAGS.CSAM_ARCHIVE_STREAM_UPLOAD ? streaming : false;
  };

  await archiveCsamDataForReport(report as never);

  const stored = storedObjects.get('images.zip');
  return { stored, flagsSeen };
}

/**
 * Deadline for the two anti-hang probes, and the runner timeout that has to sit above it.
 *
 * Raced against a timer rather than left to the runner's own timeout, so that a hang reports as
 * the named outcome `'HUNG'` with a message attached instead of as an anonymous "test timed out",
 * which reads like a slow fixture rather than like the defect. These archives settle in about a
 * second when the producer is actually stopped, so 30 s is not a timing assertion — it is the
 * difference between settling and never settling.
 */
const HANG_DEADLINE_MS = 30_000;
const HANG_TEST_TIMEOUT_MS = 90_000;

/** Runs one report and reports whether it SETTLED at all, rather than waiting on it forever. */
async function settleOrHang(reportArg: unknown) {
  let timer: NodeJS.Timeout | undefined;
  let thrown: unknown;
  const outcome = await Promise.race([
    archiveCsamDataForReport(reportArg as never).then(
      () => 'resolved' as const,
      (e: unknown) => {
        thrown = e;
        return 'rejected' as const;
      }
    ),
    new Promise<'HUNG'>((resolve) => {
      timer = setTimeout(() => resolve('HUNG'), HANG_DEADLINE_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { outcome, thrown };
}

beforeEach(() => {
  storedObjects.clear();
  pendingUploads.clear();
  mockFetchBlob = async (url: unknown) => {
    const match = /image-uuid-(\d+)/.exec(String(url));
    if (!match) return null;
    return fakeBlob(Number(match[1]));
  };
  mockGetConsumerStrikes = async () => [];
  mockIsFlipt = async () => false;
  setEnv({
    CSAM_UPLOAD_KEY: 'test-key',
    CSAM_UPLOAD_SECRET: 'test-secret',
    CSAM_UPLOAD_REGION: 'test-region',
    CSAM_UPLOAD_ENDPOINT: 'https://example.invalid',
    CSAM_BUCKET_NAME: 'test-bucket',
  });
  seedDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

afterAll(() => {
  fs.rmSync(path.dirname(csamBaseDir), { recursive: true, force: true });
});

describe('csam archive streaming upload', () => {
  it('produces a content inventory identical to the disk-staged path, over a real multipart upload', async () => {
    const disk = await runArchive(false);
    const streamed = await runArchive(true);

    // ---- Positive controls, first. Every claim below is about the content of these objects; if
    // either is missing the comparison is between two `undefined`s and passes for the wrong reason.
    expect(
      disk.stored,
      'the disk-staged path stored no images.zip — probe wired to nothing'
    ).toBeDefined();
    expect(
      streamed.stored,
      'the streaming path stored no images.zip — probe wired to nothing'
    ).toBeDefined();
    expect(disk.stored!.body.length).toBeGreaterThan(0);
    expect(streamed.stored!.body.length).toBeGreaterThan(0);

    // ---- The flag was actually consulted. Without this, a wiring mistake that never reads the
    // flag makes both runs take the same path and the equivalence assertion is a tautology.
    expect(disk.flagsSeen).toContain(FLIPT_FEATURE_FLAGS.CSAM_ARCHIVE_STREAM_UPLOAD);
    expect(streamed.flagsSeen).toContain(FLIPT_FEATURE_FLAGS.CSAM_ARCHIVE_STREAM_UPLOAD);

    // ---- Multipart really happened. `partCount === 0` means a single-shot PutObject, i.e. the
    // fixture compressed away and this file proves nothing about part splitting or reassembly.
    expect(
      streamed.stored!.partCount,
      'the streaming upload was single-shot — the fixture is too small or too compressible to exercise multipart'
    ).toBeGreaterThanOrEqual(2);
    expect(disk.stored!.partCount).toBeGreaterThanOrEqual(2);
    // Every part but the last is exactly one part size, and the last is short. That is the shape
    // S3 requires, and it pins that the geometry chosen really reached the uploader.
    const streamedParts = streamed.stored!.partSizes;
    for (const size of streamedParts.slice(0, -1)) expect(size).toBe(S3_MIN_PART_SIZE_BYTES);
    expect(streamedParts.at(-1)).toBeLessThanOrEqual(S3_MIN_PART_SIZE_BYTES);

    const diskInventory = await zipInventory(disk.stored!.body);
    const streamedInventory = await zipInventory(streamed.stored!.body);

    // ---- The absolute check. Comparing the two paths to each other cannot see a defect they
    // SHARE; this compares each to the bytes the fixture generated, which neither path produced.
    const expected = expectedInventory();
    expect(diskInventory).toEqual(expected);
    expect(streamedInventory).toEqual(expected);

    // ---- The equivalence claim itself.
    expect(streamedInventory).toEqual(diskInventory);
  });

  it('never opens a local write stream for the archive when streaming', async () => {
    // The whole point of the change is that the archive does not touch the scratch volume, and
    // an inventory comparison cannot see that — a path that staged to disk AND streamed would
    // pass every assertion above. This pins the disk write itself.
    const writeStreamSpy = vi.spyOn(fs, 'createWriteStream');

    await runArchive(true);
    const streamedArchiveWrites = writeStreamSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith('_images.zip')
    );

    writeStreamSpy.mockClear();
    await runArchive(false);
    const diskArchiveWrites = writeStreamSpy.mock.calls.filter((call) =>
      String(call[0]).endsWith('_images.zip')
    );

    // Positive control on the spy: the disk path MUST show a write, or a spy wired to nothing
    // would report zero for both runs and the real assertion would pass vacuously.
    expect(
      diskArchiveWrites.length,
      'the disk path opened no write stream — the spy is wired to nothing'
    ).toBe(1);
    expect(streamedArchiveWrites.length).toBe(0);
  });

  it('leaves the flag default OFF, so an unreachable Flipt keeps the disk path', async () => {
    // `isFlipt` returns false for an unknown flag or an unreachable Flipt. Reproduce that state
    // rather than asserting the enum value, so this fails if the gate is ever inverted.
    mockIsFlipt = async () => false;
    const writeStreamSpy = vi.spyOn(fs, 'createWriteStream');

    await archiveCsamDataForReport(report as never);

    expect(
      writeStreamSpy.mock.calls.filter((c) => String(c[0]).endsWith('_images.zip')).length
    ).toBe(1);
    expect(storedObjects.get('images.zip')).toBeDefined();
  });

  // -------------------------------------------------------------------------------------------
  // "The rollback is a flag flip" — only true if the flag-OFF path behaves as it did before this
  // change. TWO things arrived with it and both have to be gated, not just the choice of sink:
  // the `image.count` round trip, and the derived part geometry it feeds.
  //
  // 🔴 DELIBERATELY TWO TESTS, NOT ONE. Written as a single test the two assertions are not
  // independently reachable: the count gate ALONE is enough to keep an estimate away from the
  // disk path on the images route, so the geometry assertion sits downstream of a check that
  // already failed and can never be observed dying on its own. Measured — un-gating only the
  // `expectedBytes` argument left a combined test GREEN. Splitting them, and routing the
  // geometry one through `generated-images` (whose caller passes an estimate unconditionally,
  // with no count query in front of it), makes each die to its own mutation.
  // -------------------------------------------------------------------------------------------

  it('🔴 issues no image-count round trip when the flag is OFF', async () => {
    // The count is a new query against the main database bought solely to size upload parts. On
    // the path that does not size parts it must not happen at all.
    dbMock.dbRead.image.count.mockClear();
    mockIsFlipt = async () => false;

    await archiveCsamDataForReport(report as never);

    expect(
      storedObjects.get('images.zip'),
      'the disk path stored no images.zip — probe wired to nothing'
    ).toBeDefined();
    expect(
      dbMock.dbRead.image.count.mock.calls.length,
      'the flag-off path issued the image count query that only the streaming geometry needs'
    ).toBe(0);

    // ---- Positive control, in-band. A zero is indistinguishable from a counter wired to
    // nothing, so the SAME counter has to be shown moving on the path that does need it.
    storedObjects.clear();
    pendingUploads.clear();
    dbMock.dbRead.image.count.mockClear();
    mockIsFlipt = async (flag: unknown) => flag === FLIPT_FEATURE_FLAGS.CSAM_ARCHIVE_STREAM_UPLOAD;

    await archiveCsamDataForReport(report as never);

    expect(
      dbMock.dbRead.image.count.mock.calls.length,
      'the streaming path did not issue the count query either — the zero asserted above is a ' +
        'fact about the spy, not about the gate'
    ).toBe(1);
  }, 30_000);

  it('🔴 keeps the flag-OFF path on the pre-change fixed part geometry', async () => {
    // Routed through `generated-images` because its caller derives `expectedBytes` from an array
    // length it already has and passes it WHATEVER the flag says — so `archiveAndUpload`'s disk
    // branch dropping it is the only thing standing between the rollback path and a derived part
    // size. That makes this assertion reachable, which the images route does not.
    //
    // Made OBSERVABLE by a large estimate over a small archive: `expectedBytes` counts every URL,
    // while only the ones that actually fetch become entries. At ~1.4 MiB/entry x 30,000 URLs the
    // derived part size is ~17 MiB — larger than the ~14 MiB archive — so a leaked estimate
    // collapses the upload to a single part (or a one-shot `PutObject`, `partCount === 0`).
    // The fixed 5 MiB geometry gives several parts instead.
    const REAL_URLS = ENTRY_COUNT;
    const TOTAL_URLS = 30_000;
    const urls = Array.from({ length: TOTAL_URLS }, (_, i) =>
      i < REAL_URLS
        ? `https://example.invalid/image-uuid-${i}`
        : `https://example.invalid/absent-${i}`
    );
    mockGetConsumerStrikes = async () => [
      { strikes: [{ job: { blobs: urls.map((previewUrl) => ({ previewUrl })) } }] },
    ];
    mockIsFlipt = async () => false;

    await archiveCsamDataForReport({ ...report, type: 'GeneratedImage' } as never);

    const stored = storedObjects.get('generated-images.zip');
    expect(
      stored,
      'the disk path stored no generated-images.zip — probe wired to nothing'
    ).toBeDefined();
    // Positive control on the fixture: the archive has to be big enough that a leaked part size
    // would actually change its shape. An empty archive would satisfy the assertion below by
    // accident.
    expect(stored!.body.length).toBeGreaterThan(S3_MIN_PART_SIZE_BYTES);

    expect(
      stored!.partCount,
      `the flag-off path uploaded in ${stored!.partCount} part(s) — it was handed a part size ` +
        'derived from the size estimate instead of the fixed 5 MiB it used before this change, ' +
        'so "rollback is a flag flip" is false on the dimension that caused the eviction'
    ).toBeGreaterThanOrEqual(2);
    for (const size of stored!.partSizes.slice(0, -1)) expect(size).toBe(S3_MIN_PART_SIZE_BYTES);
  }, 30_000);

  it(
    '🔴 surfaces an upload failure MID-ARCHIVE instead of hanging the report',
    async () => {
      // THE REGRESSION. A failed upload stops draining the `PassThrough`, so the producer has to be
      // stopped explicitly or the archiver's parked `append()` callers are never released and the
      // report hangs forever rather than failing — the worst of the available outcomes for a job,
      // and the outcome (evidence archival stalled indefinitely) this whole change exists to end.
      //
      // 🔴 THE FIXTURE SIZE IS THE TEST. At `ENTRY_COUNT` this probe is VACUOUS: the uploader
      // absorbs the entire archive before its first part can fail, so the producer is already done
      // and there is nothing to strand. Asserted, not assumed — if a future geometry change widens
      // the absorption window past the fixture, this fails loudly instead of going quietly
      // meaningless.
      //
      // 🔴 DERIVED, NOT `MAX_UPLOAD_QUEUE_SIZE * S3_MIN_PART_SIZE_BYTES`. Those two constants are
      // the DEFAULT geometry; the run under test uses the geometry the service derives from
      // `imageCount * ESTIMATED_BYTES_PER_ARCHIVED_IMAGE`, and the two coincide only while that
      // estimate is small enough to clamp to the 5 MiB minimum. Asserting the default pins
      // nothing about the run: raising `ESTIMATED_BYTES_PER_ARCHIVED_IMAGE` far enough to make the
      // derived part 8.19 MiB widens the real window to 32.8 MiB — past this 30 MiB fixture —
      // while the default-geometry form still reads 20 MiB and stays green with the hang fully
      // reintroduced. Measured: that two-part mutation left all 8 tests in this file passing
      // against the default form, and fails HERE against the derived one.
      //
      // ⚠️ It is still a SECOND COPY of the service's estimate expression (`archiveImages` passes
      // `imageCount * ESTIMATED_BYTES_PER_ARCHIVED_IMAGE`), not an observation of the geometry the
      // run used — the check has to hold before the run starts, and the derived pair goes straight
      // into the real SDK `Upload` inside the service, where the fake client never sees
      // `queueSize`. The imported constants keep the two copies in step, so a constant change is
      // covered; a change to the EXPRESSION is not, and would leave this guard bounding a run that
      // no longer happens.
      const absorbedBeforeStalling = deriveUploadPartGeometry({
        expectedBytes: HANG_PROBE_ENTRY_COUNT * ESTIMATED_BYTES_PER_ARCHIVED_IMAGE,
      }).worstCaseResidentBytes;
      expect(
        HANG_PROBE_ENTRY_COUNT * ENTRY_BYTES,
        `fixture (${
          HANG_PROBE_ENTRY_COUNT * ENTRY_BYTES
        } bytes) no longer exceeds what the uploader ` +
          `absorbs before it stops reading at THIS RUN'S derived geometry ` +
          `(${absorbedBeforeStalling} bytes) — this probe cannot observe a stalled producer and ` +
          `proves nothing`
      ).toBeGreaterThan(absorbedBeforeStalling);

      seedDb(HANG_PROBE_ENTRY_COUNT);

      const failure = new Error('multipart upload rejected');
      const realSend = FakeS3Client.prototype.send;
      vi.spyOn(FakeS3Client.prototype, 'send').mockImplementation(async function (
        this: FakeS3Client,
        command: Parameters<typeof realSend>[0]
      ) {
        if (command.constructor.name === 'UploadPartCommand') throw failure;
        return realSend.call(this, command);
      });

      mockIsFlipt = async (flag: unknown) =>
        flag === FLIPT_FEATURE_FLAGS.CSAM_ARCHIVE_STREAM_UPLOAD;

      const { outcome, thrown } = await settleOrHang(report);

      expect(
        outcome,
        'the report never settled — an upload that fails mid-archive leaves the archiver alive with ' +
          'its pending-entry waiters parked forever, which is the defect this pins'
      ).toBe('rejected');
      expect((thrown as Error).message).toMatch(/images\.zip/);
    },
    HANG_TEST_TIMEOUT_MS
  );

  it(
    '🔴 surfaces a SINK failure mid-archive on the flag-OFF path instead of hanging',
    async () => {
      // THE SAME DEFECT ON THE ROLLBACK TARGET, and the reason it matters: the flag-off path stages
      // to the container's scratch volume, so its sink fails mid-archive exactly when that volume
      // fills — which is this incident's own condition. A rollback target that hangs is not a
      // rollback, so both sinks have to carry a producer-stopping link, not just the streaming one.
      //
      // Same size reasoning as the probe above: the sink accepts 1 MiB before failing, so the
      // archiver is still mid-archive with `append()` callers parked when it does.
      seedDb(HANG_PROBE_ENTRY_COUNT);
      mockIsFlipt = async () => false;

      const sinkFailure = new Error('simulated sink failure: no space left on device');
      const realCreateWriteStream = fs.createWriteStream;
      vi.spyOn(fs, 'createWriteStream').mockImplementation(((
        target: unknown,
        ...rest: unknown[]
      ) => {
        // Only the media archive's sink is replaced. `data.json` still goes through a real write
        // stream, so the run reaches the archive step the way it normally would.
        if (!String(target).endsWith('_images.zip'))
          return (realCreateWriteStream as (...a: unknown[]) => unknown)(target, ...rest);
        let accepted = 0;
        return new Writable({
          write(chunk: Buffer, _encoding, callback) {
            accepted += chunk.length;
            if (accepted > 1024 * 1024) return callback(sinkFailure);
            callback();
          },
        });
      }) as never);

      const { outcome, thrown } = await settleOrHang(report);

      expect(
        outcome,
        'the report never settled — a write stream that dies mid-archive leaves the archiver alive ' +
          'with its pending-entry waiters parked forever, so a full scratch volume stalls the ' +
          'report instead of failing it'
      ).toBe('rejected');
      // The sink's own error is what should come out: nothing downstream reinterprets it, and it is
      // the only thing that names the real fault.
      expect((thrown as Error).message).toBe(sinkFailure.message);
    },
    HANG_TEST_TIMEOUT_MS
  );

  it('reports the ORIGINAL failure when the archive fails, not the upload it knocks over', async () => {
    // Tearing the sink down to fail the report also makes the in-flight upload fail, so BOTH
    // errors exist by the time anything is rethrown. Reporting the upload's would bury every
    // fetch/DB failure on this path behind a generic "failed to upload", pointing whoever reads
    // the job log at object storage for a fault that was never there.
    const failure = new Error('blob fetch exploded');
    mockFetchBlob = async (url: unknown) => {
      const match = /image-uuid-(\d+)/.exec(String(url));
      if (!match) return null;
      if (Number(match[1]) === 11) throw failure;
      return fakeBlob(Number(match[1]));
    };
    mockIsFlipt = async (flag: unknown) => flag === FLIPT_FEATURE_FLAGS.CSAM_ARCHIVE_STREAM_UPLOAD;

    const rejection = await archiveCsamDataForReport(report as never).then(
      () => undefined,
      (e: unknown) => e
    );

    // Positive control: something must actually have failed, or both assertions below are
    // assertions about `undefined`.
    expect(
      rejection,
      'the archive did not fail — the fault injection is wired to nothing'
    ).toBeDefined();
    expect((rejection as Error).message).toBe(failure.message);
    expect((rejection as Error).message).not.toMatch(/failed to upload/);
  }, 20_000);
});

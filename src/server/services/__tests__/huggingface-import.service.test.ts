import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as HuggingFaceService from '~/server/services/huggingface.service';
import type * as S3Utils from '~/utils/s3-utils';

const {
  mockReadRange,
  mockHeadFile,
  mockUploadPart,
  mockCreateMultipart,
  mockComplete,
  mockAbort,
  mockDeleteObject,
  mockUrlsSafeToDelete,
} = vi.hoisted(() => ({
  mockReadRange: vi.fn(),
  mockHeadFile: vi.fn(),
  mockUploadPart: vi.fn(),
  mockCreateMultipart: vi.fn(),
  mockComplete: vi.fn(),
  mockAbort: vi.fn(),
  mockDeleteObject: vi.fn(),
  mockUrlsSafeToDelete: vi.fn(),
}));

vi.mock('~/server/services/huggingface.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HuggingFaceService>()),
  readHuggingFaceRange: mockReadRange,
  headHuggingFaceFile: mockHeadFile,
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getS3Client: () => ({}),
  getUploadS3Client: () => ({}),
  getUploadBucket: () => 'model-bucket',
  getBucket: async () => 'model-bucket',
  getGetUrlByKey: async (key: string, opts: { bucket?: string }) => ({
    key,
    bucket: opts.bucket,
    url: `https://s3.example/${opts.bucket}/${key}?X-Amz-Signature=abc`,
  }),
  createMultipartUpload: mockCreateMultipart,
  uploadPart: mockUploadPart,
  completeMultipartUpload: mockComplete,
  abortMultipartUpload: mockAbort,
  deleteObject: mockDeleteObject,
  urlsSafeToDelete: mockUrlsSafeToDelete,
}));

import { parseHuggingFaceRepo, suggestFileType } from '~/server/services/huggingface.service';
import {
  getHuggingFaceImportConfig,
  HUGGING_FACE_IMPORT_DEFAULTS,
  setHuggingFaceImportConfig,
} from '~/server/services/huggingface-import-config.service';
import {
  deleteImport,
  getImportCounts,
  getImports,
  PART_SIZE_BYTES,
  processImportQueue,
  renameGroup,
} from '~/server/services/huggingface-import.service';

/** The width under test. Passed in rather than read from config, so these tests do not depend on
 *  what an operator has set in Redis. */
const TEST_PARTS_IN_FLIGHT = 3;

const sysRedisMock = redisMock.sysRedis;
const dbWrite = dbMock.dbWrite;
const dbRead = dbMock.dbRead;

// Tracks the real constant rather than restating it — a part-size change should not need a test edit.
const PART_SIZE = PART_SIZE_BYTES;

/** A claim that yields the given row once, then nothing — so the drain loop always terminates. */
function claimOnce(row: Record<string, unknown>) {
  let served = false;
  dbWrite.$queryRaw.mockImplementation(async () => {
    if (served) return [];
    served = true;
    return [row];
  });
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    repo: 'owner/name',
    filename: 'model.safetensors',
    sourceUrl: 'https://huggingface.co/owner/name/resolve/abc123/model.safetensors',
    sizeBytes: BigInt(PART_SIZE * 2 + 100),
    status: 'Transferring',
    uploadId: null,
    partSize: null,
    parts: null,
    bucket: null,
    key: null,
    attempts: 0,
    userId: 7,
    claimedBy: 'test-worker',
    ...overrides,
  };
}

describe('parseHuggingFaceRepo', () => {
  it.each([
    ['https://huggingface.co/owner/name', 'owner/name', undefined],
    ['https://huggingface.co/owner/name/tree/abc123', 'owner/name', 'abc123'],
    ['https://huggingface.co/owner/name/blob/abc123/model.safetensors', 'owner/name', 'abc123'],
    ['https://huggingface.co/models/owner/name', 'owner/name', undefined],
    ['owner/name', 'owner/name', undefined],
  ])('reads %s', (input, repo, revision) => {
    expect(parseHuggingFaceRepo(input)).toEqual(revision ? { repo, revision } : { repo });
  });

  it.each(['', 'https://huggingface.co/owner', 'not a url'])('rejects %s', (input) => {
    expect(parseHuggingFaceRepo(input)).toBeNull();
  });
});

describe('processImportQueue', () => {
  // Restoring here, not at the end of the test that spies on Date.now: an assertion throwing above
  // that line would leave the clock frozen for every later test in the file.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMultipart.mockResolvedValue('upload-1');
    mockUploadPart.mockImplementation(
      async ({ partNumber }: { partNumber: number }) => `etag-${partNumber}`
    );
    mockComplete.mockResolvedValue(undefined);
    mockReadRange.mockImplementation(
      async ({ start, end }: { start: number; end: number }) => new Uint8Array(end - start + 1)
    );
    dbRead.huggingFaceImport.findUnique.mockResolvedValue({ status: 'Transferring' });
    // The pre-complete re-read goes to the PRIMARY: a cancel written there must be visible before
    // the upload is finalized, and replica lag would make the check decorative.
    dbWrite.huggingFaceImport.findUnique.mockResolvedValue({
      status: 'Transferring',
      claimedBy: 'test-worker',
    });
    dbWrite.huggingFaceImport.update.mockResolvedValue({});
    dbWrite.huggingFaceImport.updateMany.mockResolvedValue({ count: 1 });
  });

  it('splits the file into parts on exact byte boundaries and completes the upload', async () => {
    claimOnce(baseRow());

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    const ranges = mockReadRange.mock.calls.map(([arg]) => [arg.start, arg.end]);
    expect(ranges).toEqual([
      [0, PART_SIZE - 1],
      [PART_SIZE, PART_SIZE * 2 - 1],
      // The tail part is short, and its end is the LAST byte — an off-by-one here silently truncates
      // or over-reads every import.
      [PART_SIZE * 2, PART_SIZE * 2 + 99],
    ]);

    expect(mockComplete).toHaveBeenCalledWith(
      'model-bucket',
      expect.stringMatching(/^model\/7\/model\./),
      'upload-1',
      [
        { PartNumber: 1, ETag: 'etag-1' },
        { PartNumber: 2, ETag: 'etag-2' },
        { PartNumber: 3, ETag: 'etag-3' },
      ],
      expect.anything()
    );
  });

  it('heartbeats on every part so a live transfer is never re-claimed as stale', async () => {
    claimOnce(baseRow());

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    // Two runs holding their own parts arrays against one uploadId is what the heartbeat prevents;
    // no other assertion in this file fails if the write is deleted.
    const partWrites = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg)
      .filter((arg: { data: Record<string, unknown> }) => 'parts' in arg.data);
    expect(partWrites).toHaveLength(3);
    for (const write of partWrites) {
      expect(write.data.heartbeatAt).toBeInstanceOf(Date);
      expect(write.where.claimedBy).toBe('test-worker');
    }
  });

  it('stores the object URL with the presigning query stripped', async () => {
    claimOnce(baseRow());

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    const completed = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg.data)
      .find((data: Record<string, unknown>) => data.status === 'Completed');
    expect(completed?.url).toMatch(/^https:\/\/s3\.example\/model-bucket\/model\/7\/model\./);
    expect(completed?.url).not.toContain('?');
    // Spent. A retained uploadId makes every later abort attempt fail against a finished upload,
    // which buries the one abort failure that means parts are still billed.
    expect(completed?.uploadId).toBeNull();

    // The pre-complete re-read is one guard against a late cancel; this predicate is the other, and
    // it covers the window between that read and this write. Dropping it is invisible to the cancel
    // test, which the read alone already satisfies.
    const completedWhere = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg)
      .find((arg: { data: Record<string, unknown> }) => arg.data.status === 'Completed')?.where;
    expect(completedWhere).toMatchObject({
      claimedBy: 'test-worker',
      status: { not: 'Canceled' },
    });
  });

  it('resumes an interrupted transfer at the next part instead of restarting the file', async () => {
    // A bucket that is NOT what `uploadTarget()` resolves to: a resume must address the bucket the
    // upload was created in, and with both mocked getters returning the same string this was
    // unobservable — parts went to the current-config bucket while complete named the row's.
    claimOnce(
      baseRow({
        uploadId: 'upload-1',
        key: 'model/7/resume-me.safetensors',
        bucket: 'other-bucket',
        partSize: PART_SIZE,
        parts: [{ PartNumber: 1, ETag: 'etag-1' }],
      })
    );

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    expect(mockCreateMultipart).not.toHaveBeenCalled();
    for (const [arg] of mockUploadPart.mock.calls) {
      expect(arg.bucket).toBe('other-bucket');
      expect(arg.key).toBe('model/7/resume-me.safetensors');
    }
    expect(mockComplete.mock.calls[0][0]).toBe('other-bucket');
    expect(mockComplete.mock.calls[0][1]).toBe('model/7/resume-me.safetensors');
    expect(mockReadRange.mock.calls.map(([arg]) => arg.start)).toEqual([PART_SIZE, PART_SIZE * 2]);
    expect(mockComplete.mock.calls[0][3]).toHaveLength(3);
  });

  it('stops without completing when the deadline passes mid-file', async () => {
    claimOnce(baseRow({ sizeBytes: BigInt(PART_SIZE * 6) }));
    // The clock is moved past the deadline BY the first read rather than by a short real window: a
    // 1ms budget is missed outright on a loaded box, and the test then reads as "moved nothing".
    const deadline = Date.now() + 60_000;
    mockReadRange.mockImplementation(async ({ start, end }: { start: number; end: number }) => {
      vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      return new Uint8Array(end - start + 1);
    });

    await processImportQueue({
      deadline,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockUploadPart.mock.calls.length).toBeGreaterThan(0);
    expect(mockUploadPart.mock.calls.length).toBeLessThan(6);
  });

  it('resumes across a HOLE in the completed parts, not from their count', async () => {
    // Parts finish out of order, so part 2 can be missing while part 3 is done. Treating the array
    // length as "next part" would re-upload 2 as part 3 and silently corrupt the object.
    claimOnce(
      baseRow({
        uploadId: 'upload-1',
        key: 'model/7/model.abcd1234.safetensors',
        bucket: 'model-bucket',
        partSize: PART_SIZE,
        parts: [
          { PartNumber: 1, ETag: 'etag-1' },
          { PartNumber: 3, ETag: 'etag-3' },
        ],
      })
    );

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    expect(mockUploadPart.mock.calls.map(([arg]) => arg.partNumber)).toEqual([2]);
    // Completion demands ascending order regardless of the order they finished in.
    expect(mockComplete.mock.calls[0][3].map((p: { PartNumber: number }) => p.PartNumber)).toEqual([
      1, 2, 3,
    ]);
  });

  it('moves exactly as many parts at a time as it is told to', async () => {
    claimOnce(baseRow({ sizeBytes: BigInt(PART_SIZE * 6) }));

    // The barrier releases at PARTS_IN_FLIGHT and the assertion demands PARTS_IN_FLIGHT. Asserting
    // merely ">1" let a 3→2 change pass green: the hatch fired, everything unblocked, peak landed
    // on 2, and the only evidence was the test taking 250ms instead of 1ms — which nothing reads.
    let inFlight = 0;
    let peak = 0;
    let escaped = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const escapeHatch = setTimeout(() => {
      escaped = true;
      release();
    }, 250);

    mockReadRange.mockImplementation(async ({ start, end }: { start: number; end: number }) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (inFlight >= TEST_PARTS_IN_FLIGHT) release();
      await gate;
      inFlight--;
      return new Uint8Array(end - start + 1);
    });

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });
    clearTimeout(escapeHatch);

    // `escaped` is what makes this non-vacuous: a serial implementation never reaches the barrier,
    // falls through the hatch, and fails here in ~250ms. `peak === PARTS_IN_FLIGHT` pins that the
    // pool is as wide as configured — it cannot catch a deliberate change to the constant itself,
    // which is a sizing decision (see the memory note on PARTS_IN_FLIGHT), not a regression.
    expect(escaped).toBe(false);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBe(TEST_PARTS_IN_FLIGHT);
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it('refuses a short range read rather than writing a truncated part', async () => {
    claimOnce(baseRow());
    mockReadRange.mockResolvedValue(new Uint8Array(10));

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    expect(mockUploadPart).not.toHaveBeenCalled();
    const failure = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg.data)
      .find((data: Record<string, unknown>) => typeof data.error === 'string');
    expect(failure?.error).toContain('returned 10 bytes');
  });

  it('refuses to complete an upload that was canceled during the final part', async () => {
    claimOnce(baseRow());
    // The workers' probe runs BEFORE each takes its part, so the last worker never checks again.
    // Without the re-read here, a cancel landing in that window still finalized the object and
    // stamped Completed with a URL on a row the moderator had stopped.
    dbWrite.huggingFaceImport.findUnique.mockResolvedValue({
      status: 'Canceled',
      claimedBy: 'test-worker',
    });

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    expect(mockComplete).not.toHaveBeenCalled();
    const completed = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg.data)
      .find((data: Record<string, unknown>) => data.status === 'Completed');
    expect(completed).toBeUndefined();
  });

  it('refuses to complete when the claim has been taken by another run', async () => {
    claimOnce(baseRow());
    dbWrite.huggingFaceImport.findUnique.mockResolvedValue({
      status: 'Transferring',
      claimedBy: 'a-different-worker',
    });

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('stops a canceled import at the next part boundary', async () => {
    claimOnce(baseRow());
    dbRead.huggingFaceImport.findUnique.mockResolvedValue({ status: 'Canceled' });

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    expect(mockUploadPart).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe('suggestFileType', () => {
  it.each([
    // The case that matters: a checkpoint that merely names its bundled VAE is still the checkpoint.
    ['flux1-dev-vae-baked.safetensors', null],
    ['Vaevictis-v1.safetensors', null],
    ['flux1-dev-with-t5.safetensors', null],
    ['ae.safetensors', 'VAE'],
    ['vae/diffusion_pytorch_model.safetensors', 'VAE'],
    ['text_encoder_2/model-00001-of-00002.safetensors', 'Text Encoder'],
    ['t5xxl_fp16.safetensors', 'Text Encoder'],
    ['clip_l.safetensors', 'Text Encoder'],
    ['model_index.json', 'Config'],
    ['flux1-dev.safetensors', null],
  ])('%s -> %s', (path, expected) => {
    expect(suggestFileType(path)).toBe(expected);
  });
});

describe('failOrRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateMultipart.mockResolvedValue('upload-1');
    dbRead.huggingFaceImport.findUnique.mockResolvedValue({ status: 'Transferring' });
    dbWrite.huggingFaceImport.findUnique.mockResolvedValue({
      status: 'Transferring',
      claimedBy: 'test-worker',
    });
    dbWrite.huggingFaceImport.update.mockResolvedValue({});
    dbWrite.huggingFaceImport.updateMany.mockResolvedValue({ count: 1 });
  });

  const failingRead = () => mockReadRange.mockRejectedValue(new Error('HF said 503'));

  it('fences the failure write by the claim, exactly as the success path does', async () => {
    claimOnce(baseRow());
    failingRead();

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    // Without this the failure path hands the row back without checking the claim is still ours,
    // and a superseded run can release a row a live run is still transferring — the two-runs-one-
    // uploadId state the heartbeat guards against on the success path only.
    const failure = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg)
      .find((arg: { data: Record<string, unknown> }) => typeof arg.data.error === 'string');
    expect(failure?.where).toMatchObject({
      claimedBy: 'test-worker',
      status: { not: 'Canceled' },
    });
  });

  it('backs off rather than giving up while attempts remain', async () => {
    claimOnce(baseRow({ attempts: 0 }));
    failingRead();

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    const failure = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg.data)
      .find((data: Record<string, unknown>) => typeof data.error === 'string');
    expect(failure?.status).toBe('Transferring');
    expect(failure?.attempts).toBe(1);
    expect(failure?.nextAttemptAt).toBeInstanceOf(Date);
    expect((failure?.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(mockAbort).not.toHaveBeenCalled();
  });

  it('gives up on the last attempt and aborts the multipart upload', async () => {
    claimOnce(
      baseRow({
        attempts: 4,
        uploadId: 'upload-1',
        key: 'model/7/x.safetensors',
        bucket: 'model-bucket',
        partSize: PART_SIZE,
      })
    );
    failingRead();
    mockAbort.mockResolvedValue(undefined);

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    // An upload abandoned without an abort keeps every part already written, billed, with nothing
    // left holding the id needed to free them.
    expect(mockAbort).toHaveBeenCalledTimes(1);
    const failure = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg.data)
      .find((data: Record<string, unknown>) => typeof data.error === 'string');
    expect(failure?.status).toBe('Failed');
    expect(failure?.nextAttemptAt).toBeNull();
  });

  it('keeps the uploadId when the abort itself failed', async () => {
    claimOnce(
      baseRow({
        attempts: 4,
        uploadId: 'upload-1',
        key: 'model/7/x.safetensors',
        bucket: 'model-bucket',
        partSize: PART_SIZE,
      })
    );
    failingRead();
    mockAbort.mockRejectedValue(new Error('B2 unavailable'));

    await processImportQueue({
      deadline: Date.now() + 60_000,
      worker: 'test',
      concurrency: 1,
      partsInFlight: TEST_PARTS_IN_FLIGHT,
    });

    // Clearing it here would be the one thing that makes the orphaned parts unreclaimable.
    const failure = dbWrite.huggingFaceImport.updateMany.mock.calls
      .map(([arg]) => arg.data)
      .find((data: Record<string, unknown>) => typeof data.error === 'string');
    expect(failure).not.toHaveProperty('uploadId');
  });
});

describe('getImports filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbRead.huggingFaceImport.findMany.mockResolvedValue([]);
  });

  const whereOf = () => dbRead.huggingFaceImport.findMany.mock.calls[0][0].where;

  it('filters on the server, so results are not capped-then-filtered', async () => {
    await getImports({ userId: 7, isModerator: true, groupName: 'FLUX' });
    // The bug this replaces: both callers fetched `limit` rows and filtered in the client, so a
    // group older than that window returned nothing and looked like it had never been imported.
    expect(whereOf()).toMatchObject({
      groupName: { contains: 'FLUX', mode: 'insensitive' },
    });
  });

  it('matches a repo exactly rather than by substring', async () => {
    await getImports({ userId: 7, isModerator: true, repo: 'owner/name' });
    expect(whereOf().repo).toBe('owner/name');
  });

  it('adds no predicate when nothing is filtered', async () => {
    await getImports({ userId: 7, isModerator: true });
    expect(whereOf()).toEqual({});
  });

  it('still scopes a non-moderator to their own rows while filtering', async () => {
    await getImports({ userId: 7, isModerator: false, groupName: 'FLUX' });
    expect(whereOf().userId).toBe(7);
  });
});

describe('import config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sysRedisMock.packed.get.mockResolvedValue(null);
  });

  it('falls open to the defaults when the store cannot be read', async () => {
    sysRedisMock.packed.get.mockRejectedValue(new Error('redis down'));
    // A config store that cannot be read must not stop transfers, and must never resolve
    // concurrency to zero — both are worse than running at the shipped shape.
    await expect(getHuggingFaceImportConfig()).resolves.toEqual(HUGGING_FACE_IMPORT_DEFAULTS);
  });

  it('merges a partial stored value over the defaults', async () => {
    sysRedisMock.packed.get.mockResolvedValue({ partsInFlight: 1 });
    const config = await getHuggingFaceImportConfig();
    expect(config.partsInFlight).toBe(1);
    expect(config.filesInParallel).toBe(HUGGING_FACE_IMPORT_DEFAULTS.filesInParallel);
  });

  it('ignores a stored value that is out of bounds rather than obeying it', async () => {
    // The bounds are what stop a text box setting pod memory to gigabytes.
    sysRedisMock.packed.get.mockResolvedValue({ partsInFlight: 500 });
    await expect(getHuggingFaceImportConfig()).resolves.toEqual(HUGGING_FACE_IMPORT_DEFAULTS);
  });

  it('refuses to write a value outside the bounds', async () => {
    await expect(setHuggingFaceImportConfig({ filesInParallel: 99 })).rejects.toThrow();
    expect(sysRedisMock.packed.set).not.toHaveBeenCalled();
  });
});

describe('unattached and delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbRead.huggingFaceImport.findMany.mockResolvedValue([]);
  });

  it('defines unattached as completed with no model file', async () => {
    await getImports({ userId: 7, isModerator: true, unattached: true });
    expect(dbRead.huggingFaceImport.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'Completed',
      modelFileId: null,
    });
  });

  it('counts the unattached tab with the same predicate the tab lists', async () => {
    dbRead.huggingFaceImport.count.mockResolvedValue(0);
    await getImportCounts({ userId: 7, isModerator: true, groupName: 'krea' });

    const [unattachedWhere, totalWhere] = dbRead.huggingFaceImport.count.mock.calls.map(
      (call: [{ where: Record<string, unknown> }]) => call[0].where
    );
    // A label that counts a population the list is not showing is the bug this query exists to fix.
    expect(unattachedWhere).toMatchObject({
      status: 'Completed',
      modelFileId: null,
      groupName: { contains: 'krea', mode: 'insensitive' },
    });
    expect(totalWhere).toMatchObject({ groupName: { contains: 'krea', mode: 'insensitive' } });
    expect(totalWhere).not.toHaveProperty('modelFileId');
  });

  it('scopes the lookup to the owner when the caller is not a moderator', async () => {
    dbRead.huggingFaceImport.findFirst.mockResolvedValue(null);
    await expect(deleteImport({ id: 1, userId: 7, isModerator: false })).rejects.toThrow();
    expect(dbRead.huggingFaceImport.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 1,
      userId: 7,
    });
  });

  it('refuses to delete an import that is still attached', async () => {
    // Deleting here would leave a model version pointing at bytes that no longer exist.
    dbRead.huggingFaceImport.findFirst.mockResolvedValue({
      id: 1,
      status: 'Completed',
      bucket: 'b',
      key: 'k',
      url: 'https://s3.example/b/k',
      uploadId: null,
      modelFileId: 99,
    });
    await expect(deleteImport({ id: 1, userId: 7, isModerator: true })).rejects.toThrow();
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(dbWrite.huggingFaceImport.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses to delete a DETACHED import a model file still points at', async () => {
    // The two-click data-loss path: detach leaves the ModelFile alive, so the row lands in the
    // unattached list while a published version is still serving those exact bytes. `modelFileId`
    // is a local pointer; the refcount over `ModelFile.url` is the global one.
    dbRead.huggingFaceImport.findFirst.mockResolvedValue({
      id: 1,
      status: 'Completed',
      bucket: 'b2-transfer-bucket',
      key: 'model/7/x.safetensors',
      url: 'https://s3.example/b2-transfer-bucket/model/7/x.safetensors',
      uploadId: null,
      modelFileId: null,
    });
    mockUrlsSafeToDelete.mockResolvedValue({ safe: [], skipped: 1 });

    await expect(deleteImport({ id: 1, userId: 7, isModerator: true })).rejects.toThrow(
      /model file still points at/i
    );
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(dbWrite.huggingFaceImport.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses to delete a transfer that is still running', async () => {
    dbRead.huggingFaceImport.findFirst.mockResolvedValue({
      id: 1,
      status: 'Transferring',
      bucket: 'b',
      key: 'k',
      url: null,
      uploadId: 'u',
      modelFileId: null,
    });
    await expect(deleteImport({ id: 1, userId: 7, isModerator: true })).rejects.toThrow();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it('frees the object before removing the row', async () => {
    dbRead.huggingFaceImport.findFirst.mockResolvedValue({
      id: 1,
      status: 'Completed',
      // Deliberately NOT what the env resolves to: these bytes are in the bucket the transfer used.
      bucket: 'b2-transfer-bucket',
      key: 'model/7/x.safetensors',
      url: 'https://s3.example/b2-transfer-bucket/model/7/x.safetensors',
      uploadId: null,
      modelFileId: null,
    });
    mockUrlsSafeToDelete.mockResolvedValue({ safe: ['https://s3.example/x'], skipped: 0 });
    mockDeleteObject.mockResolvedValue(undefined);
    dbWrite.huggingFaceImport.deleteMany.mockResolvedValue({ count: 1 });

    await deleteImport({ id: 1, userId: 7, isModerator: true });

    expect(mockDeleteObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteObject).toHaveBeenCalledWith(
      'b2-transfer-bucket',
      'model/7/x.safetensors',
      expect.anything()
    );
    // The predicate rides into the write, because the read was against the replica.
    expect(dbWrite.huggingFaceImport.deleteMany).toHaveBeenCalledWith({
      where: { id: 1, modelFileId: null },
    });
    // Named for the ordering, so it asserts the ordering rather than leaning on the sibling test.
    expect(mockDeleteObject.mock.invocationCallOrder[0]).toBeLessThan(
      dbWrite.huggingFaceImport.deleteMany.mock.invocationCallOrder[0]
    );
  });

  it('aborts a live multipart before forgetting the row', async () => {
    // A Failed row can still hold an uploadId, and the row is the only handle that can free the
    // parts already uploaded — which are billed until something aborts them.
    dbRead.huggingFaceImport.findFirst.mockResolvedValue({
      id: 1,
      status: 'Failed',
      bucket: 'b2-transfer-bucket',
      key: 'model/7/x.safetensors',
      url: null,
      uploadId: 'upload-1',
      modelFileId: null,
    });
    mockAbort.mockResolvedValue(undefined);
    mockDeleteObject.mockResolvedValue(undefined);
    dbWrite.huggingFaceImport.deleteMany.mockResolvedValue({ count: 1 });

    await deleteImport({ id: 1, userId: 7, isModerator: true });

    expect(mockAbort).toHaveBeenCalledWith(
      'b2-transfer-bucket',
      'model/7/x.safetensors',
      'upload-1',
      expect.anything()
    );
  });

  it('keeps the row when the multipart abort fails', async () => {
    dbRead.huggingFaceImport.findFirst.mockResolvedValue({
      id: 1,
      status: 'Failed',
      bucket: 'b2-transfer-bucket',
      key: 'model/7/x.safetensors',
      url: null,
      uploadId: 'upload-1',
      modelFileId: null,
    });
    mockAbort.mockRejectedValue(new Error('B2 unavailable'));

    await expect(deleteImport({ id: 1, userId: 7, isModerator: true })).rejects.toThrow();
    expect(dbWrite.huggingFaceImport.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps the row when the object could not be deleted', async () => {
    // Otherwise the bytes stay in the bucket with nothing left pointing at them.
    dbRead.huggingFaceImport.findFirst.mockResolvedValue({
      id: 1,
      status: 'Completed',
      bucket: 'b2-transfer-bucket',
      key: 'model/7/x.safetensors',
      url: 'https://s3.example/b2-transfer-bucket/model/7/x.safetensors',
      uploadId: null,
      modelFileId: null,
    });
    mockUrlsSafeToDelete.mockResolvedValue({ safe: ['https://s3.example/x'], skipped: 0 });
    mockDeleteObject.mockRejectedValue(new Error('B2 unavailable'));

    await expect(deleteImport({ id: 1, userId: 7, isModerator: true })).rejects.toThrow();
    expect(dbWrite.huggingFaceImport.deleteMany).not.toHaveBeenCalled();
  });
});

describe('renameGroup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const input = {
    repo: 'owner/name',
    revision: 'abc123',
    from: 'flux-krea',
    groupName: 'FLUX Krea',
    userId: 7,
    isModerator: true,
  };

  it('renames only the rows of the named group, whatever their status', async () => {
    dbWrite.huggingFaceImport.updateMany.mockResolvedValue({ count: 3 });

    await expect(renameGroup(input)).resolves.toEqual({ renamed: 3, groupName: 'FLUX Krea' });

    const { where, data } = dbWrite.huggingFaceImport.updateMany.mock.calls[0][0];
    // The current name is part of the scope: one repo at one revision can be two batches.
    expect(where).toEqual({ repo: 'owner/name', revision: 'abc123', groupName: 'flux-krea' });
    expect(data).toEqual({ groupName: 'FLUX Krea' });
  });

  it('scopes to the owner when the caller is not a moderator', async () => {
    dbWrite.huggingFaceImport.updateMany.mockResolvedValue({ count: 1 });

    await renameGroup({ ...input, isModerator: false });

    expect(dbWrite.huggingFaceImport.updateMany.mock.calls[0][0].where).toMatchObject({
      userId: 7,
    });
  });

  it('trims the new name', async () => {
    dbWrite.huggingFaceImport.updateMany.mockResolvedValue({ count: 1 });

    await renameGroup({ ...input, groupName: '  FLUX Krea  ' });

    expect(dbWrite.huggingFaceImport.updateMany.mock.calls[0][0].data).toEqual({
      groupName: 'FLUX Krea',
    });
  });

  it('refuses an empty name without writing', async () => {
    await expect(renameGroup({ ...input, groupName: '   ' })).rejects.toThrow();
    expect(dbWrite.huggingFaceImport.updateMany).not.toHaveBeenCalled();
  });

  it('writes nothing when the name is unchanged', async () => {
    await expect(renameGroup({ ...input, groupName: 'flux-krea' })).resolves.toEqual({
      renamed: 0,
      groupName: 'flux-krea',
    });
    expect(dbWrite.huggingFaceImport.updateMany).not.toHaveBeenCalled();
  });

  it('reports a group that no longer exists', async () => {
    dbWrite.huggingFaceImport.updateMany.mockResolvedValue({ count: 0 });

    await expect(renameGroup(input)).rejects.toThrow(/No files found in group/);
  });
});

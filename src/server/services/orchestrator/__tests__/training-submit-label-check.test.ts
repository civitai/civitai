import JSZip from 'jszip';
import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The trainer's zip check against a real zip served by a fake bucket over ranged reads: the check
 *  started at upload, which records a verdict, and `createTrainingWorkflow`, which reads it. */

vi.mock('~/server/services/orchestrator/workflows', () => ({ submitWorkflow: vi.fn() }));
vi.mock('~/server/services/training.service', () => ({
  getTrainingServiceStatus: vi.fn(async () => ({ available: true, blockedModels: [] })),
}));
const bucket = vi.hoisted(() => ({
  head: vi.fn(),
  send: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({
  getGetUrl: vi.fn(async () => ({ url: ZIP_URL, bucket: 'datasets', key: 'data.zip' })),
  parseKey: vi.fn(() => ({ bucket: 'datasets', key: 'data.zip' })),
  getS3Client: vi.fn(() => ({ send: bucket.send })),
  getB2S3Client: vi.fn(),
  isB2Url: vi.fn(() => false),
  headObject: (...a: unknown[]) => bucket.head(...a),
}));
const classifyPromptExternally = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ classifyPromptExternally }));
const rate = vi.hoisted(() => vi.fn());
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({ checkFixedWindow: rate }));
// A real mutex, so a check another one holds is seen to be skipped.
const locks = vi.hoisted(() => ({ held: new Set<string>() }));
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (options: { key: string }, operation: () => Promise<unknown>) => {
    if (locks.held.has(options.key)) return null;
    locks.held.add(options.key);
    try {
      return await operation();
    } finally {
      locks.held.delete(options.key);
    }
  },
}));

import { createTrainingWorkflow } from '~/server/services/orchestrator/training/training.orch';
import { startTrainingZipCheck } from '~/server/services/orchestrator/training/training-zip-check';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

const ZIP_URL = 'https://storage.test/data.zip';
const MODEL_VERSION_ID = 55;
const USER_ID = 7;

const givenTrainingRow = (trainedWords: string[] = ['mystyle']) => {
  dbMock.dbWrite.$queryRaw.mockResolvedValue([
    {
      trainingDetails: {
        baseModel: 'krea2',
        baseModelType: 'krea2',
        params: { engine: 'ai-toolkit', ecosystem: 'krea2', epochs: 10, resolution: 1024 },
        samplePrompts: ['a', 'b', 'c'],
      },
      modelName: 'Test LoRA',
      trainedWords,
      userId: USER_ID,
      trainingUrl: ZIP_URL,
      fileId: 900,
      fileMetadata: {},
      modelVersionId: MODEL_VERSION_ID,
      modelVersionMetadata: {},
    },
  ]);
};

const submit = (domain: 'green' | 'red' = 'red') =>
  createTrainingWorkflow({
    modelVersionId: MODEL_VERSION_ID,
    token: 'tok',
    user: { id: USER_ID, isModerator: false } as never,
    features: { trainingStepsPricing: true } as never,
    domain,
  } as never);

/** A zip laid out the way the trainer builds it: `000.txt` beside `000.png`, plus any extras. */
async function datasetZip(
  labels: string[],
  { imageBytes = 16, extra = {} as Record<string, string> } = {}
) {
  const zip = new JSZip();
  labels.forEach((label, i) => {
    const base = String(i).padStart(3, '0');
    zip.file(`${base}.txt`, label);
    zip.file(`${base}.png`, Buffer.alloc(imageBytes, i), { compression: 'STORE' });
  });
  for (const [name, text] of Object.entries(extra)) zip.file(name, text);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const ETAG = '"etag-1"';
const ZIP_ID = `datasets/data.zip/${ETAG}`;
const verdictKey = (etag = ETAG) => `${REDIS_KEYS.TRAINING.ZIP_VERDICT}:datasets/data.zip/${etag}`;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Holds `bytes` as the dataset object and answers ranged reads of it, counting them. `drop` names
 *  the requests (1-based) whose body breaks after its first byte; `cut`, those whose body ends
 *  after its first byte without an error. */
function serveZip(
  bytes: Buffer,
  { drop = (_request: number) => false, cut = (_request: number) => false } = {}
) {
  let bytesServed = 0;
  let requests = 0;
  bucket.head.mockResolvedValue({ status: 'present', size: bytes.byteLength, etag: ETAG });
  bucket.send.mockImplementation(async (command: { input: Record<string, string> }) => {
    const { Bucket, Key, Range } = command.input;
    if (Bucket !== 'datasets' || Key !== 'data.zip') throw new Error(`unexpected read ${Key}`);
    requests++;
    const [, from, to] = Range.match(/^bytes=(\d+)-(\d+)$/)!.map(Number);
    const slice = bytes.subarray(from, to + 1);
    bytesServed += slice.byteLength;
    if (drop(requests))
      return {
        Body: Readable.from(
          (async function* () {
            yield slice.subarray(0, 1);
            throw new Error('connection reset');
          })()
        ),
      };
    if (cut(requests)) return { Body: Readable.from([slice.subarray(0, 1)]) };
    return { Body: Readable.from([slice]) };
  });
  return { bytesServed: () => bytesServed, requests: () => requests };
}

let store: ReturnType<typeof installFakeCacheRedis>;

beforeEach(() => {
  store = installFakeCacheRedis();
  locks.held.clear();
  setEnv({ WEBHOOK_URL: 'https://webhook.test', WEBHOOK_TOKEN: 't' });
  vi.mocked(submitWorkflow).mockReset();
  vi.mocked(submitWorkflow).mockResolvedValue({
    id: 'wf-1',
    transactions: { list: [] },
  } as never);
  classifyPromptExternally.mockReset();
  classifyPromptExternally.mockResolvedValue({ categories: [], externalError: null });
  rate.mockReset().mockResolvedValue({ allowed: true });
  dbMock.dbWrite.modelFile.update.mockResolvedValue({});
  dbMock.dbWrite.modelFile.count.mockResolvedValue(1);
  dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
  dbMock.dbWrite.modelVersion.updateMany.mockReset();
  dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });
});

const check = () =>
  startTrainingZipCheck({ url: ZIP_URL, userId: USER_ID, modelVersionId: MODEL_VERSION_ID });
const verdict = () => store.peek(verdictKey());
/** How long the recorded verdict is kept, in ms from now. */
const keptFor = () => (store.get(verdictKey())?.expiresAt ?? 0) - Date.now();

describe('the training zip check started at upload', () => {
  it('records a refusal for a hard label, kept for a month', async () => {
    serveZip(await datasetZip(['mystyle, 1girl, smile', 'mystyle, 8 year old girl']));
    await check();
    expect(verdict()).toEqual({ ok: false, reason: expect.stringContaining('have been blocked') });
    expect(keptFor()).toBeGreaterThan(29 * DAY_MS);
  });

  it('records a pass for clean labels, kept for a month', async () => {
    serveZip(await datasetZip(['mystyle, 1girl, smile']));
    await check();
    expect(verdict()).toEqual({ ok: true });
    expect(keptFor()).toBeGreaterThan(29 * DAY_MS);
  });

  it('checks text the trainer could read as a caption, whatever its name', async () => {
    serveZip(
      await datasetZip(['mystyle, 1girl'], {
        extra: { '__MACOSX/notes.caption': '8 year old girl' },
      })
    );
    await check();
    expect(verdict()).toMatchObject({ ok: false });
  });

  it('passes a soft hit, as the browser does after "Continue anyway"', async () => {
    serveZip(await datasetZip(['mystyle, 1girl, fagus tree']));
    await check();
    expect(verdict()).toEqual({ ok: true });
  });

  it('reads one range per label and never the images', async () => {
    const labels = Array.from({ length: 50 }, (_, i) => `mystyle, tag${i}`);
    const zip = await datasetZip(labels, { imageBytes: 64 * 1024 });
    const server = serveZip(zip);
    await check();
    expect(verdict()).toEqual({ ok: true });
    // The read of the end carries the whole file list; each label costs one more.
    expect(server.requests()).toBeLessThanOrEqual(1 + labels.length);
    expect(server.bytesServed()).toBeLessThan(zip.byteLength / 4);
  });

  it.each([
    ['an oversized label file', () => datasetZip(['x'.repeat(70 * 1024)]), 'too large'],
    [
      'label files too large in total',
      () => datasetZip(Array.from({ length: 70 }, () => 'ab '.repeat(20_000))),
      'too large in total',
    ],
    [
      'more files than any dataset holds',
      () =>
        datasetZip([], {
          extra: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`f${i}.png`, ''])),
        }),
      'more than 5000 files',
    ],
    [
      'a label file that is not UTF-8 text',
      () => {
        const zip = new JSZip();
        zip.file('000.txt', Buffer.from([0x6d, 0x79, 0xff, 0xfe, 0x20]));
        return zip.generateAsync({ type: 'nodebuffer' });
      },
      'not UTF-8',
    ],
    ['a file that is not a zip', async () => Buffer.from('not a zip at all'), 'could not be read'],
  ])('records a refusal for %s, with the reason', async (_l, build, reason) => {
    serveZip(await build());
    await check();
    expect(verdict()).toEqual({ ok: false, reason: expect.stringContaining(reason) });
  });

  it('checks an entry named like a folder that still holds data', async () => {
    serveZip(await datasetZip(['mystyle, 1girl'], { extra: { 'notes/': '8 year old girl' } }));
    await check();
    expect(verdict()).toMatchObject({ ok: false });
  });

  it('records what the classifier flags', async () => {
    serveZip(await datasetZip(['mystyle, 1girl']));
    classifyPromptExternally.mockResolvedValue({
      categories: ['flagged-category'],
      externalError: null,
    });
    await check();
    expect(verdict()).toEqual({ ok: false, reason: expect.stringContaining('flagged-category') });
    expect(classifyPromptExternally).toHaveBeenCalledWith(
      expect.stringContaining('mystyle, 1girl'),
      expect.anything()
    );
  });

  it('passes when the classifier is down, as every other audit does, but checks again soon', async () => {
    serveZip(await datasetZip(['mystyle, 1girl']));
    classifyPromptExternally.mockResolvedValue({
      categories: [],
      externalError: { message: 'down' },
    });
    await check();
    expect(verdict()).toEqual({ ok: true });
    expect(keptFor()).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('retries a read storage dropped, and records the verdict', async () => {
    serveZip(await datasetZip(['mystyle, 8 year old girl'], { imageBytes: 300 * 1024 }), {
      drop: (request) => request === 2,
    });
    await check();
    expect(verdict()).toMatchObject({ ok: false, reason: expect.stringContaining('blocked') });
  });

  it('retries a read storage cut short, rather than refusing the zip as unreadable', async () => {
    serveZip(await datasetZip(['mystyle, 1girl']), { cut: (request) => request === 1 });
    await check();
    expect(verdict()).toEqual({ ok: true });
  });

  it('records a short-lived "try again" when storage fails on every attempt', async () => {
    serveZip(await datasetZip(['mystyle, 1girl'], { imageBytes: 300 * 1024 }), {
      drop: (request) => request > 1,
    });
    await check();
    expect(verdict()).toMatchObject({ ok: false, code: 'SERVICE_UNAVAILABLE' });
    expect(keptFor()).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('records a "try again later" over the text-check budget, without the classifier', async () => {
    serveZip(await datasetZip(['mystyle, 1girl']));
    rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    await check();
    expect(verdict()).toMatchObject({ ok: false, code: 'TOO_MANY_REQUESTS' });
    expect(keptFor()).toBeLessThanOrEqual(120 * 1000);
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it("charges the zip's text to the uploader's text-check budget", async () => {
    serveZip(await datasetZip(['mystyle, 1girl']));
    await check();
    const [key] = rate.mock.calls[0] as [string];
    expect(key).toMatch(/^training:text-check-rate-limit:7$/);
  });

  it('records nothing for a zip gone from storage', async () => {
    bucket.head.mockResolvedValue({ status: 'absent' });
    await check();
    expect(store.size).toBe(0);
  });

  it('reads nothing for a zip already judged, or one another check holds', async () => {
    const server = serveZip(await datasetZip(['mystyle, 1girl']));
    store.plant(verdictKey(), { ok: true }, 60);
    await check();
    store.delete(verdictKey());
    locks.held.add(`training-zip-check:${ZIP_ID}`);
    await check();
    expect(server.requests()).toBe(0);
    expect(verdict()).toBeNull();
  });
});

describe('createTrainingWorkflow reads the upload verdict', () => {
  it('submits a zip that passed, without reading it again', async () => {
    givenTrainingRow();
    const server = serveZip(await datasetZip(['mystyle, 1girl']));
    store.plant(verdictKey(), { ok: true }, 60);

    await submit();

    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(server.requests()).toBe(0);
  });

  it('refuses a recorded refusal with its reason, before claiming or submitting', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl']));
    store.plant(verdictKey(), { ok: false, reason: 'Blocked for a reason.' }, 60);

    await expect(submit()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Blocked for a reason.',
    });
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it.each(['SERVICE_UNAVAILABLE', 'TOO_MANY_REQUESTS'])(
    'answers a check that could not finish (%s) as such, not as a refusal',
    async (code) => {
      givenTrainingRow();
      serveZip(await datasetZip(['mystyle, 1girl']));
      store.plant(verdictKey(), { ok: false, reason: 'Try again later.', code }, 60);

      await expect(submit()).rejects.toMatchObject({ code, message: 'Try again later.' });
      expect(submitWorkflow).not.toHaveBeenCalled();
    }
  );

  it('refuses a hard trigger word, which can change after upload', async () => {
    givenTrainingRow(['8 year old girl']);
    serveZip(await datasetZip(['1girl, smile']));
    store.plant(verdictKey(), { ok: true }, 60);

    await expect(submit()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('asks the user to wait while no verdict exists, and starts the check', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl']));

    await expect(submit()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('still being checked'),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(verdict()).toEqual({ ok: true }));

    await submit();
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('asks the user to wait, reading nothing, while another check holds the zip', async () => {
    givenTrainingRow();
    const server = serveZip(await datasetZip(['mystyle, 1girl']));
    locks.held.add(`training-zip-check:${ZIP_ID}`);

    await expect(submit()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(server.requests()).toBe(0);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('treats a replaced zip as unchecked', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl']));
    store.plant(verdictKey('"older-etag"'), { ok: true }, 60);

    await expect(submit()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('asks for a re-upload when the dataset is gone from storage', async () => {
    givenTrainingRow();
    bucket.head.mockResolvedValue({ status: 'absent' });

    await expect(submit()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('could not be found'),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    ['storage cannot be consulted', { status: 'unknown' }],
    ['storage reports no ETag to key a verdict by', { status: 'present', size: 10, etag: null }],
  ])('refuses rather than submits unchecked when %s', async (_l, head) => {
    givenTrainingRow();
    bucket.head.mockResolvedValue(head);

    await expect(submit()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses rather than submits unchecked when the verdict cannot be read', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl']));
    vi.mocked(redisMock.redis.packed.get).mockRejectedValueOnce(new Error('redis down'));

    await expect(submit()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
});

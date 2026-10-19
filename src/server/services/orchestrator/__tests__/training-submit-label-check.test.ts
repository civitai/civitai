import JSZip from 'jszip';
import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Drives `createTrainingWorkflow` against a real zip served by a fake bucket over ranged reads, so
 *  the read path, the rules and refuse-before-charge ordering are all exercised. */

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
  getS3Client: vi.fn(() => ({ send: bucket.send })),
  getB2S3Client: vi.fn(),
  isB2Url: vi.fn(() => false),
  headObject: (...a: unknown[]) => bucket.head(...a),
}));
const classifyPromptExternally = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ classifyPromptExternally }));

import { createTrainingWorkflow } from '~/server/services/orchestrator/training/training.orch';
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

/** Holds `bytes` as the dataset object and answers ranged reads of it, counting them. */
function serveZip(bytes: Buffer, { dropAfterFirst = false } = {}) {
  let bytesServed = 0;
  let requests = 0;
  bucket.head.mockResolvedValue({ status: 'present', size: bytes.byteLength });
  bucket.send.mockImplementation(async (command: { input: Record<string, string> }) => {
    const { Bucket, Key, Range } = command.input;
    if (Bucket !== 'datasets' || Key !== 'data.zip') throw new Error(`unexpected read ${Key}`);
    requests++;
    const [, from, to] = Range.match(/^bytes=(\d+)-(\d+)$/)!.map(Number);
    const slice = bytes.subarray(from, to + 1);
    bytesServed += slice.byteLength;
    if (dropAfterFirst && requests > 1)
      return {
        Body: Readable.from(
          (async function* () {
            yield slice.subarray(0, 1);
            throw new Error('connection reset');
          })()
        ),
      };
    return { Body: Readable.from([slice]) };
  });
  return { bytesServed: () => bytesServed, requests: () => requests };
}

describe('createTrainingWorkflow label check', () => {
  beforeEach(() => {
    setEnv({ WEBHOOK_URL: 'https://webhook.test', WEBHOOK_TOKEN: 't' });
    vi.mocked(submitWorkflow).mockReset();
    vi.mocked(submitWorkflow).mockResolvedValue({
      id: 'wf-1',
      transactions: { list: [] },
    } as never);
    classifyPromptExternally.mockReset();
    classifyPromptExternally.mockResolvedValue({ categories: [], externalError: null });
    dbMock.dbWrite.modelFile.update.mockResolvedValue({});
    dbMock.dbWrite.modelFile.count.mockResolvedValue(1);
    dbMock.dbWrite.modelVersion.update.mockResolvedValue({});
    dbMock.dbWrite.modelVersion.updateMany.mockReset();
    dbMock.dbWrite.modelVersion.updateMany.mockResolvedValue({ count: 1 });
  });

  it('refuses a hard label before claiming the version or submitting anything', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl, smile', 'mystyle, 8 year old girl']));

    await expect(submit()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('have been blocked'),
    });
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a hard trigger word even when every label is clean', async () => {
    givenTrainingRow(['8 year old girl']);
    serveZip(await datasetZip(['1girl, smile']));

    await expect(submit()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('audits text the trainer could read as a caption, whatever its name', async () => {
    givenTrainingRow();
    serveZip(
      await datasetZip(['mystyle, 1girl'], {
        extra: { '__MACOSX/notes.caption': '8 year old girl' },
      })
    );

    await expect(submit()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('lets a soft hit through, as the browser does after "Continue anyway"', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl, fagus tree']));

    await submit('green');

    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('reads one range per label and never the images', async () => {
    givenTrainingRow();
    const labels = Array.from({ length: 50 }, (_, i) => `mystyle, tag${i}`);
    const zip = await datasetZip(labels, { imageBytes: 64 * 1024 });
    const server = serveZip(zip);

    await submit();

    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    // The read of the end carries the whole file list; each label costs one more.
    expect(server.requests()).toBeLessThanOrEqual(1 + labels.length);
    expect(server.bytesServed()).toBeLessThan(zip.byteLength / 4);
  });

  it('refuses an oversized label file as the dataset, not as a storage failure', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['x'.repeat(70 * 1024)]));

    await expect(submit()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('too large'),
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a zip, rather than asking for a retry', async () => {
    givenTrainingRow();
    serveZip(Buffer.from('not a zip at all'));

    await expect(submit()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('asks for a retry, not a re-upload, when storage drops mid-read', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl'], { imageBytes: 300 * 1024 }), {
      dropAfterFirst: true,
    });

    await expect(submit()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
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

  it('refuses rather than submits unchecked when storage cannot be consulted', async () => {
    givenTrainingRow();
    bucket.head.mockResolvedValue({ status: 'unknown' });

    await expect(submit()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses what the classifier flags, before claiming or submitting', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl']));
    classifyPromptExternally.mockResolvedValue({
      categories: ['flagged-category'],
      externalError: null,
    });

    await expect(submit()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('flagged-category'),
    });
    expect(classifyPromptExternally).toHaveBeenCalledWith(
      expect.stringContaining('mystyle, 1girl'),
      expect.anything()
    );
    expect(dbMock.dbWrite.modelVersion.updateMany).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('submits when the classifier is down, as every other audit does', async () => {
    givenTrainingRow();
    serveZip(await datasetZip(['mystyle, 1girl']));
    classifyPromptExternally.mockResolvedValue({
      categories: [],
      externalError: { message: 'down' },
    });

    await submit();

    expect(submitWorkflow).toHaveBeenCalledTimes(1);
  });
});

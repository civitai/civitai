import { beforeEach, describe, expect, it, vi } from 'vitest';

// Import-graph stubs, as in training.orchestrator-error-mapping.test.ts.
vi.mock('@civitai/orchestration-client', () => ({ handleError: vi.fn() }));
vi.mock('@aws-sdk/lib-storage', () => {
  const Upload = class {};
  return { Upload, default: { Upload } };
});
vi.mock('~/server/db/db-lag-helpers', () => ({ preventModelVersionLag: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: {} }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/schema/training.schema', () => ({ trainingServiceStatusSchema: {} }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));

const s3 = vi.hoisted(() => ({
  deleteObject: vi.fn(() => Promise.resolve()),
  getGetUrl: vi.fn(() => Promise.resolve({ url: 'https://signed.example/get' })),
}));
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: s3.deleteObject,
  getB2S3Client: vi.fn(),
  getGetUrl: s3.getGetUrl,
  getPutUrl: vi.fn(),
  getS3Client: vi.fn(),
  getUploadBucket: (backend = 'default') => (backend === 'b2' ? 'b2-uploads' : 'uploads'),
  isB2Url: (url: string) => new URL(url).hostname === 'b2.example',
  // Path-style: https://<host>/<bucket>/<key>
  parseKey: (url: string) => {
    const [, bucket, ...key] = new URL(url).pathname.split('/');
    return { bucket, key: key.join('/') };
  },
}));

const orchestrator = vi.hoisted(() => ({
  imageAutoTag: vi.fn(),
  imageAutoCaption: vi.fn(),
}));
vi.mock('~/server/http/orchestrator/orchestrator.caller', () => ({
  getOrchestratorCaller: vi.fn(() => orchestrator),
}));

import { autoCaptionHandler, autoTagHandler } from '~/server/services/training.service';

const userId = 42;
const ownUrl = `https://s3.example/uploads/training-images-temp/${userId}/data.abcd.zip`;
const ownB2Url = `https://b2.example/b2-uploads/training-images-temp/${userId}/data.abcd.zip`;

const handlers = [
  ['autoTag', autoTagHandler, orchestrator.imageAutoTag],
  ['autoCaption', autoCaptionHandler, orchestrator.imageAutoCaption],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(handlers)('%sHandler', (_name, handler, call) => {
  const run = (url: string) => handler({ url, modelId: 1, userId });

  describe('keeps the input file when the orchestrator call fails', () => {
    it('on 429', async () => {
      call.mockResolvedValue({ ok: false, status: 429 });
      await expect(run(ownUrl)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
      expect(s3.deleteObject).not.toHaveBeenCalled();
    });

    it('on a non-ok response', async () => {
      call.mockResolvedValue({ ok: false, status: 500 });
      await expect(run(ownUrl)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(s3.deleteObject).not.toHaveBeenCalled();
    });

    it('when the request itself throws', async () => {
      call.mockRejectedValue(new TypeError('fetch failed'));
      await expect(run(ownUrl)).rejects.toThrow();
      expect(s3.deleteObject).not.toHaveBeenCalled();
    });
  });

  it.each([ownUrl, ownB2Url])(
    'signs and submits a url under the caller’s prefix (%s)',
    async (url) => {
      call.mockResolvedValue({ ok: true, status: 200, data: { result: 1 } });
      await expect(run(url)).resolves.toEqual({ result: 1 });
      expect(s3.getGetUrl).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['another user’s prefix', `https://s3.example/uploads/training-images-temp/7/data.abcd.zip`],
    [
      'a prefix that only starts with the user id',
      `https://s3.example/uploads/training-images-temp/${userId}0/x.zip`,
    ],
    ['another upload type', `https://s3.example/uploads/model/${userId}/x.safetensors`],
    [
      'a bucket that is not an upload bucket',
      `https://s3.example/other/training-images-temp/${userId}/x.zip`,
    ],
    [
      'the other backend’s bucket',
      `https://s3.example/b2-uploads/training-images-temp/${userId}/x.zip`,
    ],
  ])('refuses a url in %s before signing or submitting', async (_label, url) => {
    await expect(run(url)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(s3.getGetUrl).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
});

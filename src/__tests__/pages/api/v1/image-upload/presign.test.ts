import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as S3Utils from '~/utils/s3-utils';
import type * as HttpErrors from '~/server/prom/http-errors';
import type * as StorageResolver from '~/server/services/storage-resolver';
import type * as ImageUploadAction from '~/server/services/image-upload-action.service';

// The two presign routes hand the client a server-minted key; each must record the
// upload-request IP against that key, since the key is what later becomes `Image.url`.

const m = vi.hoisted(() => ({
  session: vi.fn(),
  customPut: vi.fn(),
  multipartPut: vi.fn(),
  track: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: m.session,
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: vi.fn(async () => ({ s3: null, bucket: 'b', backend: 'backblaze' })),
  getCustomPutUrl: m.customPut,
  getMultipartPutUrl: m.multipartPut,
}));
vi.mock('~/server/prom/http-errors', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpErrors>()),
  instrumentApiResponse: vi.fn(),
}));
vi.mock('~/server/services/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  registerMediaLocation: vi.fn(),
}));
vi.mock('~/server/services/image-upload-action.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUploadAction>()),
  trackImageUpload: m.track,
}));

import imageUpload from '~/pages/api/v1/image-upload';
import imageUploadMultipart from '~/pages/api/v1/image-upload/multipart';

function makeRes() {
  const res = {
    statusCode: 0,
    body: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload as Record<string, string>;
      return this;
    },
  };
  return res as unknown as NextApiResponse & typeof res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.session.mockResolvedValue({ user: { id: 7, bannedAt: null } });
  m.customPut.mockImplementation(async (bucket: string, key: string) => ({
    url: 'https://put',
    bucket,
    key,
  }));
  m.multipartPut.mockImplementation(async (key: string) => ({
    urls: [],
    bucket: 'b',
    key,
    uploadId: 'u',
    chunkSize: 1,
  }));
});

describe('image upload presign routes', () => {
  it('/api/v1/image-upload records the key it hands back', async () => {
    const req = {} as NextApiRequest;
    const res = makeRes();

    await imageUpload(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toEqual(expect.any(String));
    expect(m.track).toHaveBeenCalledExactlyOnceWith(req, res, res.body.id);
    expect(redisMock.sysRedis.set).toHaveBeenCalledExactlyOnceWith(
      `system:upload-key-owner:${res.body.id}`,
      '7',
      { EX: 30 * 24 * 60 * 60 }
    );
  });

  it('/api/v1/image-upload/multipart records the key it hands back', async () => {
    const req = { body: { size: 10, filename: 'a.png' } } as NextApiRequest;
    const res = makeRes();

    await imageUploadMultipart(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.key).toEqual(expect.any(String));
    expect(m.track).toHaveBeenCalledExactlyOnceWith(req, res, res.body.key);
    expect(redisMock.sysRedis.set).toHaveBeenCalledExactlyOnceWith(
      `system:upload-key-owner:${res.body.key}`,
      '7',
      { EX: 30 * 24 * 60 * 60 }
    );
  });

  it('records nothing for a caller it refuses', async () => {
    m.session.mockResolvedValue(null);

    await imageUpload({} as NextApiRequest, makeRes());
    await imageUploadMultipart({ body: {} } as NextApiRequest, makeRes());

    expect(m.track).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.set).not.toHaveBeenCalled();
  });
});

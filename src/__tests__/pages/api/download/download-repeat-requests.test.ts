import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * A resume of a large download re-enters through this route for the same file. Those repeats must
 * not use up the user's download limit, up to an allowance; past it they count again, so one file
 * looped is still limited. Each resolve also logs how long the link it hands out has left.
 */

const { mockGetServerAuthSession, mockGetFileForModelVersion, mockIncrement } = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockIncrement: vi.fn(),
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));
vi.mock('~/server/services/file.service', () => ({
  getFileForModelVersion: mockGetFileForModelVersion,
}));
vi.mock('~/server/services/user.service', () => ({
  bustUserDownloadsCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    modelVersionEvent = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('~/server/utils/rate-limiting', () => ({
  createLimiter: () => ({
    hasExceededLimit: vi.fn().mockResolvedValue(false),
    increment: mockIncrement,
    getCount: vi.fn(),
  }),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import handler from '~/pages/api/download/models/[modelVersionId]';
import { FREE_FILE_REPEATS } from '~/server/utils/download-repeats';

const USER = 42;
const BIG_FILE = 9;
const OTHER_FILE = 10;
const SIGNED_URL = 'https://files.example.invalid/model.safetensors?token=SECRET-SIGNATURE';
const GIB_KB = 1024 * 1024;

// sysRedis as the one MULTI this path sends uses it: SET NX EX, then INCR.
let store: Map<string, number>;
function fakeMulti() {
  const ops: (() => unknown)[] = [];
  const pipeline = {
    set(key: string, value: number, options: { NX?: boolean; EX?: number }) {
      ops.push(() => {
        if (options.NX && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      });
      return pipeline;
    },
    incr(key: string) {
      ops.push(() => {
        const next = (store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
      });
      return pipeline;
    },
    exec: async () => ops.map((op) => op()),
  };
  return pipeline;
}

const download = async (fileId = BIG_FILE, sizeKB = 24 * GIB_KB) => {
  mockGetFileForModelVersion.mockResolvedValueOnce({
    status: 'success',
    url: SIGNED_URL,
    urlExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    fileId,
    sizeKB,
    metadata: {},
    isDownloadable: true,
    published: false,
    modelId: 1,
    modelVersionId: 123,
    nsfw: false,
    inEarlyAccess: false,
  });
  const req = {
    method: 'GET',
    query: { modelVersionId: '123' },
    headers: { 'user-agent': 'test' },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as NextApiResponse;
  await handler(req, res);
  expect(res.redirect).toHaveBeenCalledWith(SIGNED_URL);
};

beforeEach(() => {
  store = new Map();
  mockIncrement.mockReset().mockResolvedValue(1);
  mockGetServerAuthSession.mockResolvedValue({ user: { id: USER } });
  redisMock.sysRedis.multi.mockImplementation(fakeMulti);
});

describe('repeat requests for one file', () => {
  it('count once, however many times a download resumes within the allowance', async () => {
    await download();
    await download();
    await download();

    expect(mockIncrement).toHaveBeenCalledTimes(1);
    expect(mockIncrement).toHaveBeenCalledWith(String(USER));
  });

  it('count again once the allowance for that file is used up', async () => {
    for (let i = 0; i < 1 + FREE_FILE_REPEATS; i++) await download();
    expect(mockIncrement).toHaveBeenCalledTimes(1);

    await download();
    await download();

    expect(mockIncrement).toHaveBeenCalledTimes(3);
  });

  it('do not cover a different file, which still counts', async () => {
    await download(BIG_FILE);
    await download(OTHER_FILE);

    expect(mockIncrement).toHaveBeenCalledTimes(2);
  });

  it('still count when the repeat tracking cannot be reached', async () => {
    redisMock.sysRedis.multi.mockImplementation(() => {
      throw new Error('sysRedis down');
    });

    await download();
    await download();

    expect(mockIncrement).toHaveBeenCalledTimes(2);
  });
});

describe('the link a download is sent to', () => {
  it('logs how long it has left, for the file, without the link', async () => {
    await download(BIG_FILE);

    const entry = loggingMock.logToAxiom.mock.calls
      .map(([payload]) => payload as Record<string, unknown>)
      .find((payload) => payload.message === 'url-expiry');
    expect(entry).toMatchObject({ fileId: BIG_FILE, sizeKB: 24 * GIB_KB, sampleRate: 1 });
    expect(entry?.remainingSeconds).toBeGreaterThan(290);
    expect(entry?.remainingSeconds).toBeLessThanOrEqual(300);
    expect(JSON.stringify(entry)).not.toMatch(/https?:|token|SECRET|example\.invalid/);
  });
});

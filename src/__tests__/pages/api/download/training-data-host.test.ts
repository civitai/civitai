import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trainingDataServableOnHost } from '~/shared/utils/training-data-visibility';

/**
 * The download route decides the host for the training-dataset host gate: a mature dataset is the
 * same 404 as a missing file on a host that is not red-capable. The resolver below applies the real
 * rule to what the route passes it, so a route that ignored the host would serve the dataset.
 */

// As in production: civitai.red is a blue alias and the red primary.
vi.hoisted(() => {
  process.env.SERVER_DOMAIN_BLUE = 'civitai.com';
  process.env.SERVER_DOMAIN_BLUE_ALIASES = 'civitai.red';
  process.env.SERVER_DOMAIN_RED = 'civitai.red';
});

const {
  mockGetServerAuthSession,
  mockGetFileForModelVersion,
  mockHasExceededLimit,
  mockIncrement,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockHasExceededLimit: vi.fn(),
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
    hasExceededLimit: mockHasExceededLimit,
    increment: mockIncrement,
    getCount: vi.fn(),
  }),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv } from '~/__tests__/mocks/env.mock';
import handler from '~/pages/api/download/models/[modelVersionId]';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockLogToAxiom = loggingMock.logToAxiom;

const mockFindUnique = dbMock.dbRead.keyValue.findUnique;
const REDIRECT_URL = 'https://example.invalid/signed/model.safetensors';

function run(host: string) {
  const req = {
    method: 'GET',
    url: '/api/download/models/123',
    query: { modelVersionId: '123' },
    headers: { host, 'user-agent': 'test' },
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

  return { promise: handler(req, res), res };
}

const MATURE_DATASET = { nsfwLevel: 4, fullyRated: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetEnv();
  mockFindUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue({ user: { id: 5 } });
  mockHasExceededLimit.mockResolvedValue(false);
  mockIncrement.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
  mockGetFileForModelVersion.mockImplementation(async ({ redCapable }: { redCapable: boolean }) =>
    trainingDataServableOnHost(MATURE_DATASET, redCapable)
      ? {
          status: 'success',
          url: REDIRECT_URL,
          urlExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
          sizeKB: 1024,
          fileId: 1,
          modelId: 1,
          nsfw: false,
          inEarlyAccess: false,
          isDownloadable: true,
          published: true,
          metadata: MATURE_DATASET,
        }
      : { status: 'not-found' }
  );
});

describe('the download route and a mature training dataset', () => {
  it('is a 404 on a host that is not red-capable', async () => {
    const { promise, res } = run('civitai.com');
    await promise;
    expect(mockGetFileForModelVersion.mock.calls[0][0].redCapable).toBe(false);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('is served on a red-capable host', async () => {
    const { promise, res } = run('civitai.red');
    await promise;
    expect(mockGetFileForModelVersion.mock.calls[0][0].redCapable).toBe(true);
    expect(res.redirect).toHaveBeenCalledWith(REDIRECT_URL);
  });
});

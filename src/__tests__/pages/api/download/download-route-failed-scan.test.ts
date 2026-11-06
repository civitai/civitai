import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A file that failed its scan is refused with a 403 that names why, and the refusal is never
// edge-cached: moderators are served the same URL.

const { mockGetServerAuthSession, mockGetFileForModelVersion } = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
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
    increment: vi.fn().mockResolvedValue(undefined),
    getCount: vi.fn(),
  }),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv } from '~/__tests__/mocks/env.mock';
import handler from '~/pages/api/download/models/[modelVersionId]';

async function run(userAgent = 'python-requests/2.31') {
  const req = {
    method: 'GET',
    url: '/api/download/models/123',
    query: { modelVersionId: '123' },
    headers: { 'user-agent': userAgent },
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
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue({ user: { id: 42 } });
  mockGetFileForModelVersion.mockResolvedValue({ status: 'failed-scan' });
});

const MESSAGE = 'This file did not pass a security scan and is not available for download';

describe('the download route refuses a file that failed its scan', () => {
  it('answers an API client 403 with the reason as JSON, uncached', async () => {
    const res = await run();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: MESSAGE });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });

  it('answers a browser 403 with the reason as text', async () => {
    const res = await run(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(MESSAGE);
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// An API client (no browser user agent) hitting an early-access gate gets a 403 whose message must not
// offer a purchase the server refuses: a non-commercial version can't be bought.

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

async function run() {
  const req = {
    method: 'GET',
    url: '/api/download/models/123',
    query: { modelVersionId: '123' },
    headers: { 'user-agent': 'python-requests/2.31' },
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

const deadline = new Date('2026-12-01T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue({ user: { id: 42 } });
});

describe('the download API answers an early-access gate', () => {
  it('on a non-commercial base model: not commercially available, no purchase offer', async () => {
    mockGetFileForModelVersion.mockResolvedValue({
      status: 'early-access',
      details: { deadline, baseModel: 'Flux.2 Klein 9B' },
    });

    const res = await run();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Early Access',
      deadline,
      message:
        "This model isn't commercially available at the moment. Its base model, Flux.2 Klein 9B, is licensed for non-commercial use only.",
    });
  });

  it('on a commercial base model: the early-access purchase message', async () => {
    mockGetFileForModelVersion.mockResolvedValue({
      status: 'early-access',
      details: { deadline, baseModel: 'Flux.2 Klein 4B' },
    });

    const res = await run();

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Early Access',
      deadline,
      message: 'This asset is in Early Access. You can use Buzz access it now!',
    });
  });
});

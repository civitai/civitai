import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The ID URL names a file by its version plus type/format/size selectors. When the file the gate
// settles on does not match a selector the caller gave, the route answers "File not found" rather
// than serving a different file. A fileId names the file exactly, so no selector is checked.

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
vi.mock('~/server/utils/download-repeats', () => ({
  countsTowardDownloadLimit: vi.fn().mockResolvedValue(false),
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv } from '~/__tests__/mocks/env.mock';
import handler from '~/pages/api/download/models/[modelVersionId]';

const SIGNED_URL = 'https://files.example/signed';

async function run(query: Record<string, string>) {
  const req = {
    method: 'GET',
    url: '/api/download/models/123',
    query: { modelVersionId: '123', ...query },
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

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue({ user: { id: 42 } });
  mockGetFileForModelVersion.mockResolvedValue({
    status: 'success',
    url: SIGNED_URL,
    urlExpiresAt: new Date(Date.now() + 60_000),
    fileId: 7,
    modelVersionId: 123,
    modelId: 9,
    sizeKB: 1,
    nsfw: false,
    inEarlyAccess: false,
    metadata: { format: 'PickleTensor' },
    isDownloadable: true,
    published: true,
  });
});

describe('the ID download URL with file selectors', () => {
  it('answers "File not found" when the file does not match a requested selector', async () => {
    const res = await run({ format: 'SafeTensor' });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'File not found' });
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('serves the file when it matches', async () => {
    const res = await run({ format: 'PickleTensor' });

    expect(res.redirect).toHaveBeenCalledWith(SIGNED_URL);
  });

  it('checks no selector when a fileId names the file', async () => {
    const res = await run({ format: 'SafeTensor', fileId: '7' });

    expect(res.redirect).toHaveBeenCalledWith(SIGNED_URL);
  });
});

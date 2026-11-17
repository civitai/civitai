import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Public download totals and contest download signals are built from the route's Download events,
 * so an internal service fetching a published file (it authenticates as the system account) must
 * still get the file but must not emit one.
 */

const {
  mockGetServerAuthSession,
  mockGetFileForModelVersion,
  mockHasExceededLimit,
  mockIncrement,
  mockModelVersionEvent,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockHasExceededLimit: vi.fn(),
  mockIncrement: vi.fn(),
  mockModelVersionEvent: vi.fn(),
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
    modelVersionEvent = mockModelVersionEvent;
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
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { constants } from '~/server/common/constants';
import handler from '~/pages/api/download/models/[modelVersionId]';

const REDIRECT_URL = 'https://example.invalid/signed/model.safetensors';

async function download() {
  const req = {
    method: 'GET',
    url: '/api/download/models/123',
    query: { modelVersionId: '123' },
    headers: { 'user-agent': 'test-agent/1.0' },
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

const downloadEvents = () =>
  mockModelVersionEvent.mock.calls.filter(([values]) => values.type === 'Download');

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  mockHasExceededLimit.mockResolvedValue(false);
  mockIncrement.mockResolvedValue(undefined);
  mockModelVersionEvent.mockResolvedValue(undefined);
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  mockGetFileForModelVersion.mockResolvedValue({
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
    metadata: {},
  });
});

describe('download route Download events', () => {
  it('an internal service fetch of a published version gets the file and emits no Download event', async () => {
    mockGetServerAuthSession.mockResolvedValue({ user: { id: constants.system.user.id } });

    const res = await download();

    expect(res.redirect).toHaveBeenCalledWith(REDIRECT_URL);
    expect(downloadEvents()).toHaveLength(0);
  });

  it.each([
    ['a signed-in user', { user: { id: 42 } }],
    ['an anonymous caller', null],
  ] as const)(
    '%s downloading a published version emits one Download event',
    async (_l, session) => {
      mockGetServerAuthSession.mockResolvedValue(session);

      const res = await download();

      expect(res.redirect).toHaveBeenCalledWith(REDIRECT_URL);
      expect(downloadEvents()).toHaveLength(1);
      expect(downloadEvents()[0][0]).toMatchObject({ modelVersionId: 123, fileId: 1, modelId: 1 });
    }
  );
});

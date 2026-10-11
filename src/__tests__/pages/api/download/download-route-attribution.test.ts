import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SEAM between the download route's session and the storage-resolver
 * attribution it hands `getFileForModelVersion`.
 *
 * The call-site ledger (`src/utils/__tests__/resolve-caller-seam.test.ts`) pins
 * that the route passes `caller: 'download-route'` and DERIVES the actor with
 * `resolveActorFor(...)`, but it reads source text and cannot see WHAT is
 * passed to it: `resolveActorFor(undefined)` would report every download as
 * `anon` and stay green there. These drive the real route with three distinct
 * sessions and assert the exact attribution each produces, so a hardcoded value
 * or the wrong variable fails at least two of them.
 */

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

function run() {
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

  return { promise: handler(req, res), res };
}

const attributionArg = () => mockGetFileForModelVersion.mock.calls[0][0].attribution;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  resetEnv();
  mockFindUnique.mockResolvedValue(null);
  mockHasExceededLimit.mockResolvedValue(false);
  mockIncrement.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
  mockGetFileForModelVersion.mockResolvedValue({
    status: 'success',
    url: REDIRECT_URL,
    fileId: 1,
    modelId: 1,
    nsfw: false,
    inEarlyAccess: false,
    isDownloadable: true,
    published: true,
    metadata: {},
  });
});

describe('the download route attributes its resolve to the session behind it', () => {
  it.each([
    ['no session', 'anon', null],
    ['a signed-in user', 'user', { user: { id: 42 } }],
    ['the system account an internal service authenticates as', 'internal', { user: { id: -1 } }],
  ] as const)('%s -> actor %s', async (_label, actor, session) => {
    mockGetServerAuthSession.mockResolvedValue(session);
    const { promise, res } = run();
    await promise;

    expect(mockGetFileForModelVersion).toHaveBeenCalledTimes(1);
    expect(attributionArg()).toStrictEqual({ caller: 'download-route', actor });
    expect(res.redirect).toHaveBeenCalledWith(REDIRECT_URL);
  });
});

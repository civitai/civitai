import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SEAM between `shouldResolveDirect` and the download route.
 *
 * 🔴 This file exists because the unit tests either side of it are individually
 * green against a route that hardcodes `direct: true`. Measured: with
 * `direct: shouldResolveDirect(req)` replaced by `direct: true`, the whole
 * download-path suite passed — 4815 tests, zero failures. So did deleting the
 * argument entirely, and so did inverting it. Every one of those is a real
 * production outcome (origin-direct for every caller / the feature silently
 * inert / origin-direct for exactly the callers not allowlisted), and none was
 * distinguishable from correct.
 *
 * The unit suite pins what `shouldResolveDirect` RETURNS. It cannot pin that the
 * route asks it, or that the answer is the value passed on. That is what these
 * assert, and why they assert the exact boolean rather than
 * `expect.objectContaining` — an objectContaining matcher cannot see a field that
 * was added, removed, or inverted.
 */

const {
  mockGetServerAuthSession,
  mockGetFileForModelVersion,
  mockHasExceededLimit,
  mockIncrement,
  mockLogToAxiom,
  mockEnv,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockHasExceededLimit: vi.fn(),
  mockIncrement: vi.fn(),
  mockLogToAxiom: vi.fn(),
  mockEnv: { STORAGE_RESOLVER_DIRECT_USER_AGENTS: [] as string[] },
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

vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

vi.mock('~/server/redis/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  return { REDIS_SYS_KEYS: make(), REDIS_KEYS: make(), redis: {}, sysRedis: {} };
});

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

// Mocked at the env boundary rather than stubbing `shouldResolveDirect` itself:
// stubbing the helper would leave the route free to ignore it and still pass.
vi.mock('~/env/server', () => ({ env: mockEnv }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import handler from '~/pages/api/download/models/[modelVersionId]';

const mockFindUnique = dbMock.dbRead.keyValue.findUnique;
const REDIRECT_URL = 'https://example.invalid/signed/model.safetensors';
const ALLOWED_UA = 'some-internal-client/1.2.3';

function run(userAgent: string) {
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

  return { promise: handler(req, res), res };
}

const directArg = () => mockGetFileForModelVersion.mock.calls[0][0].direct;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = [];
  mockFindUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue({ user: { id: 5 } });
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

describe('the download route passes shouldResolveDirect through to the resolver', () => {
  // Kills the hardcoded-true mutant. This is the one with a cost: it would move
  // every B2-backed download from zero-rated CDN egress to billed origin egress.
  it('asks for direct:false when the allowlist is empty, even for the agent it will later allow', async () => {
    const { promise } = run(ALLOWED_UA);
    await promise;

    expect(mockGetFileForModelVersion).toHaveBeenCalledTimes(1);
    expect(directArg()).toBe(false);
  });

  // Kills the hardcoded-false mutant and the deleted-argument mutant.
  it('asks for direct:true when the agent is allowlisted', async () => {
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = ['some-internal-client'];

    const { promise } = run(ALLOWED_UA);
    await promise;

    expect(directArg()).toBe(true);
  });

  // Kills the inverted mutant: it is the pairing of these two under ONE
  // allowlist that no single-value assertion can express.
  it('asks for direct:false for a non-allowlisted agent under the same allowlist', async () => {
    mockEnv.STORAGE_RESOLVER_DIRECT_USER_AGENTS = ['some-internal-client'];

    const { promise } = run('Mozilla/5.0');
    await promise;

    expect(directArg()).toBe(false);
  });

  // `direct` must never arrive as undefined: `{ direct: undefined }` is what a
  // deleted argument looks like, and it reads as false downstream while being
  // indistinguishable from it in an objectContaining assertion.
  it('always passes an explicit boolean, never undefined', async () => {
    const { promise } = run(ALLOWED_UA);
    await promise;

    expect(typeof directArg()).toBe('boolean');
  });
});

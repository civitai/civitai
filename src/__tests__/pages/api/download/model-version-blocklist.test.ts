import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Regression coverage for `/api/download/models/[modelVersionId]`, which uses
 * the client IP for TWO controls:
 *
 *   1. the abuse IP blocklist (hard 403), and
 *   2. the anonymous download-quota bucket (`userKey`) — the value an anonymous
 *      caller's 24h download count is accumulated under.
 *
 * Both must key on an address the caller cannot select. For (2) the failure is
 * symmetric and worth pinning explicitly: a selectable bucket can be rotated to
 * shed an accumulated count, and can equally be pointed at someone else's
 * address so their budget absorbs the traffic.
 */

const {
  mockFindUnique,
  mockGetServerAuthSession,
  mockGetFileForModelVersion,
  mockHasExceededLimit,
  mockIncrement,
  mockModelVersionEvent,
} = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockHasExceededLimit: vi.fn(),
  mockIncrement: vi.fn(),
  mockModelVersionEvent: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { keyValue: { findUnique: mockFindUnique } },
  dbWrite: { keyValue: { findUnique: mockFindUnique } },
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

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/redis/client', () => {
  // Recursive key proxy so module-eval-time dereferences like
  // REDIS_SYS_KEYS.DOWNLOAD.COUNT resolve without a real redis client. The
  // return type is genuinely recursive-any; same shape as the sibling
  // adjust-tag-level test.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  return { REDIS_SYS_KEYS: make(), REDIS_KEYS: make(), redis: {}, sysRedis: {} };
});

// Capture the exact userKey the quota is charged against.
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

import handler from '~/pages/api/download/models/[modelVersionId]';

const BLOCKED = '203.0.113.7';
const VICTIM = '198.51.100.9';
const CF_RAY = '8a1b2c3d4e5f6789-IAD';

function run(headers: Record<string, string>, remoteAddress?: string) {
  const req = {
    method: 'GET',
    query: { modelVersionId: '123' },
    headers: { 'user-agent': 'test', ...headers },
    socket: remoteAddress ? { remoteAddress } : undefined,
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

function blocklist(...ips: string[]) {
  mockFindUnique.mockResolvedValue({ value: ips.join(',') });
}

/** The userKey the download quota was charged against on the last request. */
function chargedKey(): string {
  const calls = mockHasExceededLimit.mock.calls;
  return calls[calls.length - 1][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerAuthSession.mockResolvedValue(null);
  mockHasExceededLimit.mockResolvedValue(false);
  mockIncrement.mockResolvedValue(undefined);
  mockModelVersionEvent.mockResolvedValue(undefined);
  mockGetFileForModelVersion.mockResolvedValue({
    status: 'success',
    url: 'https://example.invalid/model.safetensors',
    metadata: {},
    isDownloadable: true,
    published: true,
    modelId: 1,
    modelVersionId: 123,
    fileId: 9,
    nsfw: false,
    inEarlyAccess: false,
  });
});

describe('/api/download/models/[modelVersionId] — IP blocklist', () => {
  it('blocks a request whose edge-attested address is on the list', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();
  });

  it('SECURITY: a caller-supplied address does not evade a block on the real one', async () => {
    blocklist(BLOCKED);
    const { promise, res } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': VICTIM,
      'x-forwarded-for': VICTIM,
      'x-real-ip': VICTIM,
    });
    await promise;
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();
  });

  it('SECURITY: a caller-supplied address does not induce a block on someone else', async () => {
    blocklist(VICTIM);
    const { promise, res } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': VICTIM,
    });
    await promise;
    expect(res.status).not.toHaveBeenCalledWith(403);
    // Positive control: the request completed as a real download.
    expect(res.redirect).toHaveBeenCalledWith('https://example.invalid/model.safetensors');
  });
});

describe('/api/download/models/[modelVersionId] — anonymous download quota bucket', () => {
  it('charges the quota to the edge-attested address for an anonymous caller', async () => {
    mockFindUnique.mockResolvedValue(null);
    const { promise } = run({ 'cf-ray': CF_RAY, 'cf-connecting-ip': BLOCKED });
    await promise;
    expect(chargedKey()).toBe(BLOCKED);
  });

  it('SECURITY: rotating the supplied address does not rotate the quota bucket', async () => {
    mockFindUnique.mockResolvedValue(null);
    const keys: string[] = [];
    for (const n of [1, 2, 3, 200]) {
      const { promise } = run({
        'cf-ray': CF_RAY,
        'cf-connecting-ip': BLOCKED,
        'x-client-ip': `198.51.100.${n}`,
        'x-forwarded-for': `198.51.100.${n}`,
      });
      await promise;
      keys.push(chargedKey());
    }
    // Positive control: the harness DID observe four charges, so the single
    // distinct value below is a real measurement and not an empty set.
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(BLOCKED);
  });

  it("SECURITY: a caller cannot charge its downloads to a victim's address", async () => {
    mockFindUnique.mockResolvedValue(null);
    const { promise } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': VICTIM,
      'x-forwarded-for': VICTIM,
      'true-client-ip': VICTIM,
    });
    await promise;
    expect(chargedKey()).toBe(BLOCKED);
    expect(chargedKey()).not.toBe(VICTIM);
    expect(mockIncrement).toHaveBeenCalledWith(BLOCKED);
  });

  it('an authenticated caller is still charged to the user id, not any address', async () => {
    mockFindUnique.mockResolvedValue(null);
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 4242 } });
    const { promise } = run({
      'cf-ray': CF_RAY,
      'cf-connecting-ip': BLOCKED,
      'x-client-ip': VICTIM,
    });
    await promise;
    expect(chargedKey()).toBe('4242');
  });
});

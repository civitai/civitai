import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * The download routes read the ip/user blocklist rows through a cache, not once per request.
 *
 * Driven through `/api/download/attachments/[fileId]`, the one route that reads BOTH rows, with
 * Redis modelled as a map so the first request's write is what the second request reads.
 */

const { mockGetServerAuthSession, mockGetFileWithPermission, mockGetDownloadUrl } = vi.hoisted(
  () => ({
    mockGetServerAuthSession: vi.fn(),
    mockGetFileWithPermission: vi.fn(),
    mockGetDownloadUrl: vi.fn(),
  })
);

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockGetServerAuthSession,
}));
vi.mock('~/server/services/file.service', () => ({
  getFileWithPermission: mockGetFileWithPermission,
}));
vi.mock('~/utils/delivery-worker', () => ({ getDownloadUrl: mockGetDownloadUrl }));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    file = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  PublicEndpoint: (handler: (req: NextApiRequest, res: NextApiResponse) => unknown) => handler,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import handler from '~/pages/api/download/attachments/[fileId]';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';

const findUnique = dbMock.dbRead.keyValue.findUnique;

const BLOCKED_IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';
const BLOCKED_USER = 31337;
const CF_RAY = '8a1b2c3d4e5f6789-IAD';

let store: Map<string, unknown>;

function run(ip: string) {
  const req = {
    method: 'GET',
    query: { fileId: '77' },
    headers: { 'cf-ray': CF_RAY, 'cf-connecting-ip': ip },
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

function rows(ipList: string, userList: string) {
  findUnique.mockImplementation((async ({ where }: { where: { key: string } }) => ({
    key: where.key,
    value: where.key === 'user-blacklist' ? userList : ipList,
  })) as never);
}

const readsOf = (key: string) =>
  findUnique.mock.calls.filter(([args]) => (args as { where: { key: string } }).where.key === key)
    .length;

beforeEach(() => {
  vi.clearAllMocks();
  resetSharedMocks();
  setEnv({ UNAUTHENTICATED_DOWNLOAD: true });
  store = new Map();
  redisMock.redis.packed.get.mockImplementation(
    (async (key: string) => store.get(key) ?? null) as never
  );
  redisMock.redis.packed.set.mockImplementation((async (key: string, value: unknown) => {
    store.set(key, value);
  }) as never);
  redisMock.redis.setNxKeepTtlWithEx.mockResolvedValue(true as never);
  mockGetServerAuthSession.mockResolvedValue(null);
  mockGetFileWithPermission.mockResolvedValue({
    id: 77,
    url: 'files/attachment.pdf',
    name: 'attachment.pdf',
    entityId: 5,
    entityType: 'Article',
  });
  mockGetDownloadUrl.mockResolvedValue({ url: 'https://example.invalid/attachment.pdf' });
});

describe('download blocklist cache — attachments route', () => {
  it('reads the ip blocklist from the database once across repeated downloads', async () => {
    rows(BLOCKED_IP, '');

    for (let i = 0; i < 3; i++) await run(OTHER_IP).promise;

    expect(readsOf('ip-blacklist')).toBe(1);
  });

  it('reads the user blocklist from the database once across repeated signed-in downloads', async () => {
    rows('', String(BLOCKED_USER));
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 7 } });

    for (let i = 0; i < 3; i++) await run(OTHER_IP).promise;

    expect(readsOf('user-blacklist')).toBe(1);
  });

  it('still blocks a listed address and a listed user when the lists come from the cache', async () => {
    rows(BLOCKED_IP, String(BLOCKED_USER));
    // An unlisted signed-in download warms both entries.
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 7 } });
    const warm = run(OTHER_IP);
    await warm.promise;
    expect(warm.res.status).not.toHaveBeenCalledWith(403);
    findUnique.mockClear();

    const ipHit = run(BLOCKED_IP);
    await ipHit.promise;
    expect(ipHit.res.status).toHaveBeenCalledWith(403);

    mockGetServerAuthSession.mockResolvedValue({ user: { id: BLOCKED_USER } });
    const userHit = run(OTHER_IP);
    await userHit.promise;
    expect(userHit.res.status).toHaveBeenCalledWith(403);

    expect(findUnique).not.toHaveBeenCalled();
  });

  // Invariant guard, green before the cache existed too: it pins that the cache never turns an
  // outage into an open door, not that the cache is used.
  it('blocks from the database when the cache is unavailable, never letting the request through', async () => {
    redisMock.redis.packed.get.mockRejectedValue(new Error('cache unavailable') as never);
    rows(BLOCKED_IP, '');

    const { promise, res } = run(BLOCKED_IP);
    await promise;

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockGetFileWithPermission).not.toHaveBeenCalled();
    expect(readsOf('ip-blacklist')).toBe(1);
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The download route against the URL shape a client builds by appending the
 * documented `?type=…&format=…&token=…` suffix to a `downloadUrl` that already
 * carries `?fileId=<id>` — `…/models/568485?fileId=484398?type=Model&…`.
 *
 * The unit suite owns the repair itself; this file owns the WIRING, which the
 * unit suite cannot see: that the repair runs before the route parses its
 * schema (otherwise `fileId` is NaN → 400) and before it resolves a session
 * (otherwise `?token=` is swallowed → the caller is anonymous, which on a
 * gated file is a 401/404 rather than a redirect).
 */

const {
  mockGetServerAuthSession,
  mockGetFileForModelVersion,
  mockHasExceededLimit,
  mockIncrement,
  mockLogToAxiom,
} = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
  mockHasExceededLimit: vi.fn(),
  mockIncrement: vi.fn(),
  mockLogToAxiom: vi.fn(),
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

import handler from '~/pages/api/download/models/[modelVersionId]';
import { dbMock } from '~/__tests__/mocks/db.mock';
// The handler reads the blocklist from the REPLICA only (`dbRead.keyValue.findUnique` in
// the route). The old fixture aliased dbRead and dbWrite to one spy, so a read routed to
// the primary would have satisfied it silently; binding dbRead alone makes that
// distinguishable.
const mockFindUnique = dbMock.dbRead.keyValue.findUnique;

const REDIRECT_URL = 'https://example.invalid/signed/model.safetensors';

/**
 * Drive the route the way Next would for `url`: the query string parsed with
 * `URLSearchParams`, then the path params spread OVER it — params win on a
 * collision (`next-server.ts`), which is the precedence the repair must not
 * invert.
 *
 * `req.url` is re-serialised the same way, because `normalizeCdnUrl` does that
 * before the handler runs — the stray `?` arrives percent-encoded while
 * `req.query` keeps it raw. Handing the route the raw url instead is what let
 * civitai#3931 pass here while prod kept answering 400.
 */
function run(url: string, modelVersionId: string) {
  const parsed = new URL(url, 'https://civitai.com');
  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) query[key] = value;
  query.modelVersionId = modelVersionId;

  const search = parsed.searchParams.toString();

  const req = {
    method: 'GET',
    url: search ? `${parsed.pathname}?${search}` : parsed.pathname,
    query,
    headers: { 'user-agent': 'civitai-downloader/1.0' },
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

  return { promise: handler(req, res), req, res };
}

function statuses(res: NextApiResponse) {
  return (res.status as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue({ user: { id: 5 } });
  mockHasExceededLimit.mockResolvedValue(false);
  mockIncrement.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
  mockGetFileForModelVersion.mockResolvedValue({
    status: 'success',
    url: REDIRECT_URL,
    metadata: {},
    isDownloadable: true,
    published: true,
    modelId: 1,
    modelVersionId: 568485,
    fileId: 484398,
    nsfw: false,
    inEarlyAccess: false,
  });
});

describe('download route — a query split by a stray `?`', () => {
  const url =
    '/api/download/models/568485?fileId=484398?type=Model&format=SafeTensor&token=secret-key';

  it('redirects instead of answering 400', async () => {
    const { promise, res } = run(url, '568485');
    await promise;

    expect(
      statuses(res),
      'the schema rejected the request — `fileId` parsed as NaN, so the repair did not run first'
    ).not.toContain(400);
    expect(res.redirect).toHaveBeenCalledWith(REDIRECT_URL);
  });

  it('resolves the file by the id the client pinned', async () => {
    const { promise } = run(url, '568485');
    await promise;

    expect(mockGetFileForModelVersion).toHaveBeenCalledWith(
      expect.objectContaining({ modelVersionId: 568485, fileId: 484398, type: 'Model' })
    );
  });

  it('hands auth a url the API key is still readable from', async () => {
    const { promise } = run(url, '568485');
    await promise;

    const authReq = mockGetServerAuthSession.mock.calls[0][0].req as NextApiRequest;
    const seen = new URL(authReq.url as string, 'https://civitai.com');
    expect(
      seen.searchParams.get('token'),
      'auth saw the unrepaired url, so an API-key caller is treated as anonymous'
    ).toBe('secret-key');
  });

  it('resolves the version in the PATH, not one the repaired query names', async () => {
    const { promise } = run('/api/download/models/568485?modelVersionId=999?fileId=2', '568485');
    await promise;

    expect(mockGetFileForModelVersion).toHaveBeenCalledWith(
      expect.objectContaining({ modelVersionId: 568485 })
    );
  });

  it('keeps the caller API key out of the error log', async () => {
    mockGetFileForModelVersion.mockRejectedValue(new Error('resolver exploded'));

    const { promise } = run(url, '568485');
    await promise;

    const logged = mockLogToAxiom.mock.calls[0][0] as { query: Record<string, unknown> };
    expect(logged.query, 'the caller API key was shipped to Axiom in plaintext').not.toHaveProperty(
      'token'
    );
    expect(logged.query.fileId, 'the rest of the query is still there to debug with').toBe(
      '484398'
    );
  });

  it('CONTROL: the same request already worked when the client used `&`', async () => {
    const { promise, res } = run(
      '/api/download/models/568485?fileId=484398&type=Model&format=SafeTensor&token=secret-key',
      '568485'
    );
    await promise;

    expect(statuses(res)).not.toContain(400);
    expect(res.redirect).toHaveBeenCalledWith(REDIRECT_URL);
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The hash URLs run the ID URL's handler: same blocklist, same gate, same answers. The candidate
// query is answered from `holder.rows`; its SQL is covered by download-by-hash.sql.behavior.test.ts.

const holder = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  params: [] as unknown[][],
}));
const { mockGetServerAuthSession, mockGetFileForModelVersion, mockModelVersionEvent } = vi.hoisted(
  () => ({
    mockGetServerAuthSession: vi.fn(),
    mockGetFileForModelVersion: vi.fn(),
    mockModelVersionEvent: vi.fn(),
  })
);

vi.mock('~/server/db/kyselyDb.lazy', () => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      holder.params.push([...compiled.parameters]);
      return { rows: holder.rows as never[] };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  const kyselyRead = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: noop,
        acquireConnection: async () => connection,
        beginTransaction: noop,
        commitTransaction: noop,
        rollbackTransaction: noop,
        releaseConnection: noop,
        destroy: noop,
      }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { loadKyselyDb: async () => ({ kyselyRead }) };
});
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
import sha256Route from '~/pages/api/download/sha256/[hash]';
import blake3Route from '~/pages/api/download/blake3/[hash]';

const HASH = 'ab'.repeat(32);
const BLOCKED = '203.0.113.7';
const SIGNED_URL = 'https://files.example/signed';

const candidate = (fileId: number) => ({
  fileId,
  modelVersionId: fileId + 1000,
  groupSize: 2,
  liveCount: 2,
  takenDownFileIds: null,
  groupSizeSpreadKB: 0,
  liveSizeSpreadKB: 0,
});

async function run(
  route: typeof sha256Route,
  hash: unknown,
  {
    browser = false,
    ip = '198.51.100.1',
    token,
  }: { browser?: boolean; ip?: string; token?: string } = {}
) {
  const req = {
    method: 'GET',
    url: `/api/download/sha256/${hash}${token ? `?token=${token}` : ''}`,
    query: token ? { hash, token } : { hash },
    headers: { 'user-agent': browser ? 'Mozilla/5.0 Chrome/120' : 'python-requests/2.31' },
    socket: { remoteAddress: ip },
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as NextApiResponse;
  await route(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  holder.rows = [candidate(1), candidate(2)];
  holder.params = [];
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  mockGetServerAuthSession.mockResolvedValue({ user: { id: 42 } });
  mockModelVersionEvent.mockResolvedValue(undefined);
  mockGetFileForModelVersion.mockImplementation(async ({ fileId, modelVersionId }) =>
    fileId === 2
      ? {
          status: 'success',
          url: SIGNED_URL,
          urlExpiresAt: new Date(Date.now() + 60_000),
          fileId,
          modelVersionId,
          modelId: 9,
          sizeKB: 1,
          nsfw: false,
          inEarlyAccess: false,
          metadata: {},
          isDownloadable: true,
          published: true,
        }
      : { status: 'no-access' }
  );
});

describe('/api/download/{sha256|blake3}/<hash>', () => {
  it('serves the first copy the gate passes, and counts the download against it', async () => {
    const res = await run(sha256Route, HASH);

    expect(res.redirect).toHaveBeenCalledWith(SIGNED_URL);
    expect(mockGetFileForModelVersion.mock.calls.map(([a]) => a.fileId)).toEqual([1, 2]);
    expect(mockGetFileForModelVersion.mock.calls[0][0]).toMatchObject({
      modelVersionId: 1001,
      user: { id: 42 },
    });
    expect(mockModelVersionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Download', modelVersionId: 1002, fileId: 2 })
    );
  });

  it('looks the hash up upper-case, under its own type, for the signed-in caller', async () => {
    await run(sha256Route, HASH);
    await run(blake3Route, HASH);

    expect(holder.params[0]).toEqual(expect.arrayContaining([HASH.toUpperCase(), 'SHA256', 42]));
    expect(holder.params[1]).toEqual(expect.arrayContaining([HASH.toUpperCase(), 'BLAKE3']));
  });

  it("passes an anonymous or moderator caller's standing to the lookup", async () => {
    mockGetServerAuthSession.mockResolvedValue(null);
    await run(sha256Route, HASH);
    mockGetServerAuthSession.mockResolvedValue({ user: { id: 42, isModerator: true } });
    await run(sha256Route, HASH);

    expect(holder.params[0]).not.toContain(42);
    expect(holder.params[0]).toContain(false);
    expect(holder.params[1]).toEqual(expect.arrayContaining([42, true]));
  });

  it('refuses a malformed hash with a 400 before any lookup', async () => {
    for (const bad of [HASH.slice(2), `${HASH.slice(1)}z`, [HASH, HASH]]) {
      const res = await run(sha256Route, bad);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Invalid hash: expected 64 hexadecimal characters',
      });
    }
    expect(holder.params).toEqual([]);
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();
  });

  it('answers an unknown hash as the ID URL answers an unknown file', async () => {
    holder.rows = [];

    const res = await run(sha256Route, HASH);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'File not found' });
  });

  it('applies the download IP blocklist', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: BLOCKED });

    const blocked = await run(sha256Route, HASH, { ip: BLOCKED });
    expect(blocked.status).toHaveBeenCalledWith(403);
    expect(mockGetFileForModelVersion).not.toHaveBeenCalled();

    // Control: an unlisted caller is served under the same blocklist.
    const other = await run(sha256Route, HASH);
    expect(other.redirect).toHaveBeenCalledWith(SIGNED_URL);
  });

  it('sends a browser at the version that refused it for early access', async () => {
    mockGetFileForModelVersion.mockImplementation(async ({ fileId }) =>
      fileId === 2
        ? { status: 'early-access', details: { baseModel: 'SDXL 1.0' } }
        : { status: 'not-found' }
    );

    const res = await run(sha256Route, HASH, { browser: true });

    expect(res.redirect).toHaveBeenCalledWith('/model-versions/1002');
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
} from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';

// The model download routes (by version id, sha256 and blake3) and the scope of the bearer
// credential that reaches them. The session layer is faked to record `req.context` the way
// `getServerAuthSession` does; the file lookup is faked to serve the owner and moderators only.

const OWNER_ID = 10;
const MODERATOR_ID = 20;
const VERSION_ID = 123;
const HASH = 'ab'.repeat(32);

const holder = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  variant: null as string | null,
}));

const { mockGetServerAuthSession, mockGetFileForModelVersion } = vi.hoisted(() => ({
  mockGetServerAuthSession: vi.fn(),
  mockGetFileForModelVersion: vi.fn(),
}));

vi.mock('~/server/db/kyselyDb.lazy', () => {
  const connection: DatabaseConnection = {
    async executeQuery() {
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
  getDownloadFilename: () => 'file.safetensors',
}));
vi.mock('~/server/services/user.service', () => ({
  bustUserDownloadsCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: undefined,
  Tracker: class {
    modelVersionEvent = vi.fn().mockResolvedValue(true);
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
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: vi.fn(async (flag: string) =>
    flag === 'download-scope-gate' ? holder.variant : null
  ),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import versionRoute from '~/pages/api/download/models/[modelVersionId]';
import sha256Route from '~/pages/api/download/sha256/[hash]';
import blake3Route from '~/pages/api/download/blake3/[hash]';

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;
type Caller = {
  user: { id: number; isModerator?: boolean };
  /** What the session layer records on `req.context`; absent for a cookie session. */
  context?: Record<string, unknown>;
  via?: 'header' | 'query';
};

const ROUTES: [
  string,
  Route,
  (search: string) => { url: string; query: Record<string, string> }
][] = [
  [
    'models/[modelVersionId]',
    versionRoute,
    (search) => ({
      url: `/api/download/models/${VERSION_ID}${search}`,
      query: { modelVersionId: String(VERSION_ID) },
    }),
  ],
  [
    'sha256/[hash]',
    sha256Route,
    (search) => ({ url: `/api/download/sha256/${HASH}${search}`, query: { hash: HASH } }),
  ],
  [
    'blake3/[hash]',
    blake3Route,
    (search) => ({ url: `/api/download/blake3/${HASH}${search}`, query: { hash: HASH } }),
  ],
];

const personalKey = (tokenScope: number | undefined) => ({
  apiKeyId: 5,
  apiKeyType: 'User',
  subject: { type: 'apiKey', id: 5 },
  ...(tokenScope === undefined ? {} : { tokenScope }),
});
const oauthToken = (tokenScope: number) => ({
  apiKeyId: 6,
  apiKeyType: 'Access',
  subject: { type: 'oauth', id: 'client-abc' },
  tokenScope,
});

async function download(route: (typeof ROUTES)[number], caller: Caller | null) {
  const [, handler, target] = route;
  const queryToken = caller?.context && caller.via === 'query';
  const { url, query } = target(queryToken ? '?token=the-key' : '');
  const req = {
    method: 'GET',
    url,
    query: { ...query, ...(queryToken ? { token: 'the-key' } : {}) },
    headers: {
      'user-agent': 'python-requests/2.31',
      ...(caller?.context && !queryToken ? { authorization: 'Bearer the-key' } : {}),
    },
    socket: { remoteAddress: '203.0.113.7' },
  } as unknown as NextApiRequest;
  mockGetServerAuthSession.mockImplementation(
    async ({ req: r }: { req: NextApiRequest & { context?: Record<string, unknown> } }) => {
      r.context = { ...(r.context ?? {}), ...(caller?.context ?? {}) };
      return caller ? { user: { username: 'u', bannedAt: null, ...caller.user } } : null;
    }
  );
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    headersSent: false,
  } as unknown as NextApiResponse;
  await handler(req, res);
  const status = vi.mocked(res.status).mock.calls.at(-1)?.[0];
  const served = vi.mocked(res.redirect).mock.calls.at(-1)?.[0];
  return { res, status, served };
}

const scopeLog = () =>
  (loggingMock.logToAxiom.mock.calls as unknown as [Record<string, unknown>][])
    .map(([entry]) => entry)
    .filter((entry) => entry?.name === 'download-scope-refused');

const SCOPE_REFUSAL = { error: 'Your API key does not have the required scope for this action' };

beforeEach(() => {
  vi.clearAllMocks();
  resetEnv();
  holder.variant = 'enforce';
  holder.rows = [
    {
      fileId: 1,
      modelVersionId: VERSION_ID,
      groupSize: 1,
      liveCount: 1,
      takenDownFileIds: null,
      groupSizeSpreadKB: 0,
      liveSizeSpreadKB: 0,
    },
  ];
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  // An unpublished version: only its owner and moderators are served.
  mockGetFileForModelVersion.mockImplementation(
    async ({ user }: { user?: { id: number; isModerator?: boolean } }) => {
      if (!user) return { status: 'unauthorized' };
      if (user.id !== OWNER_ID && !user.isModerator) return { status: 'no-access' };
      return {
        status: 'success',
        url: 'https://storage.example/draft',
        published: false,
        isDownloadable: true,
        metadata: {},
        modelId: 1,
        fileId: 1,
        nsfw: false,
        inEarlyAccess: false,
        urlExpiresAt: new Date(Date.now() + 3600_000),
      };
    }
  );
});

describe.each(ROUTES)('%s under enforce', (...route) => {
  it.each(['header', 'query'] as const)(
    "refuses an AI Services key (%s) on its owner's draft, and serves a ModelsRead key",
    async (via) => {
      const refused = await download(route, {
        user: { id: OWNER_ID },
        context: personalKey(TokenScopePresets.AIServices),
        via,
      });
      expect(refused.status).toBe(403);
      expect(refused.res.json).toHaveBeenCalledWith(SCOPE_REFUSAL);
      expect(refused.served).toBeUndefined();

      const allowed = await download(route, {
        user: { id: OWNER_ID },
        context: personalKey(TokenScope.ModelsRead),
        via,
      });
      expect(allowed.served).toBe('https://storage.example/draft');
    }
  );

  it('refuses an OAuth token with UserRead acting for the owner', async () => {
    const { status, served } = await download(route, {
      user: { id: OWNER_ID },
      context: oauthToken(TokenScope.UserRead),
    });
    expect(status).toBe(403);
    expect(served).toBeUndefined();
  });

  it('refuses a bearer whose recorded credential has no scope', async () => {
    const { status, served } = await download(route, {
      user: { id: OWNER_ID },
      context: personalKey(undefined),
    });
    expect(status).toBe(403);
    expect(served).toBeUndefined();
  });

  it('serves a full-scope key and a cookie session as before', async () => {
    expect(
      (await download(route, { user: { id: OWNER_ID }, context: personalKey(TokenScope.Full) }))
        .served
    ).toBe('https://storage.example/draft');
    expect((await download(route, { user: { id: OWNER_ID } })).served).toBe(
      'https://storage.example/draft'
    );
  });
});

describe.each(ROUTES)('%s, a moderator', (...route) => {
  it.each([null, 'log', 'enforce'])(
    'with a Read Only key is not served a version it does not own (flag %s)',
    async (variant) => {
      holder.variant = variant;
      const { served, status } = await download(route, {
        user: { id: MODERATOR_ID, isModerator: true },
        context: personalKey(TokenScopePresets.ReadOnly),
      });
      expect(served).toBeUndefined();
      expect(status).toBe(403);
    }
  );

  it('with a full-scope personal key, or a cookie session, is served it', async () => {
    holder.variant = null;
    expect(
      (
        await download(route, {
          user: { id: MODERATOR_ID, isModerator: true },
          context: personalKey(TokenScope.Full),
        })
      ).served
    ).toBe('https://storage.example/draft');
    expect((await download(route, { user: { id: MODERATOR_ID, isModerator: true } })).served).toBe(
      'https://storage.example/draft'
    );
  });
});

describe('the scope gate flag on models/[modelVersionId]', () => {
  const route = ROUTES[0];
  const aiServicesOwner: Caller = {
    user: { id: OWNER_ID },
    context: personalKey(TokenScopePresets.AIServices),
  };

  it('off: serves, and logs nothing', async () => {
    holder.variant = null;
    expect((await download(route, aiServicesOwner)).served).toBe('https://storage.example/draft');
    expect(scopeLog()).toEqual([]);
  });

  it('log: serves, and logs the refusal without the token', async () => {
    holder.variant = 'log';
    expect((await download(route, aiServicesOwner)).served).toBe('https://storage.example/draft');
    const log = scopeLog();
    expect(log).toEqual([
      expect.objectContaining({
        mode: 'log',
        route: '/api/download/models/[modelVersionId]',
        requiredScope: TokenScope.ModelsRead,
        tokenScope: TokenScopePresets.AIServices,
        apiKeyType: 'User',
      }),
    ]);
    expect(JSON.stringify(log)).not.toContain('the-key');
  });

  it('enforce: refuses, and logs the refusal', async () => {
    const { status } = await download(route, aiServicesOwner);
    expect(status).toBe(403);
    expect(scopeLog()).toEqual([expect.objectContaining({ mode: 'enforce' })]);
  });
});

describe('models/[modelVersionId], the internal system account', () => {
  const route = ROUTES[0];

  it.each([null, 'log', 'enforce'])(
    'is served a draft it does not own with a ModelsRead key (flag %s)',
    async (variant) => {
      holder.variant = variant;
      const { served } = await download(route, {
        user: { id: -1, isModerator: true },
        context: personalKey(TokenScope.ModelsRead),
      });
      expect(served).toBe('https://storage.example/draft');
    }
  );

  it('does not extend to another moderator holding the same key', async () => {
    holder.variant = null;
    const { served } = await download(route, {
      user: { id: MODERATOR_ID, isModerator: true },
      context: personalKey(TokenScope.ModelsRead),
    });
    expect(served).toBeUndefined();
  });
});

describe('models/[modelVersionId], a bearer the session layer recorded nothing for', () => {
  const route = ROUTES[0];
  async function bare(headers: Record<string, string>, token?: string) {
    const req = {
      method: 'GET',
      url: `/api/download/models/${VERSION_ID}${token ? `?token=${token}` : ''}`,
      query: { modelVersionId: String(VERSION_ID), ...(token ? { token } : {}) },
      headers: { 'user-agent': 'python-requests/2.31', ...headers },
      socket: { remoteAddress: '203.0.113.7' },
    } as unknown as NextApiRequest;
    // The cookie session it resolved to, with no credential fields recorded.
    mockGetServerAuthSession.mockResolvedValue({
      user: { id: OWNER_ID, username: 'u', bannedAt: null },
    });
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      redirect: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      headersSent: false,
    } as unknown as NextApiResponse;
    await route[1](req, res);
    return {
      status: vi.mocked(res.status).mock.calls.at(-1)?.[0],
      served: vi.mocked(res.redirect).mock.calls.at(-1)?.[0],
    };
  }

  it('refuses one sent in the header', async () => {
    expect((await bare({ authorization: 'Bearer unknown' })).status).toBe(403);
  });

  it('refuses one sent as ?token=', async () => {
    expect((await bare({}, 'unknown')).status).toBe(403);
  });

  it('does not count the webhook token as one', async () => {
    setEnv({ WEBHOOK_TOKEN: 'webhook-secret-0123456789' });
    expect((await bare({}, 'webhook-secret-0123456789')).served).toBe(
      'https://storage.example/draft'
    );
  });

  it('does not count the orchestrator service token as one', async () => {
    setEnv({ ORCHESTRATOR_SERVICE_TOKEN: 'test-service-token-0123456789abcdef' });
    expect(
      (await bare({ authorization: 'Bearer test-service-token-0123456789abcdef' })).served
    ).toBe('https://storage.example/draft');
  });
});

// mini/[id] classes an AIServicesRead key as entitled; the bytes it points at still need ModelsRead.
it('refuses an AIServicesRead key the bytes under enforce', async () => {
  const { status } = await download(ROUTES[0], {
    user: { id: OWNER_ID },
    context: personalKey(TokenScope.AIServicesRead),
  });
  expect(status).toBe(403);
});

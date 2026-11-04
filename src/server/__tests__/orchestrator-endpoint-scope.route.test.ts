import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as GetOrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as ServerAuthSession from '~/server/auth/get-server-auth-session';
import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

// Every route behind OrchestratorEndpoint, through the real wrapper: a bearer key must carry the
// route's scope before an orchestrator token is fetched; a cookie session always passes.

const { getOrchestratorToken, getServerAuthSession, services } = vi.hoisted(() => ({
  getOrchestratorToken: vi.fn(),
  getServerAuthSession: vi.fn(),
  services: {
    getWorkflowStatusUpdate: vi.fn(async () => ({})),
    refreshBlobsService: vi.fn(async () => []),
    getBlobRatingsService: vi.fn(async () => []),
    getConsumerBlobUploadUrlService: vi.fn(async () => ({})),
  },
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', async (importOriginal) => ({
  ...(await importOriginal<typeof GetOrchestratorToken>()),
  getOrchestratorToken,
}));
vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof ServerAuthSession>()),
  getServerAuthSession,
}));
// Hand-listed: these load the orchestration client, which cannot load in the node test environment.
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  getWorkflowStatusUpdate: services.getWorkflowStatusUpdate,
}));
vi.mock('~/server/services/orchestrator/refreshBlobs', () => ({
  MAX_BLOB_REFRESH_BATCH: 100,
  refreshBlobsService: services.refreshBlobsService,
}));
vi.mock('~/server/services/orchestrator/blobRatings', () => ({
  MAX_BLOB_RATING_BATCH: 100,
  getBlobRatingsService: services.getBlobRatingsService,
}));
vi.mock('~/server/services/orchestrator/consumerBlobUpload', () => ({
  getConsumerBlobUploadUrlService: services.getConsumerBlobUploadUrlService,
}));

type Route = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const routes: {
  name: string;
  method: string;
  scope: number;
  /** Logs a call without the scope instead of refusing it. */
  logsOnly?: boolean;
  load: () => Promise<{ default: unknown }>;
}[] = [
  {
    name: 'generation/workflows/[workflowId]/status-update',
    scope: TokenScope.AIServicesRead,
    method: 'GET',
    load: () => import('~/pages/api/generation/workflows/[workflowId]/status-update'),
  },
  {
    name: 'orchestrator/refreshBlobs',
    scope: TokenScope.AIServicesRead,
    method: 'POST',
    load: () => import('~/pages/api/orchestrator/refreshBlobs'),
  },
  {
    name: 'orchestrator/blobRatings',
    scope: TokenScope.AIServicesRead,
    method: 'POST',
    load: () => import('~/pages/api/orchestrator/blobRatings'),
  },
  {
    name: 'orchestrator/getConsumerBlobUploadUrl',
    scope: TokenScope.AIServicesWrite,
    logsOnly: true,
    method: 'GET',
    load: () => import('~/pages/api/orchestrator/getConsumerBlobUploadUrl'),
  },
];

const USER = 4242;

/** `tokenScope` set: a bearer key with that scope, recorded the way getServerAuthSession does. */
async function call(route: (typeof routes)[number], tokenScope?: number) {
  getServerAuthSession.mockImplementation(async ({ req }: { req: NextApiRequest }) => {
    const context = ((req as { context?: Record<string, unknown> }).context ??= {});
    if (tokenScope !== undefined)
      Object.assign(context, {
        tokenScope,
        apiKeyId: 7,
        apiKeyType: ApiKeyType.User,
        subject: { type: 'apiKey', id: 7 },
      });
    return { user: { id: USER, bannedAt: null } };
  });
  const handler = (await route.load()).default as Route;
  const out: { status?: number } = {};
  const res = {
    setHeader: () => res,
    getHeader: () => undefined,
    status(code: number) {
      out.status = code;
      return res;
    },
    json: () => res,
    send: () => res,
    end: () => res,
  } as unknown as NextApiResponse;
  const req = {
    method: route.method,
    headers: tokenScope === undefined ? {} : { authorization: 'Bearer k' },
    query: { workflowId: 'wf-1' },
    body: { blobIds: ['a.jpeg'] },
    url: `/api/${route.name}`,
  } as unknown as NextApiRequest;
  await handler(req, res);
  return out;
}

const serviceCalls = () => Object.values(services).reduce((n, fn) => n + fn.mock.calls.length, 0);

beforeEach(() => {
  vi.clearAllMocks();
  getOrchestratorToken.mockResolvedValue('orchestrator-token');
});

describe.each(routes)('/api/$name', (route) => {
  it('serves a cookie session', async () => {
    expect((await call(route)).status).toBe(200);
    expect(serviceCalls()).toBe(1);
  });

  it('serves a full-scope key', async () => {
    expect((await call(route, TokenScope.Full)).status).toBe(200);
  });

  it('serves a key holding only the route scope', async () => {
    expect((await call(route, route.scope)).status).toBe(200);
  });

  const wouldRefuseLogs = () =>
    loggingMock.logToAxiom.mock.calls.filter(
      ([event]) => (event as { name?: string })?.name === 'orchestrator-endpoint-scope-would-refuse'
    );

  if (!route.logsOnly) {
    it('refuses a key without the route scope, before fetching a token', async () => {
      const { status } = await call(route, TokenScope.Full & ~route.scope);
      expect(status).toBe(403);
      expect(getOrchestratorToken).not.toHaveBeenCalled();
      expect(serviceCalls()).toBe(0);
    });

    it('serves a read-only key', async () => {
      expect((await call(route, TokenScopePresets.ReadOnly)).status).toBe(200);
    });
  } else {
    it('serves a read-only key and logs it, without user, key or address', async () => {
      expect((await call(route, TokenScopePresets.ReadOnly)).status).toBe(200);
      const logs = wouldRefuseLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0][0]).toEqual({
        name: 'orchestrator-endpoint-scope-would-refuse',
        type: 'info',
        route: `/api/${route.name}`,
        requiredScope: route.scope,
        tokenScope: TokenScopePresets.ReadOnly,
        apiKeyType: ApiKeyType.User,
        client: 'personal-key',
        clientIdHash: undefined,
      });
    });

    it('logs nothing for a cookie session or a key with the scope', async () => {
      await call(route);
      await call(route, route.scope);
      await call(route, TokenScope.Full);
      expect(wouldRefuseLogs()).toHaveLength(0);
    });
  }
});

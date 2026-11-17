import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type * as GetOrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as ServerAuthSession from '~/server/auth/get-server-auth-session';
import { TokenScope } from '~/shared/constants/token-scope.constants';
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
    method: 'GET',
    load: () => import('~/pages/api/orchestrator/getConsumerBlobUploadUrl'),
  },
];

const USER = 4242;

/** `tokenScope` set: a bearer key with that scope, recorded the way getServerAuthSession does. */
async function call(
  route: (typeof routes)[number],
  tokenScope?: number,
  subject: { type: 'apiKey'; id: number } | { type: 'oauth'; id: string } = {
    type: 'apiKey',
    id: 7,
  }
) {
  getServerAuthSession.mockImplementation(async ({ req }: { req: NextApiRequest }) => {
    const context = ((req as { context?: Record<string, unknown> }).context ??= {});
    if (tokenScope !== undefined)
      Object.assign(context, {
        tokenScope,
        apiKeyId: 7,
        apiKeyType: ApiKeyType.User,
        subject,
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

const refusedLogs = () =>
  loggingMock.logToAxiom.mock.calls.filter(
    ([event]) => (event as { name?: string })?.name === 'orchestrator-endpoint-scope-refused'
  );

// A key holding AI Services scopes, but not this route's one.
const otherAIServicesScope = (route: (typeof routes)[number]) =>
  route.scope === TokenScope.AIServicesRead
    ? TokenScope.AIServicesWrite
    : TokenScope.AIServicesRead;

describe.each(routes)('/api/$name', (route) => {
  it('serves a cookie session, without a refused log', async () => {
    expect((await call(route)).status).toBe(200);
    expect(serviceCalls()).toBe(1);
    expect(refusedLogs()).toHaveLength(0);
  });

  it('serves a full-scope key, without a refused log', async () => {
    expect((await call(route, TokenScope.Full)).status).toBe(200);
    expect(refusedLogs()).toHaveLength(0);
  });

  it('serves a key holding only the route scope, without a refused log', async () => {
    expect((await call(route, route.scope)).status).toBe(200);
    expect(serviceCalls()).toBe(1);
    expect(refusedLogs()).toHaveLength(0);
  });

  it('refuses a key without the route scope, before fetching a token', async () => {
    const { status } = await call(route, TokenScope.Full & ~route.scope);
    expect(status).toBe(403);
    expect(getOrchestratorToken).not.toHaveBeenCalled();
    expect(serviceCalls()).toBe(0);
    expect(refusedLogs()).toHaveLength(1);
  });

  it('refuses a key holding only the other AI Services scope and logs it, without user, key or address', async () => {
    const tokenScope = otherAIServicesScope(route);
    expect((await call(route, tokenScope)).status).toBe(403);
    const logs = refusedLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toEqual({
      name: 'orchestrator-endpoint-scope-refused',
      type: 'info',
      route: `/api/${route.name}`,
      requiredScope: route.scope,
      tokenScope,
      apiKeyType: ApiKeyType.User,
      client: 'personal-key',
      clientIdHash: undefined,
    });
  });

  it('logs a refused OAuth client by a hash of its id, not the id', async () => {
    const clientId = 'oauth-client-123';
    await call(route, otherAIServicesScope(route), { type: 'oauth', id: clientId });
    const [[event]] = refusedLogs() as [[{ client: string; clientIdHash: string }]];
    expect(event.client).toBe('oauth');
    expect(event.clientIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(event)).not.toContain(clientId);
  });

  it('answers 403 when the orchestrator token is refused for the caller', async () => {
    getOrchestratorToken.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'refused' })
    );
    expect((await call(route, route.scope)).status).toBe(403);
    expect(serviceCalls()).toBe(0);
    expect(refusedLogs()).toHaveLength(0);
  });
});

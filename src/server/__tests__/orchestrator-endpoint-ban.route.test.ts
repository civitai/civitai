import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import type * as GetOrchestratorToken from '~/server/orchestrator/get-orchestrator-token';
import type * as ServerAuthSession from '~/server/auth/get-server-auth-session';

// Every route behind OrchestratorEndpoint, through the real wrapper: a banned account gets a 403
// and no orchestrator token, whether its session already shows the ban or only the database does.

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
const routes: { name: string; method: string; load: () => Promise<{ default: unknown }> }[] = [
  {
    name: 'generation/workflows/[workflowId]/status-update',
    method: 'GET',
    load: () => import('~/pages/api/generation/workflows/[workflowId]/status-update'),
  },
  {
    name: 'orchestrator/refreshBlobs',
    method: 'POST',
    load: () => import('~/pages/api/orchestrator/refreshBlobs'),
  },
  {
    name: 'orchestrator/blobRatings',
    method: 'POST',
    load: () => import('~/pages/api/orchestrator/blobRatings'),
  },
  {
    name: 'orchestrator/getConsumerBlobUploadUrl',
    method: 'GET',
    load: () => import('~/pages/api/orchestrator/getConsumerBlobUploadUrl'),
  },
];

const USER = 4242;
const BANNED_IN_DATABASE = new TRPCError({ code: 'FORBIDDEN', message: 'banned' });

async function call(route: (typeof routes)[number]) {
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
    headers: {},
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
  it('serves an account in good standing', async () => {
    getServerAuthSession.mockResolvedValue({ user: { id: USER, bannedAt: null } });
    const { status } = await call(route);
    expect(status).toBe(200);
    expect(getOrchestratorToken).toHaveBeenCalledWith(USER, expect.anything());
    expect(serviceCalls()).toBe(1);
  });

  it('refuses a banned session without fetching a token', async () => {
    getServerAuthSession.mockResolvedValue({ user: { id: USER, bannedAt: new Date() } });
    const { status } = await call(route);
    expect(status).toBe(403);
    expect(getOrchestratorToken).not.toHaveBeenCalled();
    expect(serviceCalls()).toBe(0);
  });

  it('refuses with a 403 when only the database shows the ban', async () => {
    getServerAuthSession.mockResolvedValue({ user: { id: USER, bannedAt: null } });
    getOrchestratorToken.mockRejectedValue(BANNED_IN_DATABASE);
    const { status } = await call(route);
    expect(status).toBe(403);
    expect(serviceCalls()).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as ModeratorGrants from '~/server/services/moderator-grants';
import type * as DisputeReviewService from '~/server/services/creator-service-dispute-review.service';

/**
 * The dispute agent's system account holds `creatorServices.reviewDispute` and is NOT a moderator.
 * Through the real endpoint wrapper, it reaches exactly the three endpoints the review loop calls and
 * none of the ones that move Buzz or hand out files.
 */

const { mockGetSession, mockHasGrant, service } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockHasGrant: vi.fn(),
  service: {
    listDisputedServiceDeals: vi.fn(),
    resolveServiceDealDispute: vi.fn(),
    getServiceDisputeEvidence: vi.fn(),
    recordServiceDisputeReview: vi.fn(),
    listServiceDealFiles: vi.fn(),
    readServiceDealFileAccess: vi.fn(),
    resolveServiceDealFileDownload: vi.fn(),
    getServiceDealFileDownloadUrl: vi.fn(),
  },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (res: { status: (n: number) => { json: (b: unknown) => unknown } }) =>
    res.status(500).json({ error: 'handler threw' }),
}));
vi.mock('~/server/services/moderator-grants', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorGrants>()),
  hasModeratorGrant: mockHasGrant,
}));
vi.mock('~/server/services/creator-service-deal.service', () => service);
vi.mock('~/server/services/creator-service-dispute-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DisputeReviewService>()),
  ...service,
}));
vi.mock('~/server/services/creator-service-deal-file.service', () => service);
vi.mock('~/server/services/creator-service-deal-file-access', () => service);

type Endpoint = (req: never, res: never) => Promise<unknown>;
const load = async (name: string) =>
  (await import(`../../../pages/api/mod/creator-services/${name}.ts`)).default as Endpoint & {
    spec: { method: 'GET' | 'POST' };
  };

async function call(name: string, input: Record<string, unknown> = {}) {
  const endpoint = await load(name);
  const get = endpoint.spec.method === 'GET';
  const req = {
    method: endpoint.spec.method,
    headers: { authorization: 'Bearer system-key' },
    query: get ? input : {},
    body: get ? {} : input,
  };
  let status = 200;
  let payload: unknown;
  const res = {
    status: (code: number) => ((status = code), res),
    json: (body: unknown) => ((payload = body), res),
    setHeader: () => undefined,
  };
  await endpoint(req as never, res as never);
  return { status, payload };
}

const SYSTEM_ACCOUNT = { id: 13, isModerator: false, roles: ['dispute-agent'], bannedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.multi.mockImplementation(() => {
    const chain = {
      set: vi.fn().mockReturnThis(),
      incr: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(['OK', 1]),
    };
    return chain;
  });
  mockGetSession.mockResolvedValue({
    user: SYSTEM_ACCOUNT,
    apiKeyId: 1,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 1 },
    tokenScope: TokenScope.Full,
  });
  mockHasGrant.mockImplementation(
    async (_actor: unknown, id: string) => id === 'creatorServices.reviewDispute'
  );
  service.listDisputedServiceDeals.mockResolvedValue({ items: [] });
  service.getServiceDisputeEvidence.mockResolvedValue({ deal: { id: 15 } });
});

describe('a non-moderator holding creatorServices.reviewDispute', () => {
  it('lists the dispute queue', async () => {
    expect(await call('disputes')).toEqual({ status: 200, payload: { items: [] } });
  });

  it('reads dispute evidence', async () => {
    expect(await call('dispute-evidence', { dealId: '15' })).toEqual({
      status: 200,
      payload: { deal: { id: 15 } },
    });
    expect(service.getServiceDisputeEvidence).toHaveBeenCalledWith({ dealId: 15, viewerId: 13 });
  });

  it('gets past the role check on dispute-review', async () => {
    const { payload } = await call('dispute-review', {});
    expect(payload).not.toEqual({ error: 'Moderator role required' });
  });

  it.each(['resolve-dispute', 'deal-files', 'deal-file-url'])('is refused by %s', async (name) => {
    expect(await call(name, { dealId: '15', fileId: '18' })).toEqual({
      status: 403,
      payload: { error: 'Moderator role required' },
    });
    expect(service.resolveServiceDealDispute).not.toHaveBeenCalled();
    expect(service.listServiceDealFiles).not.toHaveBeenCalled();
    expect(service.getServiceDealFileDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('a non-moderator holding no grant', () => {
  it.each(['disputes', 'dispute-evidence', 'dispute-review'])('is refused by %s', async (name) => {
    mockHasGrant.mockResolvedValue(false);
    expect(await call(name, { dealId: '15' })).toEqual({
      status: 403,
      payload: { error: 'Moderator role required' },
    });
  });
});

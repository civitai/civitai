import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type * as DealService from '~/server/services/creator-service-deal.service';
import type * as DealFileService from '~/server/services/creator-service-deal-file.service';
import type * as DealFileAccess from '~/server/services/creator-service-deal-file-access';
import type * as DisputeReviewService from '~/server/services/creator-service-dispute-review.service';
import type * as ModeratorGrants from '~/server/services/moderator-grants';

const GRANT_ROLE = 'dispute-agent';

const { mockGetSession, mockHasGrant, service } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockHasGrant: vi.fn(),
  service: {
    listDisputedServiceDeals: vi.fn(),
    resolveServiceDealDispute: vi.fn(),
    getServiceDisputeEvidence: vi.fn(),
    createServiceDisputeReview: vi.fn(),
    listServiceDealFiles: vi.fn(),
    readServiceDealFileAccess: vi.fn(),
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
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => res.status(500).json({ error: 'handler threw', message: (e as Error).message }),
}));
vi.mock('~/server/services/moderator-grants', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeratorGrants>()),
  hasModeratorGrant: mockHasGrant,
}));
vi.mock('~/server/services/creator-service-deal.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DealService>()),
  listDisputedServiceDeals: service.listDisputedServiceDeals,
  resolveServiceDealDispute: service.resolveServiceDealDispute,
}));
vi.mock('~/server/services/creator-service-dispute-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DisputeReviewService>()),
  getServiceDisputeEvidence: service.getServiceDisputeEvidence,
  createServiceDisputeReview: service.createServiceDisputeReview,
}));
vi.mock('~/server/services/creator-service-deal-file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DealFileService>()),
  listServiceDealFiles: service.listServiceDealFiles,
  getServiceDealFileDownloadUrl: service.getServiceDealFileDownloadUrl,
}));
vi.mock('~/server/services/creator-service-deal-file-access', async (importOriginal) => ({
  ...(await importOriginal<typeof DealFileAccess>()),
  readServiceDealFileAccess: service.readServiceDealFileAccess,
}));

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

const signedInAs = (user: { isModerator: boolean; roles: string[] }) =>
  mockGetSession.mockResolvedValue({
    user: { id: 13, bannedAt: null, ...user },
    apiKeyId: 1,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 1 },
    tokenScope: TokenScope.Full,
  });

const REVIEW = {
  dealId: 15,
  class: 'B1',
  proposal: 'Release',
  confidence: 0.75,
  rationale: 'Buyer downloaded the final before disputing.',
  evidence: {},
  agentVersion: 'v0.2',
  mode: 'shadow',
  disputeOpenedAt: '2026-10-20T00:00:00Z',
};
const ROLE_REFUSED = { status: 403, payload: { error: 'Moderator role required' } };

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  signedInAs({ isModerator: false, roles: [GRANT_ROLE] });
  // Mirrors `hasModeratorGrant`: `moderator:admin` holds every grant, otherwise only the role the grant row lists.
  mockHasGrant.mockImplementation(
    async (user: { roles?: string[] }, id: string) =>
      !!user.roles?.includes('moderator:admin') ||
      (id === 'creatorServices.reviewDispute' && !!user.roles?.includes(GRANT_ROLE))
  );
  service.listDisputedServiceDeals.mockResolvedValue({ items: [] });
  service.getServiceDisputeEvidence.mockResolvedValue({ deal: { id: 15 } });
  service.createServiceDisputeReview.mockResolvedValue({ id: 3, createdAt: 'now' });
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

  it('writes a dispute review as itself', async () => {
    expect(await call('dispute-review', REVIEW)).toEqual({
      status: 200,
      payload: { id: 3, createdAt: 'now' },
    });
    expect(service.createServiceDisputeReview).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: 15, reviewerId: 13 })
    );
  });

  it.each(['resolve-dispute', 'deal-files', 'deal-file-url'])('is refused by %s', async (name) => {
    expect(await call(name, { dealId: '15', fileId: '18' })).toEqual(ROLE_REFUSED);
    expect(service.resolveServiceDealDispute).not.toHaveBeenCalled();
    expect(service.listServiceDealFiles).not.toHaveBeenCalled();
    expect(service.getServiceDealFileDownloadUrl).not.toHaveBeenCalled();
  });
});

describe.each([
  ['no grant role', []],
  ['only a kept moderator:admin role (a demoted moderator)', ['moderator:admin']],
])('a non-moderator with %s', (_label, roles) => {
  it.each(['disputes', 'dispute-evidence', 'dispute-review'])('is refused by %s', async (name) => {
    signedInAs({ isModerator: false, roles });
    expect(await call(name, name === 'dispute-review' ? REVIEW : { dealId: '15' })).toEqual(
      ROLE_REFUSED
    );
    expect(service.createServiceDisputeReview).not.toHaveBeenCalled();
  });
});

it("a moderator without the grant passes the wrapper but not dispute-review's own check", async () => {
  signedInAs({ isModerator: true, roles: [] });
  const { payload } = await call('dispute-review', REVIEW);
  expect(payload).toMatchObject({
    message: expect.stringContaining('creatorServices.reviewDispute'),
  });
  expect(service.createServiceDisputeReview).not.toHaveBeenCalled();
});

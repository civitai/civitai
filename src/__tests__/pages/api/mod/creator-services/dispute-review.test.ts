import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as DisputeReview from '~/server/services/creator-service-dispute-review.service';

/**
 * Who may read dispute evidence and who may write a review. `resolveDispute` alone can read the
 * evidence it rules on but cannot write a review; `reviewDispute` can do both and settles nothing.
 * The SQL is pinned against Postgres in `creator-service-deal.behavior.test.ts`.
 */

const { mockAudit, session, held, createReview, getEvidence } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  session: { user: {} as Record<string, unknown> },
  held: new Set<string>(),
  createReview: vi.fn(async () => ({ id: 1, createdAt: new Date(0) })),
  getEvidence: vi.fn(async () => ({ deal: { id: 4 } })),
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => {
    const status = e instanceof TRPCError ? getHTTPStatusCodeFromError(e) : 500;
    return res
      .status(status)
      .json({ error: (e as { code?: string }).code ?? 'error', message: (e as Error).message });
  },
}));
vi.mock('~/server/services/creator-service-dispute-review.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DisputeReview>()),
  createServiceDisputeReview: (...a: unknown[]) => createReview(...(a as [])),
  getServiceDisputeEvidence: (...a: unknown[]) => getEvidence(...(a as [])),
}));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: async (_user: unknown, id: string) => held.has(id),
}));

import evidenceHandler from '~/pages/api/mod/creator-services/dispute-evidence';
import reviewHandler from '~/pages/api/mod/creator-services/dispute-review';

const MODERATOR = 990000007;
const REVIEW = {
  dealId: 4,
  class: 'B1',
  proposal: 'Refund',
  confidence: 0.7,
  rationale: 'Finals are empty.',
  evidence: { marker: 'evidence-body' },
  agentVersion: 'agent-1',
  mode: 'shadow',
};

type Handler = typeof reviewHandler;
function call(handler: Handler, method: string, input: Record<string, unknown>) {
  const req = {
    method,
    headers: {},
    body: method === 'POST' ? input : undefined,
    query: method === 'GET' ? input : {},
  } as unknown as Parameters<Handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
  } as unknown as Parameters<Handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  held.clear();
  session.user = { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null };
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('dispute evidence', () => {
  it.each(['creatorServices.reviewDispute', 'creatorServices.resolveDispute'])(
    'is readable with %s alone',
    async (grant) => {
      held.add(grant);
      const { status } = await call(evidenceHandler, 'GET', { dealId: '4' });
      expect(status).toBe(200);
      expect(getEvidence).toHaveBeenCalledWith({ dealId: 4, viewerId: MODERATOR });
    }
  );

  it('is refused to a moderator with neither', async () => {
    const { status } = await call(evidenceHandler, 'GET', { dealId: '4' });
    expect(status).toBe(403);
    expect(getEvidence).not.toHaveBeenCalled();
  });
});

describe('writing a review', () => {
  it('is allowed with reviewDispute, as the session moderator', async () => {
    held.add('creatorServices.reviewDispute');
    const { status } = await call(reviewHandler, 'POST', REVIEW);
    expect(status).toBe(200);
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: 4, class: 'B1', mode: 'shadow', reviewerId: MODERATOR })
    );
  });

  it('is refused with resolveDispute alone', async () => {
    held.add('creatorServices.resolveDispute');
    const { status, body } = await call(reviewHandler, 'POST', REVIEW);
    expect(status).toBe(403);
    expect(body).toMatchObject({ message: expect.stringContaining('reviewDispute') });
    expect(createReview).not.toHaveBeenCalled();
  });

  it.each([
    ['class', { class: 'D' }],
    ['mode', { mode: 'auto' }],
    ['confidence', { confidence: 1.5 }],
    ['evidence size', { evidence: { blob: 'é'.repeat(40 * 1024) } }],
    ['evidence NUL', { evidence: { text: 'a\u0000b' } }],
  ])('refuses an unknown %s', async (_, override) => {
    held.add('creatorServices.reviewDispute');
    const { status } = await call(reviewHandler, 'POST', { ...REVIEW, ...override });
    expect(status).toBe(400);
    expect(createReview).not.toHaveBeenCalled();
  });

  it('keeps the evidence out of the audit row', async () => {
    held.add('creatorServices.reviewDispute');
    await call(reviewHandler, 'POST', REVIEW);
    expect(mockAudit).toHaveBeenCalled();
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('evidence-body');
    expect(JSON.stringify(mockAudit.mock.calls)).toContain('Finals are empty.');
  });
});

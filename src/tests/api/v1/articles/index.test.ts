import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';

// Hoisted mocks for the wrapped service + the rate limiter + the region helpers.
const { mockGetArticles, mockGetArticleById, mockRateLimit, mockGetRegion, mockIsRegionRestricted } =
  vi.hoisted(() => ({
    mockGetArticles: vi.fn(),
    mockGetArticleById: vi.fn(),
    mockRateLimit: vi.fn(),
    mockGetRegion: vi.fn(),
    mockIsRegionRestricted: vi.fn(),
  }));

vi.mock('~/server/services/article.service', () => ({
  getArticles: mockGetArticles,
  getArticleById: mockGetArticleById,
}));

vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: mockRateLimit,
}));

// MixedAuthEndpoint → passthrough that injects the test session user (req.user).
// handleEndpointError → faithful minimal reimplementation (TRPCError → mapped
// HTTP status), so a NOT_FOUND from the service becomes a 404.
vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint:
    (handler: any) =>
    (req: any, res: any) =>
      handler(req, res, req.user),
  handleEndpointError: (res: any, e: any) => {
    if (e instanceof TRPCError) {
      const status = getHTTPStatusCodeFromError(e);
      let body: unknown;
      try {
        body = JSON.parse(e.message);
      } catch {
        body = { message: e.message };
      }
      return res.status(status).json(body);
    }
    return res.status(500).json({ message: 'error', error: (e as Error).message });
  },
}));

// Region resolver kept deterministic — the clamp is derived ONLY from these
// helpers (never from the caller). Default: not restricted → the PUBLIC flag.
// Individual tests flip `mockIsRegionRestricted` to exercise the SFW narrowing.
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: mockGetRegion,
  isRegionRestricted: mockIsRegionRestricted,
}));

import listHandler from '~/pages/api/v1/articles/index';
import detailHandler from '~/pages/api/v1/articles/[id]';

function createMocks({
  query = {},
  user,
}: {
  query?: Record<string, string | string[]>;
  user?: { id: number; isModerator?: boolean; username?: string };
}) {
  let statusCode = 200;
  let payload: any = undefined;
  const headers: Record<string, string> = {};

  const req = {
    method: 'GET',
    headers: {},
    url: '/api/v1/articles',
    query,
    user,
  } as unknown as NextApiRequest & { user?: any };

  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: any) {
      payload = body;
      return res;
    },
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload,
    _getHeader: (name: string) => headers[name.toLowerCase()],
  } as unknown as NextApiResponse & {
    _getStatusCode: () => number;
    _getJSONData: () => any;
    _getHeader: (name: string) => string | undefined;
  };

  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockGetRegion.mockReturnValue({});
  mockIsRegionRestricted.mockReturnValue(false);
});

describe('GET /api/v1/articles (list)', () => {
  it('returns the { items, metadata } envelope and serializes the composite cursor', async () => {
    mockGetArticles.mockResolvedValue({
      items: [{ id: 1, title: 'a' }],
      nextCursor: { v: 123.5, id: 7 },
    });
    const { req, res } = createMocks({ query: { limit: '2' } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.items).toEqual([{ id: 1, title: 'a' }]);
    expect(body.metadata.nextCursor).toBe('123.5|7');
    expect(body.metadata.nextPage).toContain('cursor=123.5%7C7');
  });

  it('CACHEABILITY: the response is caller-independent — an authed caller gets byte-identical data to an anonymous caller for the same URL, and the service is called as anonymous in BOTH cases', async () => {
    mockGetArticles.mockResolvedValue({
      items: [{ id: 1, title: 'a' }],
      nextCursor: undefined,
    });

    const anon = createMocks({ query: { limit: '5' } });
    await listHandler(anon.req, anon.res);

    const authed = createMocks({ query: { limit: '5' }, user: { id: 42, username: 'me', isModerator: true } });
    await listHandler(authed.req, authed.res);

    // Same URL → byte-identical response body regardless of caller identity.
    expect(anon.res._getStatusCode()).toBe(200);
    expect(authed.res._getStatusCode()).toBe(200);
    expect(authed.res._getJSONData()).toEqual(anon.res._getJSONData());

    // The service is invoked with identical, PURELY-PUBLIC args in both calls —
    // no per-user widening (sessionUser is undefined even for the authed mod).
    const anonArgs = mockGetArticles.mock.calls[0][0];
    const authedArgs = mockGetArticles.mock.calls[1][0];
    expect(anonArgs.sessionUser).toBeUndefined();
    expect(authedArgs.sessionUser).toBeUndefined();
    expect(authedArgs).toEqual(anonArgs);
  });

  it('SECURITY: passes sessionUser=undefined + forceHidePrivate=true and NEVER a client-supplied userId/favorites/hidden (visibility evaluated as anonymous)', async () => {
    mockGetArticles.mockResolvedValue({ items: [], nextCursor: undefined });
    // A client tries to inject per-user / owner-widening params — the endpoint
    // schema doesn't expose any of them, so they can't reach the service.
    const { req, res } = createMocks({
      query: { userId: '5', userIds: '5,6', favorites: 'true', hidden: 'true', username: 'someUser' },
      user: { id: 5, username: 'someUser' },
    });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const args = mockGetArticles.mock.calls[0][0];
    // Anonymous evaluation — no session identity flows to the service.
    expect(args.sessionUser).toBeUndefined();
    expect(args.userIds).toBeUndefined();
    expect(args.userId).toBeUndefined();
    // Own-engagement filters are NOT accepted (removed from the public surface).
    expect(args.favorites).toBeUndefined();
    expect(args.hidden).toBeUndefined();
    // Even with a username filter (which normally lifts the private-drop for an
    // owner self-view), forceHidePrivate is pinned → availability=Private always
    // dropped, for EVERY caller.
    expect(args.username).toBe('someUser');
    expect(args.forceHidePrivate).toBe(true);
    // Non-nsfw + non-restricted region → public browsing ceiling.
    expect(args.browsingLevel).toBe(publicBrowsingLevelsFlag);
    // published-only guard pinned on top of the service's own gate.
    expect(args.period).toBe('AllTime');
    expect(args.periodMode).toBe('published');
  });

  it('400s on a malformed cursor', async () => {
    const { req, res } = createMocks({ query: { cursor: 'not-a-cursor' } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockGetArticles).not.toHaveBeenCalled();
  });

  it('RATE LIMIT: returns 429 + Retry-After and skips the service when the limiter denies', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });
    const { req, res } = createMocks({ query: {} });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeader('Retry-After')).toBe('42');
    // A 429 must NEVER be edge-cached (per-IP/per-user) — a cached public 429 would be served fleet-wide.
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(mockGetArticles).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/articles/[id] (detail)', () => {
  it('strips moderatorNsfwLevel and evaluates as anonymous (NEVER passes session userId/isModerator)', async () => {
    mockGetArticleById.mockResolvedValue({
      id: 3,
      title: 't',
      moderatorNsfwLevel: 8,
      nsfwLevel: 1,
    });
    // Even an authed moderator caller must be evaluated as anonymous.
    const { req, res } = createMocks({ query: { id: '3' }, user: { id: 9, isModerator: true } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toEqual({ id: 3, title: 't', nsfwLevel: 1 });
    expect(body.moderatorNsfwLevel).toBeUndefined();
    // No session identity reaches the service → published-only visibility for all.
    const args = mockGetArticleById.mock.calls[0][0];
    expect(args).toEqual({ id: 3 });
    expect(args.userId).toBeUndefined();
    expect(args.isModerator).toBeUndefined();
  });

  it('SECURITY: a private/unpublished article (service throws NOT_FOUND) 404s for an anonymous caller', async () => {
    mockGetArticleById.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'No article with id 99' })
    );
    const { req, res } = createMocks({ query: { id: '99' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  it('SECURITY: a private/unpublished article 404s IDENTICALLY for an authed caller (no owner-draft branch)', async () => {
    mockGetArticleById.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'No article with id 99' })
    );
    // An authed user who might be the owner still gets a 404 — the endpoint never
    // passes their identity, so the owner-draft self-view branch cannot fire.
    const { req, res } = createMocks({ query: { id: '99' }, user: { id: 5, isModerator: false } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(mockGetArticleById.mock.calls[0][0]).toEqual({ id: 99 });
  });

  it('MATURITY: drops a cover image above the region-narrowed PUBLIC ceiling (mature cover never leaked to an anon SFW caller)', async () => {
    mockGetArticleById.mockResolvedValue({
      id: 3,
      title: 't',
      nsfwLevel: NsfwLevel.PG,
      coverImage: { id: 1, url: 'k', nsfwLevel: NsfwLevel.R },
    });
    const { req, res } = createMocks({ query: { id: '3' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // R does NOT intersect the PG-only public flag → cover dropped.
    expect(res._getJSONData().coverImage).toBeUndefined();
  });

  it('MATURITY: preserves a cover within the public ceiling, and an unrated (0) cover is always allowed', async () => {
    mockGetArticleById.mockResolvedValueOnce({
      id: 3,
      title: 't',
      nsfwLevel: NsfwLevel.PG,
      coverImage: { id: 1, url: 'k', nsfwLevel: NsfwLevel.PG },
    });
    const within = createMocks({ query: { id: '3' } });
    await detailHandler(within.req, within.res);
    expect(within.res._getJSONData().coverImage).toEqual({ id: 1, url: 'k', nsfwLevel: NsfwLevel.PG });

    mockGetArticleById.mockResolvedValueOnce({
      id: 4,
      title: 't',
      nsfwLevel: NsfwLevel.PG,
      coverImage: { id: 2, url: 'k2', nsfwLevel: 0 },
    });
    const unrated = createMocks({ query: { id: '4' } });
    await detailHandler(unrated.req, unrated.res);
    expect(unrated.res._getJSONData().coverImage).toEqual({ id: 2, url: 'k2', nsfwLevel: 0 });
  });

  it('MATURITY/CACHEABILITY: the clamp reads NO per-user data — an authed (mod) caller gets byte-identical clamped output to an anon caller, and the service receives only { id } (no browsingLevel / userId)', async () => {
    // Fresh object per call so a shallow-copy mutation can never bleed across calls.
    mockGetArticleById.mockImplementation(async () => ({
      id: 3,
      title: 't',
      nsfwLevel: NsfwLevel.PG,
      coverImage: { id: 1, url: 'k', nsfwLevel: NsfwLevel.R },
    }));

    const anon = createMocks({ query: { id: '3' } });
    await detailHandler(anon.req, anon.res);
    const authed = createMocks({ query: { id: '3' }, user: { id: 42, isModerator: true } });
    await detailHandler(authed.req, authed.res);

    // Caller identity never feeds the clamp → identical output; mature cover
    // dropped for BOTH (no per-user widening).
    expect(authed.res._getJSONData()).toEqual(anon.res._getJSONData());
    expect(anon.res._getJSONData().coverImage).toBeUndefined();
    // Clamp is a POST-service filter → the service still gets just { id }.
    expect(mockGetArticleById.mock.calls[0][0]).toEqual({ id: 3 });
    expect(mockGetArticleById.mock.calls[1][0]).toEqual({ id: 3 });
  });

  it('MATURITY: the clamp is REGION-derived — a restricted region uses the SFW ceiling (PG-13 retained where the public default would drop it)', async () => {
    mockIsRegionRestricted.mockReturnValue(true);
    mockGetArticleById.mockResolvedValue({
      id: 3,
      title: 't',
      nsfwLevel: NsfwLevel.PG,
      coverImage: { id: 1, url: 'k', nsfwLevel: NsfwLevel.PG13 },
    });
    const { req, res } = createMocks({ query: { id: '3' } });

    await detailHandler(req, res);

    // Restricted → SFW ceiling (PG + PG-13) → the PG-13 cover is retained,
    // proving the clamp tracks the region helper (not `allBrowsingLevels`, not a
    // per-user value).
    expect(res._getJSONData().coverImage).toMatchObject({ nsfwLevel: NsfwLevel.PG13 });
  });

  it('400s on a non-numeric / out-of-range id', async () => {
    const { req, res } = createMocks({ query: { id: '99999999999999999999' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockGetArticleById).not.toHaveBeenCalled();
  });

  it('RATE LIMIT: 429 + Retry-After, service skipped', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 10 });
    const { req, res } = createMocks({ query: { id: '3' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeader('Retry-After')).toBe('10');
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(mockGetArticleById).not.toHaveBeenCalled();
  });
});

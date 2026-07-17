import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// Hoisted mocks for the wrapped service + the rate limiter + the author-cohort gate.
const { mockGetArticles, mockGetArticleById, mockRateLimit, mockIsAppBlocksAuthorEnabled } =
  vi.hoisted(() => ({
    mockGetArticles: vi.fn(),
    mockGetArticleById: vi.fn(),
    mockRateLimit: vi.fn(),
    mockIsAppBlocksAuthorEnabled: vi.fn(),
  }));

vi.mock('~/server/services/article.service', () => ({
  getArticles: mockGetArticles,
  getArticleById: mockGetArticleById,
}));

vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: mockRateLimit,
}));

// The App Blocks author-cohort gate — mock it so tests never touch real Flipt.
// Default: in-cohort (true) so the existing happy-path assertions still exercise
// the handler body; the dark-404 tests flip it to false.
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksAuthorEnabled: mockIsAppBlocksAuthorEnabled,
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

// Region resolver kept deterministic (not restricted) so browsingLevel is the
// public flag and assertions are stable.
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({}),
  isRegionRestricted: () => false,
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
  // Default: caller IS in the author cohort (mod / app-dev-tester) so the
  // existing behavioural tests reach the handler body. Dark-404 tests override.
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(true);
});

const PREVIEW_MESSAGE =
  'This API is in preview — access is restricted to Civitai moderators and app developers.';

describe('GET /api/v1/articles — author-cohort gate (403 preview)', () => {
  it('SECURITY: a non-cohort authed user gets a 403 + preview message and NEITHER the rate limiter NOR the service runs (list)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: {}, user: { id: 7, isModerator: false } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: PREVIEW_MESSAGE });
    expect(mockIsAppBlocksAuthorEnabled).toHaveBeenCalledWith({ user: { id: 7, isModerator: false } });
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockGetArticles).not.toHaveBeenCalled();
  });

  it('SECURITY: an anonymous caller gets a 403 + preview message (list)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: {} });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: PREVIEW_MESSAGE });
    expect(mockIsAppBlocksAuthorEnabled).toHaveBeenCalledWith({ user: undefined });
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockGetArticles).not.toHaveBeenCalled();
  });

  it('SECURITY: a non-cohort authed user gets a 403 + preview message (detail)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: { id: '3' }, user: { id: 7, isModerator: false } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: PREVIEW_MESSAGE });
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockGetArticleById).not.toHaveBeenCalled();
  });

  it('SECURITY: an anonymous caller gets a 403 + preview message (detail)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: { id: '3' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: PREVIEW_MESSAGE });
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockGetArticleById).not.toHaveBeenCalled();
  });
});

describe('CACHE: gated responses must be no-store (never edge-cached/cross-served)', () => {
  it('403 gate denial sets Cache-Control: no-store (list)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: {} });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
  });

  it('200 success sets Cache-Control: no-store (list)', async () => {
    mockGetArticles.mockResolvedValue({ items: [{ id: 1 }], nextCursor: undefined });
    const { req, res } = createMocks({ query: {}, user: { id: 7, isModerator: true } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
  });

  it('403 gate denial sets Cache-Control: no-store (detail)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: { id: '3' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
  });

  it('200 success sets Cache-Control: no-store (detail)', async () => {
    mockGetArticleById.mockResolvedValue({ id: 3, title: 't', moderatorNsfwLevel: 8, nsfwLevel: 1 });
    const { req, res } = createMocks({ query: { id: '3' }, user: { id: 7, isModerator: true } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
  });
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

  it('SECURITY: unauthenticated call passes sessionUser=undefined and NEVER a client-supplied userId (visibility delegated to the gated service)', async () => {
    mockGetArticles.mockResolvedValue({ items: [], nextCursor: undefined });
    // A client tries to inject userId — the endpoint schema doesn't expose it.
    const { req, res } = createMocks({ query: { userId: '5', userIds: '5,6' } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const args = mockGetArticles.mock.calls[0][0];
    expect(args.sessionUser).toBeUndefined();
    expect(args.userIds).toBeUndefined();
    expect(args.userId).toBeUndefined();
    // Non-nsfw + non-restricted region → public browsing ceiling.
    expect(args.browsingLevel).toBe(publicBrowsingLevelsFlag);
    // published-only guard pinned on top of the service's own gate.
    expect(args.period).toBe('AllTime');
    expect(args.periodMode).toBe('published');
    expect(args.favorites).toBe(false);
    expect(args.hidden).toBe(false);
  });

  it('SECURITY: anon ?username=X forces forceHidePrivate=true so private-availability articles are never listed', async () => {
    mockGetArticles.mockResolvedValue({ items: [], nextCursor: undefined });
    const { req, res } = createMocks({ query: { username: 'someUser' } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const args = mockGetArticles.mock.calls[0][0];
    // Even with a username filter (which normally lifts the private-drop for an
    // owner self-view), the REST surface pins forceHidePrivate → the service
    // ALWAYS drops availability=Private articles.
    expect(args.username).toBe('someUser');
    expect(args.forceHidePrivate).toBe(true);
    expect(args.sessionUser).toBeUndefined();
  });

  it('401s when an unauthenticated caller requests favorites/hidden (own-engagement, authed-only)', async () => {
    const { req, res } = createMocks({ query: { favorites: 'true' } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(mockGetArticles).not.toHaveBeenCalled();
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
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(mockGetArticles).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/articles/[id] (detail)', () => {
  it('strips moderatorNsfwLevel and returns the article; passes session identity (undefined when unauthed)', async () => {
    mockGetArticleById.mockResolvedValue({
      id: 3,
      title: 't',
      moderatorNsfwLevel: 8,
      nsfwLevel: 1,
    });
    const { req, res } = createMocks({ query: { id: '3' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toEqual({ id: 3, title: 't', nsfwLevel: 1 });
    expect(body.moderatorNsfwLevel).toBeUndefined();
    const args = mockGetArticleById.mock.calls[0][0];
    expect(args).toMatchObject({ id: 3, userId: undefined, isModerator: undefined });
  });

  it('SECURITY: a private/unpublished article (service throws NOT_FOUND for a non-owner) 404s', async () => {
    mockGetArticleById.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'No article with id 99' })
    );
    const { req, res } = createMocks({ query: { id: '99' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
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
    expect(mockGetArticleById).not.toHaveBeenCalled();
  });
});

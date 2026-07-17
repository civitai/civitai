import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

const {
  mockGetAllCollections,
  mockGetCollectionItemCount,
  mockGetUserCollectionsWithPermissions,
  mockGetUserCollectionPermissionsById,
  mockGetCollectionById,
  mockRateLimit,
  mockIsAppBlocksAuthorEnabled,
} = vi.hoisted(() => ({
  mockGetAllCollections: vi.fn(),
  mockGetCollectionItemCount: vi.fn(),
  mockGetUserCollectionsWithPermissions: vi.fn(),
  mockGetUserCollectionPermissionsById: vi.fn(),
  mockGetCollectionById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockIsAppBlocksAuthorEnabled: vi.fn(),
}));

vi.mock('~/server/services/collection.service', () => ({
  getAllCollections: mockGetAllCollections,
  getCollectionItemCount: mockGetCollectionItemCount,
  getUserCollectionsWithPermissions: mockGetUserCollectionsWithPermissions,
  getUserCollectionPermissionsById: mockGetUserCollectionPermissionsById,
  getCollectionById: mockGetCollectionById,
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

vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (url: string) => `edge:${url}`,
}));

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

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({}),
  isRegionRestricted: () => false,
}));

import listHandler from '~/pages/api/v1/collections/index';
import detailHandler from '~/pages/api/v1/collections/[id]';

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
    url: '/api/v1/collections',
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
  mockGetCollectionItemCount.mockResolvedValue([]);
  // Default: caller IS in the author cohort (mod / app-dev-tester) so the
  // existing behavioural tests reach the handler body. Dark-404 tests override.
  mockIsAppBlocksAuthorEnabled.mockResolvedValue(true);
});

const PREVIEW_MESSAGE =
  'This API is in preview — access is restricted to Civitai moderators and app developers.';

describe('GET /api/v1/collections — author-cohort gate (403 preview)', () => {
  it('SECURITY: a non-cohort authed user gets a 403 + preview message and NEITHER the rate limiter NOR the service runs (list)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: {}, user: { id: 7, isModerator: false } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: PREVIEW_MESSAGE });
    expect(mockIsAppBlocksAuthorEnabled).toHaveBeenCalledWith({ user: { id: 7, isModerator: false } });
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockGetAllCollections).not.toHaveBeenCalled();
  });

  it('SECURITY: an anonymous caller gets a 403 + preview message (list)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: {} });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: PREVIEW_MESSAGE });
    expect(mockIsAppBlocksAuthorEnabled).toHaveBeenCalledWith({ user: undefined });
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockGetAllCollections).not.toHaveBeenCalled();
  });

  it('SECURITY: a non-cohort authed user gets a 403 + preview message (detail)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: { id: '55' }, user: { id: 7, isModerator: false } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: PREVIEW_MESSAGE });
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockGetUserCollectionPermissionsById).not.toHaveBeenCalled();
  });

  it('SECURITY: an anonymous caller gets a 403 + preview message (detail)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toEqual({ error: PREVIEW_MESSAGE });
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockGetUserCollectionPermissionsById).not.toHaveBeenCalled();
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
    mockGetAllCollections.mockResolvedValue([]);
    const { req, res } = createMocks({ query: {}, user: { id: 7, isModerator: true } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
  });

  it('403 gate denial sets Cache-Control: no-store (detail)', async () => {
    mockIsAppBlocksAuthorEnabled.mockResolvedValue(false);
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
  });

  it('200 success sets Cache-Control: no-store (detail)', async () => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({ read: true, write: false, manage: false });
    mockGetCollectionById.mockResolvedValue({
      id: 55,
      name: 'pub',
      description: 'd',
      type: 'Image',
      nsfwLevel: 1,
      read: CollectionReadConfiguration.Public,
      userId: 2,
      user: { id: 2, username: 'bob' },
      image: null,
      tags: [],
    });
    const { req, res } = createMocks({ query: { id: '55' }, user: { id: 7, isModerator: true } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getHeader('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/v1/collections (list)', () => {
  it('public mode: queries getAllCollections with privacy pinned to [Public] and returns the envelope', async () => {
    mockGetAllCollections.mockResolvedValue([
      {
        id: 10,
        name: 'c',
        description: null,
        read: CollectionReadConfiguration.Public,
        type: 'Image',
        nsfwLevel: 1,
        userId: 2,
        user: { id: 2, username: 'bob' },
        image: null,
      },
    ]);
    const { req, res } = createMocks({ query: { limit: '5' } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const args = mockGetAllCollections.mock.calls[0][0];
    // SECURITY: privacy forced to Public (service also re-clamps for non-mods).
    expect(args.input.privacy).toEqual([CollectionReadConfiguration.Public]);
    const body = res._getJSONData();
    expect(body.items[0]).toMatchObject({ id: 10, name: 'c', isPublic: true });
    expect(body).toHaveProperty('metadata');
  });

  it('SECURITY: mine=true requires auth → 401 when unauthenticated, and the service is not called', async () => {
    const { req, res } = createMocks({ query: { mine: 'true' } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(mockGetUserCollectionsWithPermissions).not.toHaveBeenCalled();
    expect(mockGetAllCollections).not.toHaveBeenCalled();
  });

  it('mine=true (authed): keys getUserCollectionsWithPermissions on the SESSION user id, never a client param', async () => {
    mockGetUserCollectionsWithPermissions.mockResolvedValue([
      {
        id: 20,
        name: 'mine',
        description: null,
        read: CollectionReadConfiguration.Private,
        type: 'Image',
        userId: 99,
        image: undefined,
      },
    ]);
    const { req, res } = createMocks({
      query: { mine: 'true', userId: '1' },
      user: { id: 99, username: 'me' },
    });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetUserCollectionsWithPermissions).toHaveBeenCalledWith({
      input: { userId: 99, contributingOnly: true },
    });
    const body = res._getJSONData();
    // Owner sees their OWN private collection in the mine listing.
    expect(body.items[0]).toMatchObject({ id: 20, isPublic: false });
  });

  it('PAGINATION: rejects a cursor combined with sort=Most Followers (id cursor is inconsistent with the contributor ordering)', async () => {
    const { req, res } = createMocks({
      query: { sort: 'Most Followers', cursor: '10' },
    });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(400);
    expect(mockGetAllCollections).not.toHaveBeenCalled();
    expect(res._getJSONData().error).toMatch(/cursor/i);
  });

  it('PAGINATION: sort=Most Followers WITHOUT a cursor (first page) is allowed', async () => {
    mockGetAllCollections.mockResolvedValue([]);
    const { req, res } = createMocks({ query: { sort: 'Most Followers' } });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(mockGetAllCollections).toHaveBeenCalled();
    expect(mockGetAllCollections.mock.calls[0][0].input.sort).toBe('Most Followers');
  });

  it('RATE LIMIT: 429 + Retry-After, no service call', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const { req, res } = createMocks({ query: {} });

    await listHandler(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeader('Retry-After')).toBe('30');
    expect(mockGetAllCollections).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/collections/[id] (detail)', () => {
  it('SECURITY: no read permission → 404 and getCollectionById is NEVER called (private collection unreachable, no existence oracle)', async () => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({
      read: false,
      write: false,
      manage: false,
    });
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(mockGetCollectionById).not.toHaveBeenCalled();
  });

  it('returns the collection projection when read permission is granted', async () => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({
      read: true,
      write: false,
      manage: false,
    });
    mockGetCollectionById.mockResolvedValue({
      id: 55,
      name: 'pub',
      description: 'd',
      type: 'Image',
      nsfwLevel: 1,
      read: CollectionReadConfiguration.Public,
      userId: 2,
      user: { id: 2, username: 'bob' },
      image: { url: 'img-key', type: 'image', nsfwLevel: 1 },
      tags: [{ id: 3, name: 'tag', filterableOnly: false }],
    });
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toMatchObject({
      id: 55,
      name: 'pub',
      isPublic: true,
      coverImageUrl: 'edge:img-key',
      user: { id: 2, username: 'bob' },
      tags: [{ id: 3, name: 'tag' }],
    });
  });

  it('404s (via handleEndpointError) when the collection row is gone despite a permission grant', async () => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({
      read: true,
      write: false,
      manage: false,
    });
    mockGetCollectionById.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'No collection with id 55' })
    );
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
  });

  it('RATE LIMIT: 429 + Retry-After, no permission/service call', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 15 });
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(res._getHeader('Retry-After')).toBe('15');
    expect(mockGetUserCollectionPermissionsById).not.toHaveBeenCalled();
  });
});

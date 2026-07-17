import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';

const {
  mockGetAllCollections,
  mockGetCollectionItemCount,
  mockGetUserCollectionPermissionsById,
  mockGetCollectionById,
  mockRateLimit,
} = vi.hoisted(() => ({
  mockGetAllCollections: vi.fn(),
  mockGetCollectionItemCount: vi.fn(),
  mockGetUserCollectionPermissionsById: vi.fn(),
  mockGetCollectionById: vi.fn(),
  mockRateLimit: vi.fn(),
}));

vi.mock('~/server/services/collection.service', () => ({
  getAllCollections: mockGetAllCollections,
  getCollectionItemCount: mockGetCollectionItemCount,
  getUserCollectionPermissionsById: mockGetUserCollectionPermissionsById,
  getCollectionById: mockGetCollectionById,
}));

vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: mockRateLimit,
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
});

describe('GET /api/v1/collections (list)', () => {
  it('queries getAllCollections with privacy pinned to [Public], evaluated as anonymous (user: undefined), and returns the envelope', async () => {
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
    // SECURITY: privacy forced to Public AND no session user passed → the service
    // clamps to Public unconditionally (even a mod override can't widen).
    expect(args.input.privacy).toEqual([CollectionReadConfiguration.Public]);
    expect(args.user).toBeUndefined();
    const body = res._getJSONData();
    expect(body.items[0]).toMatchObject({ id: 10, name: 'c', isPublic: true });
    expect(body).toHaveProperty('metadata');
  });

  it('CACHEABILITY: the response is caller-independent — an authed caller gets byte-identical data to an anonymous caller, and getAllCollections is called as anonymous (user: undefined) in BOTH cases', async () => {
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

    const anon = createMocks({ query: { limit: '5' } });
    await listHandler(anon.req, anon.res);

    const authed = createMocks({ query: { limit: '5' }, user: { id: 42, username: 'me', isModerator: true } });
    await listHandler(authed.req, authed.res);

    expect(anon.res._getStatusCode()).toBe(200);
    expect(authed.res._getStatusCode()).toBe(200);
    // Same URL → byte-identical body regardless of caller identity.
    expect(authed.res._getJSONData()).toEqual(anon.res._getJSONData());
    // The service is invoked with identical, purely-public args (no session user)
    // even for the authed moderator.
    const anonArgs = mockGetAllCollections.mock.calls[0][0];
    const authedArgs = mockGetAllCollections.mock.calls[1][0];
    expect(anonArgs.user).toBeUndefined();
    expect(authedArgs.user).toBeUndefined();
    expect(authedArgs.input.privacy).toEqual([CollectionReadConfiguration.Public]);
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
  it('SECURITY: no read permission → 404 and getCollectionById is NEVER called (private collection unreachable, no existence oracle); permissions evaluated as anonymous', async () => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({
      read: false,
      write: false,
      manage: false,
    });
    // Even an authed caller is evaluated as anonymous — no owner/mod widening.
    const { req, res } = createMocks({ query: { id: '55' }, user: { id: 7, isModerator: true } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(404);
    expect(mockGetCollectionById).not.toHaveBeenCalled();
    // Permission check never receives session identity.
    expect(mockGetUserCollectionPermissionsById.mock.calls[0][0]).toEqual({ id: 55 });
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

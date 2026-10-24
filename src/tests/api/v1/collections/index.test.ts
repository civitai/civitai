import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  CollectionReadConfiguration,
  ImageIngestionStatus,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { NsfwLevel } from '~/server/common/enums';

type TestUser = { id: number; isModerator?: boolean; username?: string };
type TestRequest = NextApiRequest & { user?: TestUser };
type TestHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  user: TestUser | undefined
) => unknown;
type TestResponseBody = Record<string, unknown> & { items: Record<string, unknown>[] };

const {
  mockGetAllCollections,
  mockGetCollectionItemCount,
  mockGetUserCollectionPermissionsById,
  mockGetCollectionById,
  mockRateLimit,
  mockGetRegion,
  mockIsRegionRestricted,
  mockGetEdgeUrl,
} = vi.hoisted(() => ({
  mockGetAllCollections: vi.fn(),
  mockGetCollectionItemCount: vi.fn(),
  mockGetUserCollectionPermissionsById: vi.fn(),
  mockGetCollectionById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetRegion: vi.fn(),
  mockIsRegionRestricted: vi.fn(),
  mockGetEdgeUrl: vi.fn((url: string) => `edge:${url}`),
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

vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: mockGetEdgeUrl,
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: TestHandler) => (req: TestRequest, res: NextApiResponse) =>
    handler(req, res, req.user),
  handleEndpointError: (res: NextApiResponse, e: unknown) => {
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

// Region resolver kept deterministic — the maturity clamp is derived ONLY from
// these helpers (never from the caller). Default: not restricted → PUBLIC flag.
// Individual tests flip `mockIsRegionRestricted` to exercise the SFW narrowing.
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: mockGetRegion,
  isRegionRestricted: mockIsRegionRestricted,
}));

import listHandler from '~/pages/api/v1/collections/index';
import detailHandler from '~/pages/api/v1/collections/[id]';

type CoverFixture = {
  id: number;
  url: string;
  type: MediaType | null;
  width: number | null;
  height: number | null;
  nsfwLevel: number;
  ingestion: ImageIngestionStatus;
  scannedAt: Date | null;
  tosViolation: boolean;
  needsReview: string | null;
  blockedFor: string | null;
  poi: boolean;
  minor: boolean;
};

function createCover(overrides: Partial<CoverFixture> = {}): CoverFixture {
  return {
    id: 99,
    url: 'img-key',
    type: MediaType.image,
    width: 1200,
    height: 800,
    nsfwLevel: NsfwLevel.PG,
    ingestion: ImageIngestionStatus.Scanned,
    scannedAt: new Date('2026-01-01T00:00:00Z'),
    tosViolation: false,
    needsReview: null,
    blockedFor: null,
    poi: false,
    minor: false,
    ...overrides,
  };
}

function createMocks({
  query = {},
  user,
}: {
  query?: Record<string, string | string[]>;
  user?: TestUser;
}) {
  let statusCode = 200;
  let payload: unknown = undefined;
  const headers: Record<string, string> = {};

  const req = {
    method: 'GET',
    headers: {},
    url: '/api/v1/collections',
    query,
    user,
  } as unknown as TestRequest;

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
    json(body: unknown) {
      payload = body;
      return res;
    },
    end() {
      return res;
    },
    _getStatusCode: () => statusCode,
    _getJSONData: () => payload as TestResponseBody,
    _getHeader: (name: string) => headers[name.toLowerCase()],
  } as unknown as NextApiResponse & {
    _getStatusCode: () => number;
    _getJSONData: () => TestResponseBody;
    _getHeader: (name: string) => string | undefined;
  };

  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockGetCollectionItemCount.mockResolvedValue([]);
  mockGetRegion.mockReturnValue({});
  mockIsRegionRestricted.mockReturnValue(false);
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

    const authed = createMocks({
      query: { limit: '5' },
      user: { id: 42, username: 'me', isModerator: true },
    });
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
    // A 429 must NEVER be edge-cached (per-IP/per-user) — a cached public 429 would be served fleet-wide.
    expect(res._getHeader('Cache-Control')).toBe('no-store');
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
      image: createCover(),
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
      coverImage: {
        id: 99,
        url: 'edge:img-key',
        type: 'image',
        width: 1200,
        height: 800,
        nsfwLevel: 1,
      },
      mode: null,
      user: { id: 2, username: 'bob' },
      tags: [{ id: 3, name: 'tag' }],
    });
  });

  it('withholds covers above the public browsing level', async () => {
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
      nsfwLevel: NsfwLevel.R,
      read: CollectionReadConfiguration.Public,
      userId: 2,
      user: { id: 2, username: 'bob' },
      image: createCover({ nsfwLevel: NsfwLevel.R }),
      tags: [],
    });
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getStatusCode()).toBe(200);
    // R does NOT intersect the PG-only public flag → cover URL nulled. Under the
    // old `allBrowsingLevels` clamp this R cover would have leaked.
    expect(res._getJSONData().coverImageUrl).toBeNull();
  });

  it('MATURITY/CACHEABILITY: the clamp reads NO per-user data — an authed (mod) caller gets byte-identical clamped output to an anon caller', async () => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({
      read: true,
      write: false,
      manage: false,
    });
    mockGetCollectionById.mockImplementation(async () => ({
      id: 55,
      name: 'pub',
      description: 'd',
      type: 'Image',
      nsfwLevel: NsfwLevel.R,
      read: CollectionReadConfiguration.Public,
      userId: 2,
      user: { id: 2, username: 'bob' },
      image: createCover({ nsfwLevel: NsfwLevel.R }),
      tags: [],
    }));

    const anon = createMocks({ query: { id: '55' } });
    await detailHandler(anon.req, anon.res);
    const authed = createMocks({ query: { id: '55' }, user: { id: 7, isModerator: true } });
    await detailHandler(authed.req, authed.res);

    // Caller identity never feeds the clamp → identical output; mature cover
    // nulled for BOTH.
    expect(authed.res._getJSONData()).toEqual(anon.res._getJSONData());
    expect(anon.res._getJSONData().coverImageUrl).toBeNull();
  });

  it('MATURITY: the clamp is REGION-derived — a restricted region uses the SFW ceiling (PG-13 cover retained where the public default would null it)', async () => {
    mockIsRegionRestricted.mockReturnValue(true);
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
      nsfwLevel: NsfwLevel.PG13,
      read: CollectionReadConfiguration.Public,
      userId: 2,
      user: { id: 2, username: 'bob' },
      image: createCover({ nsfwLevel: NsfwLevel.PG13 }),
      tags: [],
    });
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    // Restricted → SFW ceiling (PG + PG-13) → the PG-13 cover survives, proving
    // the clamp tracks the region helper (not a fixed max, not a per-user value).
    expect(res._getJSONData().coverImageUrl).toBe('edge:img-key');
  });

  it.each(['Model', 'Article', 'Post', 'Image', 'Model3D', null])(
    'returns the shared metadata contract for collection type %s',
    async (type) => {
      mockGetUserCollectionPermissionsById.mockResolvedValue({ read: true });
      mockGetCollectionById.mockResolvedValue({
        id: 55,
        name: 'Examples',
        description: 'A collection description.',
        type,
        mode: 'Contest',
        read: CollectionReadConfiguration.Unlisted,
        nsfwLevel: 1,
        image: null,
        userId: 2,
        tags: [{ id: 3, name: 'Portraits', filterableOnly: true }],
      });
      const { req, res } = createMocks({ query: { id: '55' } });

      await detailHandler(req, res);

      expect(res._getJSONData()).toMatchObject({
        type,
        mode: 'Contest',
        description: 'A collection description.',
        read: CollectionReadConfiguration.Unlisted,
        isPublic: false,
        tags: [{ id: 3, name: 'Portraits' }],
        coverImage: null,
        coverImageUrl: null,
      });
      expect(mockGetUserCollectionPermissionsById).toHaveBeenCalledWith({ id: 55 });
    }
  );

  it.each(['Contest', 'Bookmark', null])('preserves collection mode %s', async (mode) => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({ read: true });
    mockGetCollectionById.mockResolvedValue({
      id: 55,
      name: 'Examples',
      mode,
      read: CollectionReadConfiguration.Public,
      userId: 2,
      image: null,
      tags: [],
    });
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getJSONData().mode).toBe(mode);
  });

  it('returns video metadata without changing the legacy media URL convention', async () => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({ read: true });
    mockGetCollectionById.mockResolvedValue({
      id: 55,
      name: 'Examples',
      read: CollectionReadConfiguration.Public,
      nsfwLevel: 29,
      userId: 2,
      tags: [],
      image: createCover({
        url: 'video-key',
        type: MediaType.video,
        width: 1920,
        height: 1080,
      }),
    });
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getJSONData().coverImage).toEqual({
      id: 99,
      url: 'edge:video-key',
      type: 'video',
      width: 1920,
      height: 1080,
      nsfwLevel: NsfwLevel.PG,
    });
    expect(res._getJSONData().coverImageUrl).toBe('edge:video-key');
    expect(mockGetEdgeUrl.mock.calls).toEqual([['video-key', { width: 450, type: 'video' }]]);
  });

  it('keeps a permitted cover when its original dimensions are unknown', async () => {
    mockGetUserCollectionPermissionsById.mockResolvedValue({ read: true });
    mockGetCollectionById.mockResolvedValue({
      id: 55,
      name: 'Examples',
      read: CollectionReadConfiguration.Public,
      userId: 2,
      tags: [],
      image: createCover({ width: null, height: null }),
    });
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getJSONData()).toMatchObject({
      coverImage: { id: 99, width: null, height: null, nsfwLevel: NsfwLevel.PG },
      coverImageUrl: 'edge:img-key',
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
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(mockGetUserCollectionPermissionsById).not.toHaveBeenCalled();
  });
});

describe.each(['list', 'detail'] as const)('public collection cover checks (%s)', (endpoint) => {
  async function requestCover(image: CoverFixture | null) {
    const collection = {
      id: 55,
      name: 'Examples',
      nsfwLevel: NsfwLevel.PG,
      read: CollectionReadConfiguration.Public,
      userId: 2,
      tags: [],
      image,
    };
    mockGetAllCollections.mockResolvedValue([collection]);
    mockGetUserCollectionPermissionsById.mockResolvedValue({ read: true });
    mockGetCollectionById.mockResolvedValue(collection);
    const { req, res } = createMocks({ query: endpoint === 'list' ? {} : { id: '55' } });

    await (endpoint === 'list' ? listHandler : detailHandler)(req, res);

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    const item = endpoint === 'list' ? body.items[0] : body;
    expect(item.id).toBe(55);
    if (endpoint === 'list') expect(body.items).toHaveLength(1);
    return item;
  }

  it.each([
    { ingestion: ImageIngestionStatus.Pending },
    { ingestion: ImageIngestionStatus.Rescan },
    { ingestion: ImageIngestionStatus.Blocked },
    { scannedAt: null },
    { nsfwLevel: 0 },
    { nsfwLevel: NsfwLevel.Blocked },
    { nsfwLevel: NsfwLevel.PG | NsfwLevel.Blocked },
    { nsfwLevel: NsfwLevel.R },
    { needsReview: 'review' },
    { needsReview: '' },
    { tosViolation: true },
    { blockedFor: 'blocked' },
    { blockedFor: '' },
    { poi: true },
    { minor: true },
    { type: MediaType.audio },
    { type: null },
    { url: '' },
  ])('withholds ineligible covers without hiding the collection: %o', async (override) => {
    const item = await requestCover(createCover(override));

    expect(item.coverImageUrl).toBeNull();
    if (endpoint === 'detail') expect(item.coverImage).toBeNull();
    expect(mockGetEdgeUrl).not.toHaveBeenCalled();
  });

  it.each([MediaType.image, MediaType.video])('keeps eligible %s covers', async (type) => {
    const item = await requestCover(createCover({ type }));

    expect(item.coverImageUrl).toBe('edge:img-key');
    expect(mockGetEdgeUrl.mock.calls).toEqual([['img-key', { width: 450, type }]]);
  });

  it('keeps the collection when its cover image is missing', async () => {
    const item = await requestCover(null);

    expect(item.coverImageUrl).toBeNull();
    if (endpoint === 'detail') expect(item.coverImage).toBeNull();
    expect(mockGetEdgeUrl).not.toHaveBeenCalled();
  });
});

it('selects every public cover eligibility field in the list query', async () => {
  mockGetAllCollections.mockResolvedValue([]);
  const { req, res } = createMocks({ query: {} });

  await listHandler(req, res);

  expect(mockGetAllCollections.mock.calls[0][0].select.image).toMatchObject({
    select: {
      url: true,
      type: true,
      nsfwLevel: true,
      ingestion: true,
      scannedAt: true,
      tosViolation: true,
      needsReview: true,
      blockedFor: true,
      poi: true,
      minor: true,
    },
  });
});

it.each([
  { nsfw: 'true', restricted: false, rating: NsfwLevel.R, shown: true },
  { nsfw: 'true', restricted: true, rating: NsfwLevel.R, shown: false },
  { nsfw: 'false', restricted: false, rating: NsfwLevel.PG13, shown: false },
  { nsfw: 'false', restricted: true, rating: NsfwLevel.PG13, shown: true },
])(
  'preserves list browsing and regional ceilings: %o',
  async ({ nsfw, restricted, rating, shown }) => {
    mockIsRegionRestricted.mockReturnValue(restricted);
    mockGetAllCollections.mockResolvedValue([
      {
        id: 55,
        name: 'Examples',
        read: CollectionReadConfiguration.Public,
        nsfwLevel: 0,
        userId: 2,
        image: createCover({ nsfwLevel: rating }),
      },
    ]);
    const { req, res } = createMocks({ query: { nsfw } });

    await listHandler(req, res);

    const items = res._getJSONData().items;
    expect(items).toHaveLength(1);
    expect(items[0].coverImageUrl).toBe(shown ? 'edge:img-key' : null);
  }
);

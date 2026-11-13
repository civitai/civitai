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
import { dbMock } from '~/__tests__/mocks/db.mock';
import { imageSelect } from '~/server/selectors/image.selector';
import { publicCoverImageSelect } from '~/server/utils/public-cover-image';

const {
  mockGetAllCollections,
  mockGetCollectionItemCount,
  mockGetUserCollectionPermissionsById,
  mockGetCollectionById,
  mockRateLimit,
  mockGetRegion,
  mockIsRegionRestricted,
  mockWithServableCovers,
  mockGetHeldLevelsByPost,
} = vi.hoisted(() => ({
  mockWithServableCovers: vi.fn(),
  mockGetHeldLevelsByPost: vi.fn(),
  mockGetAllCollections: vi.fn(),
  mockGetCollectionItemCount: vi.fn(),
  mockGetUserCollectionPermissionsById: vi.fn(),
  mockGetCollectionById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetRegion: vi.fn(),
  mockIsRegionRestricted: vi.fn(),
}));

const mockImageFindUnique = dbMock.dbRead.image.findUnique;

type Row = Record<string, unknown>;
type FindUniqueArgs = { where: { id: number }; select: Row };
type ListSelect = Row & { image?: { select: Row } };

/** A cover every public check passes, with the fields `imageSelect` returns as well. */
const cleanCover = {
  id: 99,
  name: 'cover',
  url: 'img-key',
  type: MediaType.image,
  width: 512,
  height: 768,
  hash: 'hash',
  meta: null,
  userId: 2,
  generationProcess: null,
  postId: 7,
  metadata: {},
  createdAt: new Date('2026-01-01T00:00:00Z'),
  hideMeta: false,
  tags: [],
  nsfwLevel: NsfwLevel.PG,
  ingestion: ImageIngestionStatus.Scanned,
  scannedAt: new Date('2026-01-02T00:00:00Z'),
  tosViolation: false,
  needsReview: null,
  blockedFor: null,
  poi: false,
  minor: false,
  acceptableMinor: false,
};

/** What Prisma returns for `select`: only the selected keys, so an unselected field reads undefined. */
function pickSelected(row: Row, select: Record<string, unknown>): Row {
  return Object.fromEntries(
    Object.entries(select)
      .filter(([, on]) => !!on)
      .map(([key]) => [key, row[key]])
  );
}

vi.mock('~/server/services/collection.service', () => ({
  getAllCollections: mockGetAllCollections,
  getCollectionItemCount: mockGetCollectionItemCount,
  getUserCollectionPermissionsById: mockGetUserCollectionPermissionsById,
  getCollectionById: mockGetCollectionById,
}));

vi.mock('~/server/services/model.service', () => ({
  getHeldLevelsByPost: mockGetHeldLevelsByPost,
}));

vi.mock('~/server/services/collection-cover-visibility', () => ({
  withServableCovers: mockWithServableCovers,
}));

vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: mockRateLimit,
}));

vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (url: string) => `edge:${url}`,
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, req.user),
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

// Region resolver kept deterministic — the maturity clamp is derived ONLY from
// these helpers (never from the caller). Default: not restricted → PUBLIC flag.
// Individual tests flip `mockIsRegionRestricted` to exercise the SFW narrowing.
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: mockGetRegion,
  isRegionRestricted: mockIsRegionRestricted,
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
  mockGetRegion.mockReturnValue({});
  mockIsRegionRestricted.mockReturnValue(false);
  mockImageFindUnique.mockImplementation((async ({ where, select }: FindUniqueArgs) =>
    where.id === cleanCover.id ? pickSelected(cleanCover, select) : null) as never);
  mockWithServableCovers.mockImplementation(async (rows: unknown[]) => rows);
  mockGetHeldLevelsByPost.mockResolvedValue(new Map());
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
      mode: null,
      image: pickSelected(cleanCover, imageSelect),
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
    expect(res._getHeader('Cache-Control')).toBe('no-store');
    expect(mockGetUserCollectionPermissionsById).not.toHaveBeenCalled();
  });
});

const listCollection = {
  id: 10,
  name: 'c',
  description: null,
  read: CollectionReadConfiguration.Public,
  type: 'Image',
  mode: 'Contest',
  nsfwLevel: NsfwLevel.PG,
  userId: 2,
  user: { id: 2, username: 'bob' },
};

const detailCollection = {
  id: 55,
  name: 'pub',
  description: 'd',
  read: CollectionReadConfiguration.Public,
  type: 'Image',
  mode: 'Contest',
  nsfwLevel: NsfwLevel.PG,
  userId: 2,
  user: { id: 2, username: 'bob' },
  tags: [],
};

/** Serves `cover` the way the database would for the select each endpoint passes. */
function serveCover(cover: Row | null) {
  mockGetAllCollections.mockImplementation(async ({ select }: { select: ListSelect }) => [
    {
      ...pickSelected(listCollection, select),
      image: cover && select.image ? pickSelected(cover, select.image.select) : null,
    },
  ]);
  mockGetUserCollectionPermissionsById.mockResolvedValue({
    read: true,
    write: false,
    manage: false,
  });
  mockGetCollectionById.mockResolvedValue({
    ...detailCollection,
    image: cover ? pickSelected(cover, imageSelect) : null,
  });
  mockImageFindUnique.mockImplementation((async ({ where, select }: FindUniqueArgs) =>
    cover && where.id === cover.id ? pickSelected(cover, select) : null) as never);
}

async function requestCollection(
  endpoint: 'list' | 'detail',
  cover: Row | null,
  {
    query = {},
    user,
  }: { query?: Record<string, string>; user?: { id: number; isModerator?: boolean } } = {}
) {
  serveCover(cover);
  const { req, res } = createMocks({
    query: endpoint === 'list' ? query : { ...query, id: '55' },
    user,
  });

  await (endpoint === 'list' ? listHandler : detailHandler)(req, res);

  expect(res._getStatusCode()).toBe(200);
  const body = res._getJSONData();
  if (endpoint === 'detail') {
    expect(body.id).toBe(55);
    return body;
  }
  expect(body.items).toHaveLength(1);
  expect(body.items[0].id).toBe(10);
  return body.items[0];
}

describe.each(['list', 'detail'] as const)('public collection cover (%s)', (endpoint) => {
  it.each([MediaType.image, MediaType.video])(
    'shows a scanned, in-level %s cover with its metadata',
    async (type) => {
      const item = await requestCollection(endpoint, { ...cleanCover, type });

      expect(item.coverImageUrl).toBe('edge:img-key');
      expect(item.coverImage).toEqual({
        id: 99,
        url: 'edge:img-key',
        type,
        width: 512,
        height: 768,
        nsfwLevel: NsfwLevel.PG,
      });
    }
  );

  it('returns null dimensions for a cover without them', async () => {
    const item = await requestCollection(endpoint, { ...cleanCover, width: null, height: null });

    expect(item.coverImage).toMatchObject({ id: 99, width: null, height: null });
  });

  it('returns the collection mode', async () => {
    const item = await requestCollection(endpoint, null);

    expect(item.mode).toBe('Contest');
  });

  it.each<[string, Row]>([
    ['unrated (nsfwLevel 0)', { nsfwLevel: 0 }],
    ['unrated (nsfwLevel null)', { nsfwLevel: null }],
    ['ingestion Pending', { ingestion: ImageIngestionStatus.Pending }],
    ['ingestion Rescan', { ingestion: ImageIngestionStatus.Rescan }],
    ['ingestion Error', { ingestion: ImageIngestionStatus.Error }],
    ['ingestion Blocked', { ingestion: ImageIngestionStatus.Blocked }],
    ['ingestion NotFound', { ingestion: ImageIngestionStatus.NotFound }],
    [
      'ingestion PendingManualAssignment',
      { ingestion: ImageIngestionStatus.PendingManualAssignment },
    ],
    ['scannedAt null', { scannedAt: null }],
    ['needsReview csam', { needsReview: 'csam' }],
    ['needsReview minor', { needsReview: 'minor' }],
    ['needsReview poi', { needsReview: 'poi' }],
    ['needsReview empty string', { needsReview: '' }],
    ['tosViolation', { tosViolation: true }],
    ['blockedFor set', { blockedFor: 'moderated' }],
    ['blockedFor empty string', { blockedFor: '' }],
    ['poi', { poi: true }],
    ['minor', { minor: true }],
    ['acceptableMinor', { acceptableMinor: true }],
    ['rated above the browsing level', { nsfwLevel: NsfwLevel.R }],
    ['rated Blocked', { nsfwLevel: NsfwLevel.Blocked }],
    ['rated with Blocked among its levels', { nsfwLevel: NsfwLevel.PG | NsfwLevel.Blocked }],
    ['audio', { type: MediaType.audio }],
    ['without a media type', { type: null }],
    ['without a url', { url: '' }],
  ])('withholds the cover but keeps the collection: %s', async (_case, override) => {
    const item = await requestCollection(endpoint, { ...cleanCover, ...override });

    expect(item.coverImageUrl).toBeNull();
    expect(item.coverImage).toBeNull();
  });

  it('keeps the collection when it has no cover', async () => {
    const item = await requestCollection(endpoint, null);

    expect(item.coverImageUrl).toBeNull();
    expect(item.coverImage).toBeNull();
  });

  it('gives an authed moderator the same cover as an anonymous caller', async () => {
    const cover = { ...cleanCover, nsfwLevel: NsfwLevel.R };
    const anon = await requestCollection(endpoint, cover);
    const moderator = await requestCollection(endpoint, cover, {
      user: { id: 7, isModerator: true },
    });

    expect(moderator).toEqual(anon);
    expect(anon.coverImage).toBeNull();
  });

  it('narrows the browsing level for a restricted region', async () => {
    mockIsRegionRestricted.mockReturnValue(true);
    const query: Record<string, string> = endpoint === 'list' ? { nsfw: 'true' } : {};

    const pg13 = await requestCollection(
      endpoint,
      { ...cleanCover, nsfwLevel: NsfwLevel.PG13 },
      { query }
    );
    const r = await requestCollection(
      endpoint,
      { ...cleanCover, nsfwLevel: NsfwLevel.R },
      { query }
    );

    expect(pg13.coverImage).toMatchObject({ id: 99, nsfwLevel: NsfwLevel.PG13 });
    expect(r.coverImage).toBeNull();
  });
});

describe.each(['list', 'detail'] as const)('held gallery level on the cover (%s)', (endpoint) => {
  const query: Record<string, string> = endpoint === 'list' ? { nsfw: 'true' } : {};

  it('withholds a cover above the held level of its post', async () => {
    mockGetHeldLevelsByPost.mockResolvedValue(new Map([[7, { level: NsfwLevel.PG13 }]]));

    const item = await requestCollection(endpoint, cleanCover, { query });

    expect(mockGetHeldLevelsByPost).toHaveBeenCalledWith([7]);
    expect(item.coverImageUrl).toBeNull();
    expect(item.coverImage).toBeNull();
  });

  it('shows a cover within the held level of its post', async () => {
    mockGetHeldLevelsByPost.mockResolvedValue(
      new Map([[7, { level: NsfwLevel.PG | NsfwLevel.PG13 }]])
    );

    const item = await requestCollection(endpoint, cleanCover, { query });

    expect(item.coverImage).toMatchObject({ id: 99, nsfwLevel: NsfwLevel.PG });
  });

  it('judges a cover by its own post, not by a hold on another post', async () => {
    mockGetHeldLevelsByPost.mockResolvedValue(new Map([[8, { level: NsfwLevel.PG13 }]]));

    const item = await requestCollection(endpoint, cleanCover, { query });

    expect(item.coverImage).toMatchObject({ id: 99 });
  });
});

describe('public collection cover queries', () => {
  it('reads the list cover with the public cover select', async () => {
    await requestCollection('list', cleanCover);

    expect(mockGetAllCollections.mock.calls[0][0].select.image).toEqual({
      select: publicCoverImageSelect,
    });
  });

  it('reads the detail cover by the id getCollectionById returned, with the public cover select', async () => {
    await requestCollection('detail', cleanCover);

    expect(mockImageFindUnique).toHaveBeenCalledWith({
      where: { id: 99 },
      select: publicCoverImageSelect,
    });
  });

  it('skips the detail cover read when getCollectionById returned no cover', async () => {
    await requestCollection('detail', null);

    expect(mockImageFindUnique).not.toHaveBeenCalled();
  });

  it('withholds the detail cover when its image row is gone', async () => {
    serveCover(cleanCover);
    mockImageFindUnique.mockResolvedValue(null);
    const { req, res } = createMocks({ query: { id: '55' } });

    await detailHandler(req, res);

    expect(res._getJSONData().coverImage).toBeNull();
  });

  it('shows an R cover on the list when nsfw=true', async () => {
    const item = await requestCollection(
      'list',
      { ...cleanCover, nsfwLevel: NsfwLevel.R },
      {
        query: { nsfw: 'true' },
      }
    );

    expect(item.coverImage).toMatchObject({ id: 99, nsfwLevel: NsfwLevel.R });
  });

  it('keeps the list cover check behind the servable-cover filter, judged with no viewer', async () => {
    mockWithServableCovers.mockImplementation(async (rows: { image: unknown }[]) =>
      rows.map((r) => ({ ...r, image: null }))
    );
    serveCover(cleanCover);
    const { req, res } = createMocks({ query: {}, user: { id: 2 } });

    await listHandler(req, res);

    expect(mockWithServableCovers).toHaveBeenCalledWith([expect.objectContaining({ id: 10 })]);
    expect(res._getJSONData().items[0].coverImage).toBeNull();
  });
});

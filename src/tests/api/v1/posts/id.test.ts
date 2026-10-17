import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { NsfwLevel } from '~/server/common/enums';
import { Availability } from '~/shared/utils/prisma/enums';

const {
  mockGetPostDetail,
  mockRateLimit,
  mockIsRegionRestricted,
  mockRunImageSearch,
  mockAcquire,
} = vi.hoisted(() => ({
  mockGetPostDetail: vi.fn(),
  mockRateLimit: vi.fn(),
  mockIsRegionRestricted: vi.fn(),
  mockRunImageSearch: vi.fn(),
  mockAcquire: vi.fn(),
}));

vi.mock('~/server/services/post.service', () => ({ getPostDetail: mockGetPostDetail }));
vi.mock('~/server/utils/public-api-rate-limit', () => ({ checkPublicApiRateLimit: mockRateLimit }));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({ countryCode: 'XX' }),
  isRegionRestricted: mockIsRegionRestricted,
}));
vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (h: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      h(...args),
}));
vi.mock('~/server/services/image-search.service', () => ({ runImageSearch: mockRunImageSearch }));
vi.mock('~/server/utils/request-bulkhead', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestBulkhead>()),
  acquireBulkheadSlot: mockAcquire,
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

import '~/__tests__/mocks/db.mock';
import type * as RequestBulkhead from '~/server/utils/request-bulkhead';
import { BulkheadFullError } from '~/server/utils/request-bulkhead';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import handler from '~/pages/api/v1/posts/[id]';

const PUBLIC_CACHE = 'public, s-maxage=300, stale-while-revalidate=150';

/** Drives the REAL `MixedAuthEndpoint`, so the cache headers it stamps are observable. */
async function call(
  query: Record<string, string>,
  session?: { user: { id: number; isModerator?: boolean } }
) {
  vi.mocked(getServerAuthSession).mockResolvedValue((session ?? null) as never);
  const { req, res, header } = createRealApiPair({
    url: `/api/v1/posts/${query.id}`,
    query,
    headers: session ? { authorization: 'Bearer test' } : {},
  });
  let body: Record<string, unknown> | undefined;
  const json = res.json.bind(res);
  res.json = ((b: unknown) => {
    body = b as Record<string, unknown>;
    return json(b);
  }) as typeof res.json;

  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { statusCode: res.statusCode, body, header };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    id: 55288,
    nsfw: false,
    nsfwLevel: 1,
    title: 'A title',
    detail: '<p>A description</p>',
    modelVersionId: 7,
    modelVersion: { id: 7 },
    user: { id: 3, username: 'alice', image: null, deletedAt: null, cosmetics: [] },
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    availability: Availability.Public,
    tags: [{ id: 9, name: 'landscape', isCategory: false }],
    collectionId: 12,
    wasPublished: false,
    unpublishedAt: null,
    unpublishedBy: null,
    parentModelId: null,
    ...overrides,
  };
}

const release = vi.fn();

describe('GET /api/v1/posts/[id]', () => {
  beforeEach(() => {
    mockGetPostDetail.mockReset();
    mockRateLimit.mockReset().mockResolvedValue({ allowed: true });
    mockIsRegionRestricted.mockReset().mockReturnValue(false);
    mockRunImageSearch.mockReset().mockResolvedValue({ items: [] });
    mockAcquire.mockReset().mockReturnValue(release);
    release.mockClear();
  });

  it('returns the post’s title, description and public fields only', async () => {
    mockGetPostDetail.mockResolvedValue(post());

    const { statusCode, body } = await call({ id: '55288' });

    expect(statusCode).toBe(200);
    expect(body).toEqual({
      id: 55288,
      title: 'A title',
      detail: '<p>A description</p>',
      nsfwLevel: 1,
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      modelVersionId: 7,
      user: { id: 3, username: 'alice' },
      tags: [{ id: 9, name: 'landscape' }],
      images: [],
      hasMoreImages: false,
    });
  });

  it('asks for the post’s images in post order and returns them as given', async () => {
    mockGetPostDetail.mockResolvedValue(post());
    mockRunImageSearch.mockResolvedValue({ items: [{ id: 2 }, { id: 3 }, { id: 1 }] });

    const { body } = await call({ id: '55288' });

    expect(mockRunImageSearch.mock.calls[0][0]).toMatchObject({
      postOrder: true,
      limit: 100,
      throwOnStatementTimeout: true,
    });
    expect(body?.images).toEqual([{ id: 2 }, { id: 3 }, { id: 1 }]);
  });

  it.each([0, 99, 100])(
    'marks a complete %i-image gallery without guessing from its length',
    async (count) => {
      mockGetPostDetail.mockResolvedValue(post());
      const images = Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
      mockRunImageSearch.mockResolvedValue({ items: images, nextCursor: undefined });

      const { statusCode, body, header } = await call({ id: '55288' });

      expect(statusCode).toBe(200);
      expect(body?.images).toEqual(images);
      expect(body?.hasMoreImages).toBe(false);
      expect(header('Cache-Control')).toBe(PUBLIC_CACHE);
      expect(header('Retry-After')).toBeUndefined();
      expect(mockRunImageSearch).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['100', 100, 0, null])(
    'marks a truncated gallery with continuation %j',
    async (cursor) => {
      mockGetPostDetail.mockResolvedValue(post());
      const images = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
      mockRunImageSearch.mockResolvedValue({ items: images, nextCursor: cursor });

      const { statusCode, body } = await call({ id: '55288' });

      expect(statusCode).toBe(200);
      expect(body?.images).toEqual(images);
      expect(body?.hasMoreImages).toBe(true);
      expect(body).not.toHaveProperty('nextCursor');
      expect(mockRunImageSearch).toHaveBeenCalledTimes(1);
    }
  );

  it('searches this post’s images as anonymous, at every browsable level', async () => {
    mockGetPostDetail.mockResolvedValue(post());

    await call({ id: '55288' }, { user: { id: 3, isModerator: true } });

    expect(mockRunImageSearch).toHaveBeenCalledTimes(1);
    const [input, ctx] = mockRunImageSearch.mock.calls[0];
    expect(input).toMatchObject({ limit: 100, withMeta: false, withTags: false });
    expect(input.data).toMatchObject({ postId: 55288 });
    expect(ctx.browsingLevel).toBe(allBrowsingLevelsFlag);
    expect(ctx.user).toBeUndefined();
  });

  it('clamps the image search to SFW in a restricted region', async () => {
    mockIsRegionRestricted.mockReturnValue(true);
    mockGetPostDetail.mockResolvedValue(post());

    await call({ id: '55288' });

    expect(mockRunImageSearch.mock.calls[0][1].browsingLevel).toBe(sfwBrowsingLevelsFlag);
  });

  it('does not search for images of a post it will not serve', async () => {
    mockGetPostDetail.mockResolvedValue(post({ publishedAt: null }));

    await call({ id: '55288' });

    expect(mockRunImageSearch).not.toHaveBeenCalled();
  });

  it('503s without caching when the pod has no heavy-image slot free', async () => {
    mockGetPostDetail.mockResolvedValue(post());
    mockAcquire.mockImplementation(() => {
      throw new BulkheadFullError('heavy-image', 1);
    });

    const { statusCode, header } = await call({ id: '55288' });

    expect(statusCode).toBe(503);
    expect(header('Cache-Control')).toBe('no-store');
    expect(header('Retry-After')).toBe('2');
    expect(mockRunImageSearch).not.toHaveBeenCalled();
  });

  it('releases the heavy-image slot even when the image search fails', async () => {
    mockGetPostDetail.mockResolvedValue(post());
    mockRunImageSearch.mockRejectedValue(new Error('boom'));

    await call({ id: '55288' });

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('returns an uncached, retryable failure when the image query times out', async () => {
    mockGetPostDetail.mockResolvedValue(post());
    mockRunImageSearch.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    );

    const { statusCode, body, header } = await call({ id: '55288' });

    expect(statusCode).toBe(503);
    expect(body).toEqual({ error: 'Server busy, please retry shortly.' });
    expect(header('Cache-Control')).toBe('no-store');
    expect(header('Retry-After')).toBe('2');
    expect(body).not.toHaveProperty('images');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable failure if the post lookup times out before acquiring a slot', async () => {
    mockGetPostDetail.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
    );

    const { statusCode, body, header } = await call({ id: '55288' });

    expect(statusCode).toBe(503);
    expect(body).toEqual({ error: 'Server busy, please retry shortly.' });
    expect(header('Cache-Control')).toBe('no-store');
    expect(header('Retry-After')).toBe('2');
    expect(mockAcquire).not.toHaveBeenCalled();
    expect(mockRunImageSearch).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('does not classify a user cancellation as a statement timeout', async () => {
    mockGetPostDetail.mockResolvedValue(post());
    mockRunImageSearch.mockRejectedValue(
      Object.assign(new Error('canceling statement due to user request'), { code: '57014' })
    );

    const { statusCode, header } = await call({ id: '55288' });

    expect(statusCode).toBe(500);
    expect(header('Cache-Control')).toBe('no-store, max-age=0');
    expect(header('Retry-After')).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('looks the post up as anonymous even for a signed-in owner or moderator', async () => {
    mockGetPostDetail.mockResolvedValue(post());

    await call({ id: '55288' }, { user: { id: 3, isModerator: true } });

    expect(mockGetPostDetail).toHaveBeenCalledWith({ id: 55288 });
  });

  it('serves a mature post outside restricted regions', async () => {
    mockGetPostDetail.mockResolvedValue(post({ nsfwLevel: 16 }));

    const { statusCode } = await call({ id: '55288' });

    expect(statusCode).toBe(200);
  });

  it('404s a mature post in a restricted region, but still serves a safe one there', async () => {
    mockIsRegionRestricted.mockReturnValue(true);

    mockGetPostDetail.mockResolvedValue(post({ nsfwLevel: 16 }));
    expect((await call({ id: '55288' })).statusCode).toBe(404);

    mockGetPostDetail.mockResolvedValue(post({ nsfwLevel: 1 }));
    expect((await call({ id: '55288' })).statusCode).toBe(200);
  });

  it('404s a post mixing safe and mature images in a restricted region', async () => {
    mockIsRegionRestricted.mockReturnValue(true);
    mockGetPostDetail.mockResolvedValue(post({ nsfwLevel: 1 | 4 }));

    expect((await call({ id: '55288' })).statusCode).toBe(404);
  });

  it('404s a post whose every image is Blocked', async () => {
    mockGetPostDetail.mockResolvedValue(post({ nsfwLevel: NsfwLevel.Blocked }));

    expect((await call({ id: '55288' })).statusCode).toBe(404);
  });

  it('serves a post with some Blocked images alongside viewable ones', async () => {
    mockGetPostDetail.mockResolvedValue(post({ nsfwLevel: NsfwLevel.PG | NsfwLevel.Blocked }));

    expect((await call({ id: '55288' })).statusCode).toBe(200);
  });

  it('404s an unscanned post, in every region', async () => {
    mockGetPostDetail.mockResolvedValue(post({ nsfwLevel: 0 }));
    expect((await call({ id: '55288' })).statusCode).toBe(404);

    mockIsRegionRestricted.mockReturnValue(true);
    expect((await call({ id: '55288' })).statusCode).toBe(404);
  });

  it('404s a post that is unpublished or scheduled, whatever the service returned', async () => {
    mockGetPostDetail.mockResolvedValue(post({ publishedAt: null }));
    expect((await call({ id: '55288' })).statusCode).toBe(404);

    mockGetPostDetail.mockResolvedValue(post({ publishedAt: new Date(Date.now() + 60_000) }));
    expect((await call({ id: '55288' })).statusCode).toBe(404);
  });

  it('withholds the id of a model version that is not published', async () => {
    mockGetPostDetail.mockResolvedValue(post({ modelVersionId: 7, modelVersion: null }));

    const { body } = await call({ id: '55288' });

    expect(body?.modelVersionId).toBeNull();
  });

  it('serves only Public and Unsearchable posts', async () => {
    const statusFor = async (availability: Availability) => {
      mockGetPostDetail.mockResolvedValue(post({ availability }));
      return (await call({ id: '55288' })).statusCode;
    };

    expect(await statusFor(Availability.Public)).toBe(200);
    expect(await statusFor(Availability.Unsearchable)).toBe(200);
    expect(await statusFor(Availability.Private)).toBe(404);
    expect(await statusFor(Availability.EarlyAccess)).toBe(404);
  });

  it('404s a post the anonymous lookup cannot see', async () => {
    mockGetPostDetail.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));

    const { statusCode, body } = await call({ id: '55288' });

    expect(statusCode).toBe(404);
    expect(body).toEqual({ error: 'Post not found' });
  });

  it('keeps a 404 publicly cacheable, so the edge absorbs repeat misses', async () => {
    mockGetPostDetail.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
    const missing = await call({ id: '55288' });

    mockGetPostDetail.mockResolvedValue(post({ nsfwLevel: NsfwLevel.Blocked }));
    const withheld = await call({ id: '55288' });

    for (const { statusCode, header } of [missing, withheld]) {
      expect(statusCode).toBe(404);
      expect(header('Cache-Control')).toBe(PUBLIC_CACHE);
    }
  });

  it('400s an id that is not a positive int4', async () => {
    for (const id of ['abc', '0', '-1', '2147483648']) {
      expect((await call({ id })).statusCode).toBe(400);
    }
    expect(mockGetPostDetail).not.toHaveBeenCalled();
  });

  it('429s a rate-limited caller before looking anything up', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });

    const { statusCode, header } = await call({ id: '55288' });

    expect(statusCode).toBe(429);
    expect(header('Retry-After')).toBe('7');
    expect(header('Cache-Control')).toBe('no-store');
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ family: 'posts' }));
    expect(mockGetPostDetail).not.toHaveBeenCalled();
  });
});

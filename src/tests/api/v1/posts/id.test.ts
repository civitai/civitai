import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { NsfwLevel } from '~/server/common/enums';
import { Availability } from '~/shared/utils/prisma/enums';

const { mockGetPostDetail, mockRateLimit, mockIsRegionRestricted } = vi.hoisted(() => ({
  mockGetPostDetail: vi.fn(),
  mockRateLimit: vi.fn(),
  mockIsRegionRestricted: vi.fn(),
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
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
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
    body = b;
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

describe('GET /api/v1/posts/[id]', () => {
  beforeEach(() => {
    mockGetPostDetail.mockReset();
    mockRateLimit.mockReset().mockResolvedValue({ allowed: true });
    mockIsRegionRestricted.mockReset().mockReturnValue(false);
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
    });
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

    expect(body.modelVersionId).toBeNull();
  });

  it('404s a private post', async () => {
    mockGetPostDetail.mockResolvedValue(post({ availability: Availability.Private }));

    expect((await call({ id: '55288' })).statusCode).toBe(404);
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

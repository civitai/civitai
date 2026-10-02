import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
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
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, req.user),
}));

import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import handler from '~/pages/api/v1/posts/[id]';

function call(query: Record<string, unknown>, user?: { id: number; isModerator?: boolean }) {
  const req = { method: 'GET', query, headers: {}, user } as unknown as NextApiRequest;
  let statusCode = 200;
  let body: any;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    getHeader: (k: string) => headers[k],
    end: () => res,
    headersSent: false,
  } as unknown as NextApiResponse;
  return Promise.resolve((handler as any)(req, res)).then(() => ({ statusCode, body, headers }));
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

    await call({ id: '55288' }, { id: 3, isModerator: true });

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

  it('400s an id that is not a positive int4', async () => {
    for (const id of ['abc', '0', '-1', '2147483648']) {
      expect((await call({ id })).statusCode).toBe(400);
    }
    expect(mockGetPostDetail).not.toHaveBeenCalled();
  });

  it('429s a rate-limited caller before looking anything up', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 7 });

    const { statusCode, headers } = await call({ id: '55288' });

    expect(statusCode).toBe(429);
    expect(headers['Retry-After']).toBe('7');
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ family: 'posts' }));
    expect(mockGetPostDetail).not.toHaveBeenCalled();
  });
});

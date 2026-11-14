import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';

const { mockGetArticleById, mockIsRegionRestricted } = vi.hoisted(() => ({
  mockGetArticleById: vi.fn(),
  mockIsRegionRestricted: vi.fn(),
}));

vi.mock('~/server/services/article.service', () => ({ getArticleById: mockGetArticleById }));
vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: async () => ({ allowed: true }),
}));
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
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

import '~/__tests__/mocks/db.mock';
import { TRPCError } from '@trpc/server';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import handler from '~/pages/api/v1/articles/[id]';

const { PG, PG13, R, X } = NsfwLevel;

function article(nsfwLevel: number, imageLevels: number[] = []) {
  return {
    id: 7,
    nsfwLevel,
    content: '<p>body</p>',
    contentImages: imageLevels.map((level, i) => ({
      id: i + 1,
      url: `img-${i + 1}`,
      ingestion: 'Scanned',
      nsfwLevel: level,
    })),
  };
}

/** The same URL from both sides of the region line, through the REAL `MixedAuthEndpoint`. */
async function bothRegions() {
  const answers = [];
  for (const restricted of [false, true]) {
    mockIsRegionRestricted.mockReturnValue(restricted);
    const { req, res, header } = createRealApiPair({
      url: '/api/v1/articles/7',
      query: { id: '7' },
    });
    let body: Record<string, unknown> | undefined;
    const json = res.json.bind(res);
    res.json = ((b: unknown) => {
      body = b as Record<string, unknown>;
      return json(b);
    }) as typeof res.json;
    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
    answers.push({ statusCode: res.statusCode, body, cacheControl: header('Cache-Control') });
  }
  const [elsewhere, restricted] = answers;
  return { elsewhere, restricted };
}

describe('GET /api/v1/articles/[id] by region', () => {
  beforeEach(() => {
    mockGetArticleById.mockReset();
    mockIsRegionRestricted.mockReset();
  });

  it.each([
    ['an R article', article(R)],
    ['an X article', article(X)],
    ['a PG article with an R image in its body', article(PG, [PG, R])],
    ['a PG|R article', article(PG | R)],
    ['a PG article with a PG|R image in its body', article(PG, [PG | R])],
    ['an unrated article', article(0)],
    ['a PG article with an unrated image in its body', article(PG, [0])],
  ])('404s %s in a restricted region and serves it elsewhere', async (_, value) => {
    mockGetArticleById.mockResolvedValue(value);

    const { elsewhere, restricted } = await bothRegions();

    expect(elsewhere.statusCode).toBe(200);
    expect(elsewhere.body?.content).toBe('<p>body</p>');
    expect(restricted.statusCode).toBe(404);
    expect(restricted.body).not.toHaveProperty('content');
    for (const { cacheControl } of [elsewhere, restricted])
      expect(cacheControl).not.toMatch(/public|s-maxage/);
  });

  it('serves an SFW article, with SFW images, in both regions', async () => {
    mockGetArticleById.mockResolvedValue(article(PG | PG13, [PG, PG13]));

    const { elsewhere, restricted } = await bothRegions();

    expect(elsewhere.statusCode).toBe(200);
    expect(restricted.statusCode).toBe(200);
    expect(restricted.body?.content).toBe('<p>body</p>');
  });

  it('gives a restricted caller the same 404 as a missing article', async () => {
    mockGetArticleById.mockResolvedValue(article(R));
    const { restricted: aboveSfw } = await bothRegions();

    mockGetArticleById.mockRejectedValue(
      new TRPCError({ code: 'NOT_FOUND', message: 'No article with id 7' })
    );
    const { restricted: missing } = await bothRegions();

    expect(aboveSfw.statusCode).toBe(missing.statusCode);
    expect(aboveSfw.body).toEqual(missing.body);
  });
});

describe('GET /api/v1/articles/[id] author avatar', () => {
  beforeEach(() => {
    mockGetArticleById.mockReset();
    mockIsRegionRestricted.mockReset();
  });

  function withAuthor(profilePicture: { url: string; nsfwLevel: number } | null) {
    mockGetArticleById.mockResolvedValue({
      ...article(PG),
      user: { id: 3, username: 'author', image: 'unrated.png', profilePicture },
    });
  }
  const author = (answer: { body?: Record<string, unknown> }) =>
    answer.body?.user as { image: unknown; profilePicture: unknown };

  it('never serves the unrated image', async () => {
    withAuthor(null);
    const { elsewhere, restricted } = await bothRegions();
    expect(author(elsewhere).image).toBeNull();
    expect(author(restricted).image).toBeNull();
  });

  it('drops a profile picture above the served level', async () => {
    withAuthor({ url: 'avatar.png', nsfwLevel: R });
    const { elsewhere, restricted } = await bothRegions();
    expect(author(elsewhere).profilePicture).toBeNull();
    expect(author(restricted).profilePicture).toBeNull();
  });

  it('serves a PG13 profile picture only where the level is PG|PG13', async () => {
    withAuthor({ url: 'avatar.png', nsfwLevel: PG13 });
    const { elsewhere, restricted } = await bothRegions();
    expect(author(elsewhere).profilePicture).toBeNull();
    expect(author(restricted).profilePicture).toMatchObject({ url: 'avatar.png' });
  });

  it('serves a PG profile picture everywhere (control)', async () => {
    withAuthor({ url: 'avatar.png', nsfwLevel: PG });
    const { elsewhere, restricted } = await bothRegions();
    expect(author(elsewhere).profilePicture).toMatchObject({ url: 'avatar.png' });
    expect(author(restricted).profilePicture).toMatchObject({ url: 'avatar.png' });
  });
});

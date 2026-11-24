import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type { ArticleBodyImageState } from '~/server/utils/article-body-media';

const { mockGetArticleById, mockSession, mockCanViewNsfw, mockRestricted } = vi.hoisted(() => ({
  mockGetArticleById: vi.fn(),
  mockSession: vi.fn(),
  mockCanViewNsfw: vi.fn(),
  mockRestricted: vi.fn(),
}));

vi.mock('~/server/services/article.service', () => ({ getArticleById: mockGetArticleById }));
// A restricted region 404s an article with any above-SFW image (id-region.test.ts); this file
// pins the body cap behind it.
vi.mock('~/server/utils/article-region', () => ({ isArticleServableWhenRestricted: () => true }));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsLazy: () => ({ canViewNsfw: mockCanViewNsfw() }),
}));
vi.mock('~/server/utils/public-api-rate-limit', () => ({
  checkPublicApiRateLimit: async () => ({ allowed: true }),
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({ countryCode: 'XX' }),
  isRegionRestricted: mockRestricted,
}));
vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (h: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      h(...args),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: mockSession,
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

import '~/__tests__/mocks/db.mock';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';
import { articleContentJson } from '~/server/utils/article-content-json';
import handler from '~/pages/api/v1/articles/[id]';

const { PG, PG13, R } = NsfwLevel;
const AUTHOR = 5;
const PG_UUID = '11111111-1111-4111-8111-111111111111';
const R_UUID = '22222222-2222-4222-8222-222222222222';
const VIDEO_UUID = '33333333-3333-4333-8333-333333333333';

const imageUrl = (uuid: string) =>
  `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${uuid}/width=450/x.jpeg`;

function state(
  url: string,
  nsfwLevel: number,
  extra: Partial<ArticleBodyImageState> = {}
): ArticleBodyImageState {
  return {
    url,
    nsfwLevel,
    ingestion: 'Scanned',
    needsReview: null,
    tosViolation: false,
    modelRestricted: false,
    ...extra,
  };
}

/**
 * A PG article whose body holds two images, a video and an off-site image, rated by `images`,
 * as the service returns it: `contentJson` built from the whole body.
 */
function serve(images: ArticleBodyImageState[]) {
  const content =
    `<p>intro</p><img src="${imageUrl(PG_UUID)}" alt="a"><p>middle</p>` +
    `<img src="${imageUrl(R_UUID)}" alt="b"><edge-media url="${VIDEO_UUID}" type="video">` +
    `</edge-media><img src="https://example.com/${R_UUID}.png">`;
  mockGetArticleById.mockResolvedValue({
    id: 7,
    userId: AUTHOR,
    nsfwLevel: PG,
    content,
    contentJson: articleContentJson(content),
    contentImages: images.map((image, i) => ({ id: i + 1, ...image })),
  });
}

const keyHolder = (browsingLevel: number, id = 9) => ({
  user: { id, showNsfw: true, browsingLevel },
});

async function call(session: unknown) {
  mockSession.mockResolvedValue(session);
  const { req, res, header } = createRealApiPair({
    url: '/api/v1/articles/7',
    query: { id: '7' },
    headers: session ? { authorization: 'Bearer key' } : {},
  });
  let body: Record<string, unknown> | undefined;
  const json = res.json.bind(res);
  res.json = ((b: unknown) => {
    body = b as Record<string, unknown>;
    return json(b);
  }) as typeof res.json;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  expect(res.statusCode).toBe(200);
  return { body: JSON.stringify(body), parsed: body, cacheControl: header('Cache-Control') };
}

describe('GET /api/v1/articles/[id] body media', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanViewNsfw.mockReturnValue(true);
    mockRestricted.mockReturnValue(false);
  });

  it('🔴 an anonymous caller gets no uuid of an R body image, and keeps the PG one', async () => {
    serve([state(PG_UUID, PG), state(R_UUID, R), state(VIDEO_UUID, R)]);

    const { body, parsed } = await call(null);

    expect(body).not.toContain(R_UUID);
    expect(body).not.toContain(VIDEO_UUID);
    expect(body).toContain(PG_UUID);
    expect(parsed?.content).toContain('<p>middle</p>');
    expect(body).not.toContain('example.com');
    expect(JSON.stringify(parsed?.contentJson)).toContain(PG_UUID);
    expect(parsed?.contentImages).toEqual([{ id: 1, url: PG_UUID, ingestion: 'Scanned' }]);
  });

  it('a key holder browsing at R gets the R image and video', async () => {
    serve([state(PG_UUID, PG), state(R_UUID, R), state(VIDEO_UUID, R)]);

    const { body, cacheControl } = await call(keyHolder(PG | R));

    expect(body).toContain(R_UUID);
    expect(body).toContain(VIDEO_UUID);
    expect(body).toContain(PG_UUID);
    expect(cacheControl).toBe('private, no-store');
  });

  it('🔴 a key holder on the SFW domain stays capped below R', async () => {
    mockCanViewNsfw.mockReturnValue(false);
    serve([state(PG_UUID, PG), state(R_UUID, R), state(VIDEO_UUID, R)]);

    const { body } = await call(keyHolder(PG | R));

    expect(body).not.toContain(R_UUID);
    expect(body).toContain(PG_UUID);
  });

  it.each([
    ['held for csam review', { needsReview: 'csam' }],
    ['blocked', { ingestion: 'Blocked' }],
    ['pending a scan', { ingestion: 'Pending' }],
    ['a violation', { tosViolation: true }],
    ['mature on a restricted base model', { nsfwLevel: R, modelRestricted: true }],
  ] as const)(
    '🔴 an image %s is stripped for every caller, its author included',
    async (_, extra) => {
      serve([state(PG_UUID, PG), state(R_UUID, PG, extra)]);

      for (const session of [null, keyHolder(PG | R), keyHolder(PG | R, AUTHOR)]) {
        const { body } = await call(session);
        expect(body).not.toContain(R_UUID);
        expect(body).toContain(PG_UUID);
      }
    }
  );

  it('🔴 an unrated image, or one with no linked row, is stripped', async () => {
    serve([state(PG_UUID, PG), state(R_UUID, 0)]);

    const { body } = await call(keyHolder(PG | R));

    expect(body).not.toContain(R_UUID);
    expect(body).not.toContain(VIDEO_UUID);
    expect(body).toContain(PG_UUID);
  });

  it('🔴 in a restricted region a key holder is held to SFW', async () => {
    mockRestricted.mockReturnValue(true);
    serve([state(PG_UUID, PG), state(R_UUID, R), state(VIDEO_UUID, PG13)]);

    const { body } = await call(keyHolder(PG | PG13 | R));

    expect(body).not.toContain(R_UUID);
    expect(body).toContain(VIDEO_UUID);
    expect(body).toContain(PG_UUID);
  });

  it('answers private, no-store to an anonymous caller too', async () => {
    serve([state(PG_UUID, PG)]);

    const { cacheControl } = await call(null);

    expect(cacheControl).toBe('private, no-store');
  });
});

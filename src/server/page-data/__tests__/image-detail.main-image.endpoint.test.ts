import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { sessionCookieName } from '@civitai/auth';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import {
  CDN_HEADER_IMAGE_ID,
  fakeResponse,
  procedureCalls,
  USERS,
  type Fixture,
} from '~/server/page-data/__tests__/image-detail.fixtures';
import { SHELL_MAIN_IMAGE_HEADER } from '~/components/Shell/shell-page-data';
import { imageDetailMainImageUrl } from '~/components/Image/DetailV2/image-detail-main-media';
import { env } from '~/env/client';

/**
 * `GET /api/page-data/images/[imageId]/main-image` names, in a response header, the URL of the
 * main `<img>` the page renders for THIS viewer, for the shell's head script to preload while the
 * page data is still being computed. Contracts:
 *
 *  1. URL — the exact URL the page's `<img>` requests for this viewer, and NONE where the page
 *     requests none or the viewer may not see the image (gated, POI, blocked, unknown, video,
 *     blur-dependent) or the page shows another row (feed filters, storyline).
 *     Expected URLs are written out, not computed: the chain that builds them (`EdgeMedia` →
 *     `EdgeImage` → `useEdgeUrl`) is what is under test. That the rendered `<img>` requests the
 *     same URL is pinned by `ImageDetailCarousel.mainImageUrl.browser.test.tsx`.
 *  2. HEADERS — `private, no-store` on every answer, errors included, and no shared-cache header.
 *  3. FLAG — `shell-images` off ⇒ 404, with no header and no image read.
 *  4. COST — it reads the main image row (and, signed in, the contest rating) and nothing else of
 *     the page data.
 *
 * Same seams as `image-detail.endpoint.test.ts`: the session layer, the flag evaluator and the
 * router (the fixture router, built from the real `publicProcedure`).
 */

const h = vi.hoisted(() => ({
  tokens: new Map<string, Record<string, unknown>>(),
  flagOn: { current: true },
  flagsFail: { current: false },
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: vi.fn(async (req: { cookies?: Record<string, string> }) => {
    const user = h.tokens.get(Object.values(req.cookies ?? {})[0] ?? '');
    return user ? { user } : null;
  }),
  maybeRollHubCookie: vi.fn(async () => undefined),
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async ({ req }: { req?: { headers: { host?: string } } }) => {
    if (h.flagsFail.current) throw new Error('flags unavailable');
    return {
      canViewNsfw: req?.headers.host === 'civitai.red' ? true : undefined,
      shellImages: h.flagOn.current ? true : undefined,
    };
  }),
  getFliptGatedEligibility: vi.fn(() => ({})),
}));
vi.mock('~/server/routers', async () => {
  const { buildFixtureRouter } = await import('~/server/page-data/__tests__/image-detail.fixtures');
  return { appRouter: await buildFixtureRouter() };
});

const handler = (await import('~/pages/api/page-data/images/[imageId]/main-image')).default;

let previousBaseUrl: string | undefined;
beforeAll(() => {
  previousBaseUrl = process.env.NEXTAUTH_URL_INTERNAL;
  process.env.NEXTAUTH_URL_INTERNAL = 'http://bootstrap.test:3000';
});
afterAll(() => {
  if (previousBaseUrl === undefined) delete process.env.NEXTAUTH_URL_INTERNAL;
  else process.env.NEXTAUTH_URL_INTERNAL = previousBaseUrl;
});
beforeEach(() => {
  procedureCalls.length = 0;
  h.flagOn.current = true;
  h.flagsFail.current = false;
});

async function fetchMainImage(
  { user, imageId, host }: Fixture,
  {
    method = 'GET',
    query = {},
    cookies = {},
  }: { method?: string; query?: Record<string, string>; cookies?: Record<string, string> } = {}
) {
  const token = user ? `viewer-${user.id}` : undefined;
  if (user && token) h.tokens.set(token, user);
  const req = {
    method,
    url: `/api/page-data/images/${imageId}/main-image`,
    headers: { host },
    // The session cookie first: the session stub reads the first cookie value.
    cookies: { ...(token ? { [sessionCookieName()]: token } : {}), ...cookies },
    query: { imageId: String(imageId), ...query },
  };
  const res = fakeResponse();
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return { res };
}

/** The main image URL the response names, decoded as the head script decodes it. */
function mainImageUrlOf(res: ReturnType<typeof fakeResponse>) {
  const value = res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase());
  return value === undefined ? undefined : decodeURIComponent(String(value));
}

const edge = (...segments: string[]) =>
  [env.NEXT_PUBLIC_IMAGE_LOCATION, ...segments].filter(Boolean).join('/');
const URL_106 = edge('media-106', 'original=true', 'Sunset Over Hills.jpeg');
const viewer106: Fixture = { user: USERS.viewer, imageId: 106, host: 'civitai.com' };

const NO_STORE = 'private, no-store';
function expectPrivateNoStore(res: ReturnType<typeof fakeResponse>) {
  expect(res.getHeader('cache-control')).toBe(NO_STORE);
  const headers = res.getHeaders();
  for (const name of Object.keys(headers)) expect(name).not.toMatch(/cdn-cache-control/i);
  expect(JSON.stringify(headers)).not.toMatch(/s-maxage|public/i);
}

describe('main-image URL', () => {
  it('a PG image: a 204 naming the URL of its original, under its own name', async () => {
    const { res } = await fetchMainImage(viewer106);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
    expect(mainImageUrlOf(res)).toBe(URL_106);
    // And it is what the page's own builder gives that image (the fixture's `image.get` answer).
    expect(mainImageUrlOf(res)).toBe(
      imageDetailMainImageUrl({
        id: 106,
        url: 'media-106',
        name: 'Sunset Over Hills.png',
        type: 'image',
      })
    );
  });

  it('the header is header-safe whatever the URL holds', async () => {
    const { res } = await fetchMainImage(viewer106);
    const raw = String(res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase()));
    expect(raw).toMatch(/^[\x21-\x7e]+$/);
    expect(raw).toContain('Sunset%20Over%20Hills.jpeg');
  });

  it('a PG image with no name is named by its id', async () => {
    const { res } = await fetchMainImage({ ...viewer106, imageId: 103 });
    expect(mainImageUrlOf(res)).toBe(edge('media-103', 'original=true', '103.jpeg'));
  });

  it('a PG image for a signed-out viewer (the gate shows PG to everyone)', async () => {
    const { res } = await fetchMainImage({ ...viewer106, user: null });
    expect(mainImageUrlOf(res)).toBe(URL_106);
  });

  it.each([
    ['a video (the page renders a <video>)', { user: USERS.viewer, imageId: 107 }],
    ['an R image on .com (the gate redirects)', { user: USERS.viewer, imageId: 101 }],
    ['an R image on .com, to its owner', { user: USERS.owner, imageId: 101 }],
    ['an R image on .com, signed out', { user: null, imageId: 101 }],
    ['a POI image to a viewer (NotFound)', { user: USERS.viewer, imageId: 102 }],
    ['a PG13 image to a signed-out viewer (login gate)', { user: null, imageId: 109 }],
    ['an image the viewer cannot get (blocked)', { user: USERS.blockedByOwner, imageId: 103 }],
    ['an image that does not exist', { user: USERS.viewer, imageId: 404404 }],
    ['a PG image a contest forces to R, signed in', { user: USERS.viewer, imageId: 108 }],
  ] as const)('a 204 with no URL for %s', async (_, fixture) => {
    const { res } = await fetchMainImage({ ...fixture, host: 'civitai.com' });
    expect(res.statusCode).toBe(204);
    expect(res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase())).toBeUndefined();
  });

  it('none for an R image on .red: the viewer’s blur settings decide, and they are not known', async () => {
    const { res } = await fetchMainImage({ ...viewer106, imageId: 101, host: 'civitai.red' });
    expect(res.statusCode).toBe(204);
    expect(mainImageUrlOf(res)).toBeUndefined();
    // Control: on .red a safe image does get one.
    const safe = await fetchMainImage({ ...viewer106, host: 'civitai.red' });
    expect(mainImageUrlOf(safe.res)).toBe(URL_106);
  });

  it.each([
    ['a POI image, to its owner', { user: USERS.owner, imageId: 102 }, '102.jpeg', 'media-102'],
    [
      'a POI image, to a moderator',
      { user: USERS.moderator, imageId: 102 },
      '102.jpeg',
      'media-102',
    ],
    ['a PG13 image, signed in', { user: USERS.viewer, imageId: 109 }, '109.jpeg', 'media-109'],
    // Signed out, the contest details are not read, as the page does not prefetch them, so its
    // first render gates on the image's own rating, and requests it.
    [
      'a PG image a contest forces to R, signed out',
      { user: null, imageId: 108 },
      '108.jpeg',
      'media-108',
    ],
  ] as const)('a URL for %s', async (_, fixture, name, key) => {
    const { res } = await fetchMainImage({ ...fixture, host: 'civitai.com' });
    expect(res.statusCode).toBe(204);
    expect(mainImageUrlOf(res)).toBe(edge(key, 'original=true', name));
  });
});

/**
 * With feed filters in its query the page shows its image from `image.getInfinite`, whose rows
 * carry no `name` — so their URL is not the one built from `image.get`, and a preload of it would be
 * a second full download. The endpoint names none, by the page's own rule
 * (`hasImageDetailQueryFilters`), nor in storyline mode — and reads nothing to decide that.
 */
describe('main-image URL and the page query', () => {
  it('control: no query, a URL', async () => {
    const { res } = await fetchMainImage(viewer106);
    expect(mainImageUrlOf(res)).toBe(URL_106);
  });

  it.each([
    ['a feed filter (?modelVersionId=1)', { modelVersionId: '1' }],
    ['a post (?postId=5)', { postId: '5' }],
    ['a sort (?sort=Newest)', { sort: 'Newest' }],
    ['storyline mode (?storylineChapter=3)', { storylineChapter: '3' }],
  ])('none for %s, and no image read', async (_, query) => {
    const { res } = await fetchMainImage(viewer106, { query });
    expect(res.statusCode).toBe(204);
    expect(mainImageUrlOf(res)).toBeUndefined();
    expect(procedureCalls).toEqual([]);
  });

  it.each([
    // The page's parse drops a query it cannot read whole, so the page shows `image.get`'s image.
    ['a junk postId (?postId=null)', { postId: 'null' }],
    ['a param the feed does not read (?active=true)', { active: 'true' }],
  ])('a URL for %s, as the page shows the image.get row', async (_, query) => {
    const { res } = await fetchMainImage(viewer106, { query });
    expect(mainImageUrlOf(res)).toBe(URL_106);
  });
});

describe('main-image cost: only the main image’s own reads', () => {
  it('signed in: image.get and the contest rating, nothing else of the page data', async () => {
    await fetchMainImage(viewer106);
    expect([...procedureCalls].sort()).toEqual(
      ['image.get', 'image.getContestCollectionDetails'].sort()
    );
  });

  it('signed out: image.get only', async () => {
    await fetchMainImage({ ...viewer106, user: null });
    expect(procedureCalls).toEqual(['image.get']);
  });
});

describe('main-image cache headers', () => {
  it('a 204 with a URL is private, no-store', async () => {
    const { res } = await fetchMainImage(viewer106);
    expect(mainImageUrlOf(res)).toBe(URL_106);
    expectPrivateNoStore(res);
  });

  it('a 204 without a URL is private, no-store', async () => {
    const { res } = await fetchMainImage({ ...viewer106, imageId: 101 });
    expect(res.statusCode).toBe(204);
    expectPrivateNoStore(res);
  });

  it('a shared-cache header a procedure wrote does not survive', async () => {
    const { res } = await fetchMainImage({ ...viewer106, imageId: CDN_HEADER_IMAGE_ID });
    expect(res.statusCode).toBe(204);
    // Positive control: the procedure did run and write it onto this response.
    expect(procedureCalls).toContain('image.get');
    expect(res.headerWrites).toContainEqual(['cache-control', 'public, s-maxage=300']);
    expectPrivateNoStore(res);
  });

  type ErrorCase = {
    arrange: () => void;
    imageId?: number;
    method?: string;
    status: number;
  };
  const errorCases: [string, ErrorCase][] = [
    [
      'the flag-off 404',
      {
        arrange: () => {
          h.flagOn.current = false;
        },
        status: 404,
      },
    ],
    [
      'a non-numeric id 404',
      { arrange: () => undefined, imageId: 'abc' as unknown as number, status: 404 },
    ],
    ['a 405', { arrange: () => undefined, method: 'POST', status: 405 }],
    [
      'a failure 500',
      {
        arrange: () => {
          h.flagsFail.current = true;
        },
        status: 500,
      },
    ],
  ];
  it.each(errorCases)('%s is private, no-store, with no URL', async (_, c) => {
    c.arrange();
    const { res } = await fetchMainImage(
      { ...viewer106, imageId: c.imageId ?? viewer106.imageId },
      { method: c.method ?? 'GET' }
    );
    const status = c.status;
    expect(res.statusCode).toBe(status);
    expect(res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase())).toBeUndefined();
    expectPrivateNoStore(res);
  });
});

describe('main-image behind shell-images', () => {
  it('is a 404 with no URL and no image read when the flag is off', async () => {
    h.flagOn.current = false;
    const { res } = await fetchMainImage({ ...viewer106, user: USERS.moderator });
    expect(res.statusCode).toBe(404);
    expect(res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase())).toBeUndefined();
    expect(procedureCalls).toEqual([]);
  });

  it('control: the same request names the URL with the flag on', async () => {
    const { res } = await fetchMainImage({ ...viewer106, user: USERS.moderator });
    expect(res.statusCode).toBe(204);
    expect(mainImageUrlOf(res)).toBe(URL_106);
  });

  // The page data refreshes the route cookie on a 200 and clears it on the flag-off 404, for a
  // request carrying it (`image-detail.endpoint.test.ts`); this request leaves it alone.
  it('leaves the route cookie to the page data: it sets none, on or off', async () => {
    const cookies = { 'civ-shell-images': '1' };
    const on = await fetchMainImage(viewer106, { cookies });
    h.flagOn.current = false;
    const off = await fetchMainImage(viewer106, { cookies });
    expect(on.res.statusCode).toBe(204);
    expect(off.res.statusCode).toBe(404);
    expect(on.res.getHeader('set-cookie')).toBeUndefined();
    expect(off.res.getHeader('set-cookie')).toBeUndefined();
  });
});

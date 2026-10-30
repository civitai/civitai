import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetServerSidePropsContext, NextApiRequest, NextApiResponse } from 'next';
import { sessionCookieName } from '@civitai/auth';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as SettingsBootstrapService from '~/server/services/settings-bootstrap.service';
import {
  CDN_HEADER_IMAGE_ID,
  fakeResponse,
  FIXTURES,
  jsonRoundTrip,
  procedureCalls,
  renderSeedFor,
  USERS,
  type Fixture,
} from '~/server/page-data/__tests__/image-detail.fixtures';
import {
  adoptShellPageData,
  SHELL_MAIN_IMAGE_HEADER,
  SHELL_PAGE_DATA_REQUIRED_KEYS,
} from '~/components/Shell/shell-page-data';
import { imageDetailMainImageUrl } from '~/components/Image/DetailV2/image-detail-main-media';
import { env } from '~/env/client';

/**
 * `GET /api/page-data/images/[imageId]` is what a static shell of `/images/[imageId]` will fetch
 * instead of having the page server-rendered for the viewer. Three contracts:
 *
 *  1. PARITY — for the same viewer it hands back the `trpcState` the page's own
 *     `getServerSideProps` would have put in `__NEXT_DATA__`. Both sides here run for real (the
 *     page's gSSP through the real `createServerSideProps`, the endpoint through its real handler)
 *     against one fake router; the seams mocked are the session layer, the flag evaluator and the
 *     settings bootstrap, the same ones the server tests around them mock.
 *  2. HEADERS — the body is the viewer's, so it is `private, no-store` on every answer, errors
 *     included, and no shared-cache header ever survives on it.
 *  3. FLAG — `shell-images` off ⇒ 404, before any page data is read.
 */

const h = vi.hoisted(() => ({
  /** Session cookie value → the user the session store answers with. */
  tokens: new Map<string, Record<string, unknown>>(),
  bootstrapFails: { current: false },
  flagOn: { current: true },
  seeds: vi.fn(),
  log: vi.fn(async (_entry: Record<string, unknown>) => undefined),
}));

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logToAxiom: h.log,
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/session-client', () => ({
  // The session store answers for the fixture viewer with a REAL Date in the user, as a warm
  // session-cache hit does.
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
  getFeatureFlagsAsync: vi.fn(async ({ req }: { req?: { headers: { host?: string } } }) => ({
    canViewNsfw: req?.headers.host === 'civitai.red' ? true : undefined,
    shellImages: h.flagOn.current ? true : undefined,
  })),
  getFliptGatedEligibility: vi.fn(() => ({})),
}));
// The seeds' own members are pinned by their suites (and the request they are read with by
// `image-detail.endpoint.bootstrap.test.ts`); here they answer for the session they are handed.
vi.mock('~/server/services/settings-bootstrap.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SettingsBootstrapService>()),
  resolveSettingsBootstrapSeeds: h.seeds,
}));
vi.mock('~/server/routers', async () => {
  const { buildFixtureRouter } = await import('~/server/page-data/__tests__/image-detail.fixtures');
  return { appRouter: await buildFixtureRouter() };
});

const SETTINGS = {
  features: {},
  chat: { muteSounds: true, acknowledged: true },
};

const page = (await import('~/pages/images/[imageId]')) as unknown as {
  getServerSideProps: (ctx: GetServerSidePropsContext) => Promise<{
    props?: { trpcState?: unknown; adsGated?: boolean; session?: unknown };
  }>;
};
const handler = (await import('~/pages/api/page-data/images/[imageId]')).default;

let previousBaseUrl: string | undefined;
beforeAll(() => {
  // `bootstrapHost` needs a base URL; any will do here.
  previousBaseUrl = process.env.NEXTAUTH_URL_INTERNAL;
  process.env.NEXTAUTH_URL_INTERNAL = 'http://bootstrap.test:3000';
  // `dehydrate` stamps `dataUpdatedAt`; both sides must run at the same instant to compare.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'));
});
afterAll(() => {
  vi.useRealTimers();
  if (previousBaseUrl === undefined) delete process.env.NEXTAUTH_URL_INTERNAL;
  else process.env.NEXTAUTH_URL_INTERNAL = previousBaseUrl;
});
beforeEach(() => {
  procedureCalls.length = 0;
  h.log.mockClear();
  h.flagOn.current = true;
  h.bootstrapFails.current = false;
  h.seeds.mockReset();
  h.seeds.mockImplementation(async (_req: unknown, session: { user?: unknown } | null) => {
    if (h.bootstrapFails.current) throw new Error('bootstrap seeds failed');
    const user = session?.user;
    return {
      settings: user ? SETTINGS : undefined,
      tosMeta: undefined,
      announcements: undefined,
      following: user ? [1, 2] : undefined,
      browsingSettingsAddons: undefined,
      liveNow: false,
      navBanners: undefined,
      siteAlerts: undefined,
      session,
    };
  });
});

function renderPage({ user, imageId, host }: Fixture) {
  const seed = renderSeedFor(user);
  return page.getServerSideProps({
    req: {
      ...(seed ? { session: seed } : {}),
      url: `/images/${imageId}`,
      headers: { host },
      cookies: {},
    },
    res: fakeResponse(),
    params: { imageId: String(imageId) },
    query: { imageId: String(imageId) },
    resolvedUrl: `/images/${imageId}`,
  } as unknown as GetServerSidePropsContext);
}

/** The handler, started and not awaited: `done` settles when it returns. */
function startPageData(
  { user, imageId, host }: Fixture,
  {
    method = 'GET',
    cookies = {},
    query = {},
  }: { method?: string; cookies?: Record<string, string>; query?: Record<string, string> } = {}
) {
  const token = user ? `viewer-${user.id}` : undefined;
  if (user && token) h.tokens.set(token, user);
  const req = {
    method,
    url: `/api/page-data/images/${imageId}`,
    headers: { host },
    // The session cookie first: the session stub reads the first cookie value.
    cookies: { ...(token ? { [sessionCookieName()]: token } : {}), ...cookies },
    query: { imageId: String(imageId), ...query },
  };
  const res = fakeResponse();
  const done = handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return { req, res, done };
}

async function fetchPageData(...args: Parameters<typeof startPageData>) {
  const { req, res, done } = startPageData(...args);
  await done;
  return { req, res, body: res.body as Record<string, unknown> | undefined };
}

const ownerFixture: Fixture = { user: USERS.owner, imageId: 101, host: 'civitai.com' };

describe('page-data parity with getServerSideProps', () => {
  it.each(FIXTURES)('%s: the endpoint hands back the page’s trpcState', async (_, fixture) => {
    const ssr = await renderPage(fixture);
    const api = await fetchPageData(fixture);

    expect(api.res.statusCode).toBe(200);
    expect(ssr.props?.trpcState).toBeDefined();
    // Both reach the browser as JSON: `__NEXT_DATA__` for one, the response body for the other.
    expect(jsonRoundTrip(api.body?.trpcState)).toEqual(jsonRoundTrip(ssr.props?.trpcState));
    expect(api.body?.adsGated).toBe(ssr.props?.adsGated);
    expect(api.body?.session).toEqual(jsonRoundTrip(ssr.props?.session));
  });

  it('control: the comparison can tell two viewers apart', async () => {
    const owner = await fetchPageData(ownerFixture);
    const someoneElse = await fetchPageData({ ...ownerFixture, user: USERS.viewer });
    expect(jsonRoundTrip(owner.body?.trpcState)).not.toEqual(
      jsonRoundTrip(someoneElse.body?.trpcState)
    );
  });

  it('answers with the seeds a server render would have put in pageProps', async () => {
    const { body } = await fetchPageData(ownerFixture);
    expect(Object.keys(body ?? {}).sort()).toEqual(
      [
        'adsGated',
        'announcements',
        'browsingSettingsAddons',
        'chatSettings',
        'flags',
        'following',
        'liveNow',
        'navBanners',
        'region',
        'session',
        'settings',
        'siteAlerts',
        'tosMeta',
        'trpcState',
        'userFeatureFlags',
      ].sort()
    );
    expect(body?.settings).toEqual(SETTINGS);
    expect(body?.following).toEqual([1, 2]);
    expect(body?.chatSettings).toEqual(SETTINGS.chat);
    expect(body?.flags).toEqual({ shellImages: true });
    expect(body?.userFeatureFlags).toBeDefined();
  });

  // The client adopts a 200 only when these are all present (`shell-page-data.ts`).
  it.each([
    ['a signed-in viewer', ownerFixture],
    ['a signed-out viewer', { ...ownerFixture, user: null }],
  ])('carries every key the shell client requires, for %s', async (_, fixture) => {
    const { res, body } = await fetchPageData(fixture);
    expect(res.statusCode).toBe(200);
    const wire = jsonRoundTrip(body) as Record<string, unknown>;
    expect(SHELL_PAGE_DATA_REQUIRED_KEYS.filter((key) => !(key in wire))).toEqual([]);
  });

  it('seeds no per-user chat settings or overlay for a signed-out viewer', async () => {
    const { body } = await fetchPageData({ ...ownerFixture, user: null });
    expect(body?.session).toBeNull();
    expect(body?.chatSettings).toBeUndefined();
    expect(body?.userFeatureFlags).toBeUndefined();
  });
});

const NO_STORE = 'private, no-store';

function expectPrivateNoStore(res: ReturnType<typeof fakeResponse>) {
  expect(res.getHeader('cache-control')).toBe(NO_STORE);
  const headers = res.getHeaders();
  for (const name of Object.keys(headers)) expect(name).not.toMatch(/cdn-cache-control/i);
  expect(JSON.stringify(headers)).not.toMatch(/s-maxage|public/i);
}

describe('page-data cache headers', () => {
  it('a 200 is private, no-store', async () => {
    const { res } = await fetchPageData(ownerFixture);
    expect(res.statusCode).toBe(200);
    expectPrivateNoStore(res);
  });

  it('a shared-cache header a procedure wrote does not survive', async () => {
    const { res } = await fetchPageData({ ...ownerFixture, imageId: CDN_HEADER_IMAGE_ID });
    expect(res.statusCode).toBe(200);
    // Positive control: the procedure did run and write it onto this response.
    expect(procedureCalls).toContain('image.get');
    expect(res.headerWrites).toContainEqual(['cache-control', 'public, s-maxage=300']);
    expectPrivateNoStore(res);
  });

  it('the flag-off 404 is private, no-store', async () => {
    h.flagOn.current = false;
    const { res } = await fetchPageData(ownerFixture);
    expect(res.statusCode).toBe(404);
    expectPrivateNoStore(res);
  });

  it('a non-numeric id 404 is private, no-store', async () => {
    const { res } = await fetchPageData({ ...ownerFixture, imageId: 'abc' as unknown as number });
    expect(res.statusCode).toBe(404);
    expectPrivateNoStore(res);
  });

  it('a 405 is private, no-store', async () => {
    const { res } = await fetchPageData(ownerFixture, { method: 'POST' });
    expect(res.statusCode).toBe(405);
    expectPrivateNoStore(res);
  });

  it('a failed bootstrap is a private, no-store 500', async () => {
    h.bootstrapFails.current = true;
    const { res, body } = await fetchPageData(ownerFixture);
    expect(res.statusCode).toBe(500);
    expect(body).not.toHaveProperty('session');
    expectPrivateNoStore(res);
  });
});

describe('page-data behind shell-images', () => {
  it('is a 404 with no page data when the flag is off', async () => {
    h.flagOn.current = false;
    const { res, body } = await fetchPageData({ ...ownerFixture, user: USERS.moderator });
    expect(res.statusCode).toBe(404);
    expect(body).not.toHaveProperty('trpcState');
    expect(body).not.toHaveProperty('session');
    expect(procedureCalls).toEqual([]);
  });

  it('control: the same request is a 200 with the flag on', async () => {
    const { res } = await fetchPageData({ ...ownerFixture, user: USERS.moderator });
    expect(res.statusCode).toBe(200);
    expect(procedureCalls.length).toBeGreaterThan(0);
  });
});

describe('page-data keeps the shell route cookie in step with shell-images', () => {
  const routeCookies = (res: ReturnType<typeof fakeResponse>) =>
    ([] as unknown[])
      .concat(res.getHeader('set-cookie') ?? [])
      .map(String)
      .filter((c) => c.startsWith('civ-shell-images='));
  const SET = 'civ-shell-images=1; Path=/; Max-Age=604800; Secure; SameSite=Lax';
  const CLEAR = 'civ-shell-images=; Path=/; Max-Age=0; Secure; SameSite=Lax';

  it('a 200 for a signed-in viewer refreshes it, so it does not lapse while the flag is on', async () => {
    const { res } = await fetchPageData(ownerFixture, { cookies: { 'civ-shell-images': '1' } });
    expect(res.statusCode).toBe(200);
    expect(routeCookies(res)).toEqual([SET]);
  });

  it('the flag off: a 404 that clears it, so the viewer stops getting the shell', async () => {
    h.flagOn.current = false;
    const { res } = await fetchPageData(ownerFixture, { cookies: { 'civ-shell-images': '1' } });
    expect(res.statusCode).toBe(404);
    expect(routeCookies(res)).toEqual([CLEAR]);
  });

  it('the flag off and no cookie: nothing to clear', async () => {
    h.flagOn.current = false;
    const { res } = await fetchPageData(ownerFixture);
    expect(routeCookies(res)).toEqual([]);
  });

  it('a signed-out viewer: a stale cookie is cleared', async () => {
    const { res } = await fetchPageData(
      { ...ownerFixture, user: null },
      { cookies: { 'civ-shell-images': '1' } }
    );
    expect(res.statusCode).toBe(200);
    expect(routeCookies(res)).toEqual([CLEAR]);
  });
});

/**
 * The page data names the URL of the page's main `<img>` for THIS viewer, for the shell's head
 * script to preload — and nothing when the page will not request one on its first render.
 * Expected URLs are written out, not computed: the chain that builds them (`EdgeMedia` →
 * `EdgeImage` → `useEdgeUrl`) is what is under test. That the rendered `<img>` requests the same
 * URL is pinned by `ImageDetailCarousel.mainImageUrl.browser.test.tsx`.
 */
/** The main image URL the response names, decoded as the head script decodes it. */
function mainImageUrlOf(res: ReturnType<typeof fakeResponse>) {
  const value = res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase());
  return value === undefined ? undefined : decodeURIComponent(String(value));
}

describe('page-data main image preload URL', () => {
  it('is a header, header-safe, and not in the body', async () => {
    const { res, body } = await fetchPageData({
      user: USERS.viewer,
      imageId: 106,
      host: 'civitai.com',
    });
    const raw = String(res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase()));
    // The name has spaces; the raw value must still be a legal header value, whatever it holds.
    expect(raw).toMatch(/^[\x21-\x7e]+$/);
    expect(raw).toContain('Sunset%20Over%20Hills.jpeg');
    expect(jsonRoundTrip(body)).not.toHaveProperty('mainImageUrl');
  });

  const edge = (...segments: string[]) =>
    [env.NEXT_PUBLIC_IMAGE_LOCATION, ...segments].filter(Boolean).join('/');
  it('a PG image: the URL of its original, under its own name, as the `<img>` asks for it', async () => {
    const { res } = await fetchPageData({
      user: USERS.viewer,
      imageId: 106,
      host: 'civitai.com',
    });
    expect(res.statusCode).toBe(200);
    expect(mainImageUrlOf(res)).toBe(edge('media-106', 'original=true', 'Sunset Over Hills.jpeg'));
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

  it('a PG image with no name is named by its id', async () => {
    const { res } = await fetchPageData({ user: USERS.viewer, imageId: 103, host: 'civitai.com' });
    expect(mainImageUrlOf(res)).toBe(edge('media-103', 'original=true', '103.jpeg'));
  });

  it('a PG image for a signed-out viewer (the gate shows PG to everyone)', async () => {
    const { res } = await fetchPageData({ user: null, imageId: 106, host: 'civitai.com' });
    expect(mainImageUrlOf(res)).toBe(edge('media-106', 'original=true', 'Sunset Over Hills.jpeg'));
  });

  it('a video: no URL, as the page renders a <video> and no <img>', async () => {
    const { res } = await fetchPageData({
      user: USERS.viewer,
      imageId: 107,
      host: 'civitai.com',
    });
    expect(res.statusCode).toBe(200);
    // The same rating as 106, which has a URL: only the media type differs.
    expect(mainImageUrlOf(res)).toBeUndefined();
    expect(res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase())).toBeUndefined();
  });

  it.each([
    ['an R image on .com (the gate redirects)', { user: USERS.viewer, imageId: 101 }],
    ['an R image on .com, to its owner', { user: USERS.owner, imageId: 101 }],
    ['a POI image to a viewer (NotFound)', { user: USERS.viewer, imageId: 102 }],
    ['a PG13 image to a signed-out viewer (login gate)', { user: null, imageId: 109 }],
    ['an image the viewer cannot get (blocked)', { user: USERS.blockedByOwner, imageId: 103 }],
    ['a PG image a contest forces to R, signed in', { user: USERS.viewer, imageId: 108 }],
  ] as const)('none for %s', async (_, fixture) => {
    const { res } = await fetchPageData({ ...fixture, host: 'civitai.com' });
    expect(res.statusCode).toBe(200);
    expect(mainImageUrlOf(res)).toBeUndefined();
  });

  it('none for an R image on .red: the viewer’s blur settings decide, and they are not known', async () => {
    const { res } = await fetchPageData({ user: USERS.viewer, imageId: 101, host: 'civitai.red' });
    expect(mainImageUrlOf(res)).toBeUndefined();
    // Control: on .red a safe image does get one.
    const safe = await fetchPageData({ user: USERS.viewer, imageId: 106, host: 'civitai.red' });
    expect(mainImageUrlOf(safe.res)).toBe(
      edge('media-106', 'original=true', 'Sunset Over Hills.jpeg')
    );
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
    // Signed out, the contest details are not prefetched, so the page's first render gates on
    // the image's own rating, and requests it.
    [
      'a PG image a contest forces to R, signed out',
      { user: null, imageId: 108 },
      '108.jpeg',
      'media-108',
    ],
  ] as const)('a URL for %s', async (_, fixture, name, key) => {
    const { res } = await fetchPageData({ ...fixture, host: 'civitai.com' });
    expect(mainImageUrlOf(res)).toBe(edge(key, 'original=true', name));
  });
});

/**
 * With feed filters in its query the page shows its image from `image.getInfinite`, whose rows
 * (from the index) carry no `name` — so their URL is not the one built from `image.get`, and a
 * preload of it would be a second full download. The endpoint withholds the URL on the page's own
 * rule (`hasImageDetailQueryFilters`), and in storyline mode.
 */
describe('page-data main image preload URL and the page query', () => {
  const viewer106 = { user: USERS.viewer, imageId: 106, host: 'civitai.com' } as const;
  const URL_106 = [
    env.NEXT_PUBLIC_IMAGE_LOCATION,
    'media-106',
    'original=true',
    'Sunset Over Hills.jpeg',
  ]
    .filter(Boolean)
    .join('/');

  it('control: no query, a URL', async () => {
    const { res } = await fetchPageData(viewer106);
    expect(mainImageUrlOf(res)).toBe(URL_106);
  });

  it.each([
    ['a feed filter (?modelVersionId=1)', { modelVersionId: '1' }],
    ['a post (?postId=5)', { postId: '5' }],
    ['a sort (?sort=Newest)', { sort: 'Newest' }],
    ['storyline mode (?storylineChapter=3)', { storylineChapter: '3' }],
  ])('none for %s', async (_, query) => {
    const { res } = await fetchPageData(viewer106, { query });
    expect(res.statusCode).toBe(200);
    expect(mainImageUrlOf(res)).toBeUndefined();
  });

  it.each([
    // The page's parse drops a query it cannot read whole, so the page shows `image.get`'s image.
    ['a junk postId (?postId=null)', { postId: 'null' }],
    ['a param the feed does not read (?active=true)', { active: 'true' }],
  ])('a URL for %s, as the page shows the image.get row', async (_, query) => {
    const { res } = await fetchPageData(viewer106, { query });
    expect(mainImageUrlOf(res)).toBe(URL_106);
  });
});

/**
 * EARLY HEADERS: the main-image URL is in headers the endpoint FLUSHES as soon as the main image
 * is decided — before the rest of the work (here: the bootstrap seeds, held open) is done — so
 * the shell's head script can start the image while the body is still being computed. These hold
 * the seeds back and look at the response at the moment its headers went out.
 */
describe('page-data flushes its headers before the body', () => {
  const URL_106 = [
    env.NEXT_PUBLIC_IMAGE_LOCATION,
    'media-106',
    'original=true',
    'Sunset Over Hills.jpeg',
  ]
    .filter(Boolean)
    .join('/');

  /** The bootstrap seeds answer only once `release`d (or fail on `fail`). */
  function holdSeeds() {
    let release!: () => void;
    let fail!: (e: Error) => void;
    const gate = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    const answer = h.seeds.getMockImplementation();
    if (!answer) throw new Error('no seeds implementation to hold');
    h.seeds.mockImplementationOnce(async (...args: unknown[]) => {
      await gate;
      return answer(...args);
    });
    return { release, fail };
  }

  const flushedHeader = (res: ReturnType<typeof fakeResponse>, name: string) =>
    res.flushed?.headers[name.toLowerCase()];

  async function untilFlushed(res: ReturnType<typeof fakeResponse>) {
    await vi.waitFor(() => expect(res.events).toContain('flush'));
  }

  it('flushes the main image URL, private no-store and the route cookie while the seeds are still pending', async () => {
    const seeds = holdSeeds();
    const fixture = { user: USERS.viewer, imageId: 106, host: 'civitai.com' } as const;
    const { res, done } = startPageData(fixture, { cookies: { 'civ-shell-images': '1' } });
    await untilFlushed(res);

    // The seeds were asked for and have not answered: the flush did not wait for them.
    expect(h.seeds).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(false);
    expect(res.flushed?.statusCode).toBe(200);
    expect(decodeURIComponent(String(flushedHeader(res, SHELL_MAIN_IMAGE_HEADER)))).toBe(URL_106);
    expect(flushedHeader(res, 'cache-control')).toBe(NO_STORE);
    expect(String(flushedHeader(res, 'content-type'))).toMatch(/^application\/json/);
    expect(([] as unknown[]).concat(flushedHeader(res, 'set-cookie') ?? []).map(String)).toContain(
      'civ-shell-images=1; Path=/; Max-Age=604800; Secure; SameSite=Lax'
    );

    seeds.release();
    await done;
    expect(res.events).toEqual(['flush', 'end']);
    // The body that follows is the whole page data, with the page's own trpcState.
    const ssr = await renderPage(fixture);
    expect(jsonRoundTrip((res.body as Record<string, unknown>)?.trpcState)).toEqual(
      jsonRoundTrip(ssr.props?.trpcState)
    );
    expect(SHELL_PAGE_DATA_REQUIRED_KEYS.filter((key) => !(key in (res.body as object)))).toEqual(
      []
    );
  });

  it('a shared-cache header a procedure wrote before the flush does not go out with it', async () => {
    const seeds = holdSeeds();
    const { res, done } = startPageData({ ...ownerFixture, imageId: CDN_HEADER_IMAGE_ID });
    await untilFlushed(res);
    // Positive control: the procedure ran before the flush and wrote it onto this response.
    expect(res.headerWrites).toContainEqual(['cache-control', 'public, s-maxage=300']);
    expect(flushedHeader(res, 'cache-control')).toBe(NO_STORE);
    seeds.release();
    await done;
  });

  it.each([
    ['a feed filter (?postId=5)', { postId: '5' }],
    ['storyline mode (?storylineChapter=3)', { storylineChapter: '3' }],
  ])('flushes no main image URL for %s', async (_, query) => {
    const seeds = holdSeeds();
    const { res, done } = startPageData(
      { user: USERS.viewer, imageId: 106, host: 'civitai.com' },
      { query }
    );
    await untilFlushed(res);
    expect(res.flushed?.statusCode).toBe(200);
    expect(flushedHeader(res, 'cache-control')).toBe(NO_STORE);
    expect(flushedHeader(res, SHELL_MAIN_IMAGE_HEADER)).toBeUndefined();
    seeds.release();
    await done;
  });

  it('a non-numeric id is a 404 with nothing flushed, no main image header and no seeds read', async () => {
    const { res } = await fetchPageData({ ...ownerFixture, imageId: 'abc' as unknown as number });
    expect(res.statusCode).toBe(404);
    expect(res.events).toEqual(['end']);
    expect(res.flushed).toBeUndefined();
    expect(res.getHeader(SHELL_MAIN_IMAGE_HEADER)).toBeUndefined();
    expect(h.seeds).not.toHaveBeenCalled();
    expectPrivateNoStore(res);
  });

  it('the flag off is a 404 with nothing flushed and nothing read', async () => {
    h.flagOn.current = false;
    const { res } = await fetchPageData({ user: USERS.viewer, imageId: 106, host: 'civitai.com' });
    expect(res.statusCode).toBe(404);
    expect(res.events).toEqual(['end']);
    expect(res.flushed).toBeUndefined();
    expect(res.getHeader(SHELL_MAIN_IMAGE_HEADER)).toBeUndefined();
    expect(procedureCalls).toEqual([]);
  });

  it('a failure after the flush ends the 200 with no body, which the shell client does not adopt', async () => {
    const seeds = holdSeeds();
    const { res, done } = startPageData({ user: USERS.viewer, imageId: 106, host: 'civitai.com' });
    await untilFlushed(res);
    seeds.fail(new Error('bootstrap seeds failed late'));
    await done;

    expect(res.flushed?.statusCode).toBe(200);
    expect(res.events).toEqual(['flush', 'end']);
    expect(res.wire).toBeUndefined();
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'bootstrap seeds failed late' })
    );

    // The client's verdict on exactly that answer: not adopted (so the page falls back to a full
    // render)…
    const adopt = (response: Response) => {
      vi.stubGlobal('window', { __civShell: Promise.resolve(response) });
      return adoptShellPageData();
    };
    try {
      const failed = await adopt(
        new Response(res.wire ?? null, { status: res.flushed?.statusCode })
      );
      expect(failed.ok).toBe(false);
      // …while control: the same client adopts a 200 the endpoint completed.
      const whole = await fetchPageData({ user: USERS.viewer, imageId: 106, host: 'civitai.com' });
      const adopted = await adopt(new Response(whole.res.wire ?? null, { status: 200 }));
      expect(adopted.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a failure before the flush is still a 500 with nothing flushed', async () => {
    h.bootstrapFails.current = true;
    const { res, body } = await fetchPageData({
      user: USERS.viewer,
      imageId: 106,
      host: 'civitai.com',
    });
    expect(res.statusCode).toBe(500);
    expect(res.flushed).toBeUndefined();
    expect(body).toEqual({ error: 'Page data unavailable' });
    expectPrivateNoStore(res);
  });
});

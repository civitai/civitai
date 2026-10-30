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
  SHELL_MAIN_IMAGE_HEADER,
  SHELL_PAGE_DATA_REQUIRED_KEYS,
} from '~/components/Shell/shell-page-data';

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

async function fetchPageData(
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
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
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
 * The URL of the page's main image is the main-image request's (`./[imageId]/main-image`, pinned by
 * `image-detail.main-image.endpoint.test.ts`), which the shell starts in parallel: a header here
 * would arrive with this whole body, too late to start the image early. One source only.
 */
describe('page-data carries no main image URL', () => {
  it.each([
    ['a PG image', { user: USERS.viewer, imageId: 106, host: 'civitai.com' }],
    ['a PG image, signed out', { user: null, imageId: 106, host: 'civitai.com' }],
  ] as const)('%s: no main-image header, and no URL in the body', async (_, fixture) => {
    const { res, body } = await fetchPageData(fixture);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader(SHELL_MAIN_IMAGE_HEADER.toLowerCase())).toBeUndefined();
    expect(JSON.stringify(res.headerWrites)).not.toMatch(/x-civ-main-image/i);
    expect(jsonRoundTrip(body)).not.toHaveProperty('mainImageUrl');
    // Control: the image was read, with its media, for this viewer — so the absences above are
    // the endpoint not naming the URL, not the image being unavailable to it.
    expect(procedureCalls).toContain('image.get');
    expect(JSON.stringify(body?.trpcState)).toContain('media-106');
  });
});

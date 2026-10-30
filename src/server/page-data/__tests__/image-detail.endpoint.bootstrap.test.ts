import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { sessionCookieName } from '@civitai/auth';
import type * as AnnouncementService from '~/server/services/announcement.service';
import type * as ContentService from '~/server/services/content.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as NavBannerService from '~/server/services/nav-banner.service';
import type * as SiteAlertService from '~/server/services/site-alert.service';
import type * as RedisCaches from '~/server/redis/caches';
import type * as ServerDomain from '~/server/utils/server-domain';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserService from '~/server/services/user.service';
import { fakeResponse, USERS } from '~/server/page-data/__tests__/image-detail.fixtures';

/**
 * How `GET /api/page-data/images/[imageId]` builds the request its settings bootstrap reads. Here
 * the bootstrap is NOT mocked — only the session store and the bootstrap's data sources are — so
 * what is pinned is the request the real bootstrap code sees:
 *
 *  - the session comes from the viewer's cookies, never from a `?token=` on the endpoint URL, as a
 *    server render's does;
 *  - the bootstrap's data is read for the same host a server render reads it for (the internal
 *    bootstrap host, see `bootstrapHost`), so the ToS and announcement seeds match the page;
 *  - the session cookie still rolls on the REAL response, for the viewer's own host;
 *  - with the flag off, nothing past the session lookup runs.
 */

const BOOTSTRAP_BASE_URL = 'http://bootstrap.test:3000';
const BOOTSTRAP_HOST = 'bootstrap.test:3000';
const PUBLIC_HOST = 'civitai.com';

const h = vi.hoisted(() => ({
  flagOn: { current: true },
  hostsSeen: [] as (string | undefined)[],
  hubSession: vi.fn(),
  roll: vi.fn(async () => undefined),
  bearer: vi.fn(async () => null as unknown),
  settings: vi.fn(async () => ({ features: {}, chat: undefined })),
  tosMeta: vi.fn(async (_args: unknown) => undefined),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: h.bearer }));
vi.mock('~/server/auth/session-client', () => ({
  getHubSession: h.hubSession,
  maybeRollHubCookie: h.roll,
  maybeUpgradeLegacySession: vi.fn(async () => undefined),
  sessionClient: { getSessionUserById: vi.fn(async () => null) },
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({ shellImages: h.flagOn.current ? true : undefined })),
  getFliptGatedEligibility: vi.fn(() => ({})),
}));
vi.mock('~/server/routers', async () => {
  const { buildFixtureRouter } = await import('~/server/page-data/__tests__/image-detail.fixtures');
  return { appRouter: await buildFixtureRouter() };
});
// Pass-through: records which host each caller derived its domain from.
vi.mock('~/server/utils/server-domain', async (importOriginal) => {
  const actual = await importOriginal<typeof ServerDomain>();
  return {
    ...actual,
    getRequestDomainColor: ((req: { headers?: { host?: string } }) => {
      h.hostsSeen.push(req?.headers?.host);
      return actual.getRequestDomainColor(req as never);
    }) as typeof actual.getRequestDomainColor,
  };
});
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserContentSettings: h.settings,
}));
vi.mock('~/server/services/content.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentService>()),
  getTosMeta: h.tosMeta,
}));
vi.mock('~/server/services/announcement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnouncementService>()),
  getCurrentAnnouncements: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/nav-banner.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NavBannerService>()),
  getNavBanners: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/site-alert.service', async (importOriginal) => ({
  ...(await importOriginal<typeof SiteAlertService>()),
  getActiveSiteAlerts: vi.fn(async () => ({ version: 2, alerts: [] })),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  getUserFollows: vi.fn(async () => []),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: vi.fn(async () => undefined),
  getLiveNow: vi.fn(async () => false),
}));

const handler = (await import('~/pages/api/page-data/images/[imageId]')).default;
const mainImageHandler = (await import('~/pages/api/page-data/images/[imageId]/main-image'))
  .default;
const { resolveSettingsBootstrapForRender, resolveSettingsBootstrapSeeds } = await import(
  '~/server/services/settings-bootstrap.service'
);

const OWNER_TOKEN = 'owner-cookie-token';
const cookies = () => ({ [sessionCookieName()]: OWNER_TOKEN });

async function fetchPageData(query = '') {
  const req = {
    method: 'GET',
    url: `/api/page-data/images/101${query}`,
    headers: { host: PUBLIC_HOST },
    cookies: cookies(),
    query: { imageId: '101', ...Object.fromEntries(new URLSearchParams(query)) },
  };
  const res = fakeResponse();
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return { res, body: res.body as { session?: { user?: { id?: number } } | null } | undefined };
}

let previousBaseUrl: string | undefined;
beforeAll(() => {
  previousBaseUrl = process.env.NEXTAUTH_URL_INTERNAL;
  process.env.NEXTAUTH_URL_INTERNAL = BOOTSTRAP_BASE_URL;
});
afterAll(() => {
  if (previousBaseUrl === undefined) delete process.env.NEXTAUTH_URL_INTERNAL;
  else process.env.NEXTAUTH_URL_INTERNAL = previousBaseUrl;
});
beforeEach(() => {
  vi.clearAllMocks();
  h.flagOn.current = true;
  h.hostsSeen.length = 0;
  h.hubSession.mockImplementation(async (req: { cookies?: Record<string, string> }) =>
    req.cookies?.[sessionCookieName()] === OWNER_TOKEN ? { user: USERS.owner } : null
  );
  // Any bearer credential would resolve to a moderator.
  h.bearer.mockImplementation(async () => ({ user: USERS.moderator }));
});

describe('the page-data endpoint’s settings bootstrap request', () => {
  it('ignores a ?token= on the endpoint URL: the viewer is the cookie’s', async () => {
    const { res, body } = await fetchPageData('?token=someone-elses-key');
    expect(res.statusCode).toBe(200);
    expect(body?.session?.user?.id).toBe(USERS.owner.id);
    expect(h.bearer).not.toHaveBeenCalled();
  });

  it('control: without the query token the same viewer is read', async () => {
    const { body } = await fetchPageData();
    expect(body?.session?.user?.id).toBe(USERS.owner.id);
  });

  it('reads the bootstrap data for the host a server render reads it for', async () => {
    await resolveSettingsBootstrapForRender({
      headers: { host: PUBLIC_HOST },
      cookies: cookies(),
      url: '/images/101',
    } as never);
    const renderHosts = [...h.hostsSeen];
    // Positive control: the render's bootstrap derives its domain from the internal bootstrap host.
    expect(renderHosts).toEqual([BOOTSTRAP_HOST]);
    const renderTos = h.tosMeta.mock.calls.map(([args]) => args);

    h.hostsSeen.length = 0;
    h.tosMeta.mockClear();
    await fetchPageData();
    // The endpoint's bootstrap read uses the same host; the page's own tRPC context keeps the
    // viewer's host, as a server render's does.
    expect(h.hostsSeen).toContain(BOOTSTRAP_HOST);
    expect(h.tosMeta.mock.calls.map(([args]) => args)).toEqual(renderTos);
  });

  it('rolls the session cookie on the real response, for the viewer’s host', async () => {
    const { res } = await fetchPageData();
    expect(h.roll).toHaveBeenCalledTimes(1);
    const [token, , rollRes, host] = h.roll.mock.calls[0] as unknown as [
      string,
      unknown,
      unknown,
      string
    ];
    expect(token).toBe(OWNER_TOKEN);
    expect(rollRes).toBe(res);
    expect(host).toBe(PUBLIC_HOST);
  });

  // The keys come from the real bootstrap, so a seed it gains later fails here until the
  // endpoint sends it too.
  it('answers with every seed the settings bootstrap gives a server render', async () => {
    const seeds = await resolveSettingsBootstrapSeeds(
      { headers: { host: PUBLIC_HOST }, cookies: cookies(), url: '/images/101' } as never,
      { user: USERS.owner } as never
    );
    const { res, body } = await fetchPageData();
    expect(res.statusCode).toBe(200);
    // Control: the bootstrap really produced its seeds, so an empty difference means something.
    expect(Object.keys(seeds)).toEqual(expect.arrayContaining(['session', 'settings', 'tosMeta']));
    expect(Object.keys(seeds).filter((key) => !(key in (body as object)))).toEqual([]);
  });

  it('with the flag off, reads the session and nothing else of the bootstrap', async () => {
    h.flagOn.current = false;
    const { res } = await fetchPageData();
    expect(res.statusCode).toBe(404);
    // Control: the session lookup did run, so the absences below are the gate's doing.
    expect(h.hubSession).toHaveBeenCalled();
    expect(h.settings).not.toHaveBeenCalled();
    expect(h.tosMeta).not.toHaveBeenCalled();
  });
});

/**
 * The main-image request (`./[imageId]/main-image`) runs in parallel with the page data, for the
 * same viewer. It reads the session from the same request the page data does — so a `?token=`
 * never replaces the cookie viewer there either — but must not roll the session cookie: the page
 * data does, and two concurrent rolls would mint two cookies for one viewer. Nor does it read any
 * of the bootstrap's seeds.
 */
describe('the main-image request’s session', () => {
  async function fetchMainImage(query = '') {
    const req = {
      method: 'GET',
      url: `/api/page-data/images/101/main-image${query}`,
      headers: { host: PUBLIC_HOST },
      cookies: cookies(),
      query: { imageId: '101', ...Object.fromEntries(new URLSearchParams(query)) },
    };
    const res = fakeResponse();
    await mainImageHandler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
    return { res };
  }

  it('ignores a ?token= on the URL: the viewer is the cookie’s', async () => {
    const { res } = await fetchMainImage('?token=someone-elses-key');
    expect(res.statusCode).toBe(204);
    expect(h.bearer).not.toHaveBeenCalled();
    // Control: the cookie session was read.
    expect(h.hubSession).toHaveBeenCalled();
  });

  it('hands the session lookup a response it cannot write the cookie on', async () => {
    const { res } = await fetchMainImage();
    expect(res.statusCode).toBe(204);
    // The lookup reached the roll (the token is old enough to roll, see the page-data case
    // above)…
    expect(h.roll).toHaveBeenCalledTimes(1);
    const [token, , rollRes] = h.roll.mock.calls[0] as unknown as [string, unknown, unknown];
    expect(token).toBe(OWNER_TOKEN);
    // …with a response that is not the real one and has no `setHeader`, which is what makes the
    // real `maybeRollHubCookie` return before minting anything.
    expect(rollRes).not.toBe(res);
    expect(typeof (rollRes as { setHeader?: unknown }).setHeader).not.toBe('function');
    expect(res.getHeader('set-cookie')).toBeUndefined();
  });

  it('reads none of the bootstrap’s seeds', async () => {
    const { res } = await fetchMainImage();
    expect(res.statusCode).toBe(204);
    expect(h.hubSession).toHaveBeenCalled();
    expect(h.settings).not.toHaveBeenCalled();
    expect(h.tosMeta).not.toHaveBeenCalled();
  });
});

/**
 * Pins the read deadlines of the settings bootstrap, through both of its callers:
 * `/api/user/settings` and the in-process server-render read
 * (`resolveSettingsBootstrapForRender`) that `_app.getInitialProps` awaits.
 *
 * Every I/O member already had a `.catch` fallback, which answers a REJECTION. None of them
 * answered a dependency that accepts the read and never replies — and `_app` awaits this on
 * every SSR render, so one parked read pinned EVERY page at the render's 8s ceiling and
 * rendered it signed-out, with nothing logged. Measured 2026-08-16: `getUserContentSettings`,
 * `getCurrentAnnouncements` and `getLiveNow` all hung together against one bad dependency.
 *
 * `getServerAuthSession` has no per-member deadline on purpose — failing it open renders a
 * logged-in user anonymous, and `_app`'s `hasAuthCookie` carve-out exists precisely because
 * that is worse than a slow page. Only the whole-bootstrap render ceiling bounds it.
 *
 * Lives outside `src/pages`: Next treats every file under there as a route and `next build`
 * rejects a test file, which only that build catches.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserService from '~/server/services/user.service';
import type * as AnnouncementService from '~/server/services/announcement.service';
import type * as SystemCache from '~/server/services/system-cache';
import type * as ContentService from '~/server/services/content.service';
import type * as AuthSession from '~/server/auth/get-server-auth-session';
import type * as RedisCaches from '~/server/redis/caches';

const h = vi.hoisted(() => ({
  contentSettings: vi.fn(),
  announcements: vi.fn(),
  liveNow: vi.fn(),
  follows: vi.fn(),
  addons: vi.fn(),
  navBanners: vi.fn(),
  session: vi.fn(),
}));

// The real `~/env/server` validates every prod var and throws under test. Only the deadline
// matters here; the Proxy answers anything else the graph reads at import time. Set small so
// `runAllTimersAsync` reaches it, and non-zero so `withTimeoutFallback` does not pass through.
vi.mock('~/env/server', () => ({
  env: new Proxy(
    {
      SETTINGS_READ_DEADLINE_MS: 20,
      LOGGING: [] as string[],
      // endpoint-helpers spreads this at module load.
      TRPC_ORIGINS: [] as string[],
    } as Record<string, unknown>,
    {
      get: (target, prop) => {
        if (prop in target) return target[prop as string];
        if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
          return 'https://test:test@localhost:5432/test';
        if (
          typeof prop === 'string' &&
          /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
        )
          return 1;
        return undefined;
      },
    }
  ),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSession>()),
  getServerAuthSession: h.session,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserContentSettings: h.contentSettings,
}));
vi.mock('~/server/services/announcement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnouncementService>()),
  getCurrentAnnouncements: h.announcements,
}));
// Its only export. Loading the real module pulls the whole event engine into this graph.
vi.mock('~/server/services/nav-banner.service', () => ({ getNavBanners: h.navBanners }));
vi.mock('~/server/services/content.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ContentService>()),
  getTosMeta: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getBrowsingSettingAddons: h.addons,
  getLiveNow: h.liveNow,
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  getUserFollows: h.follows,
}));

import handler from '~/pages/api/user/settings';
import { resolveSettingsBootstrapForRender } from '~/server/services/settings-bootstrap.service';
import { setSessionCookie } from '~/server/auth/civ-cookie';

const invoke = (headers: Record<string, string> = { host: 'civitai.com' }) => {
  const json = vi.fn();
  const res = { status: vi.fn(() => res), json, setHeader: vi.fn(), end: vi.fn() };
  const req = { method: 'GET', headers, query: {}, cookies: {} };
  const done = (handler as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(
    req as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return { done, json };
};

describe('/api/user/settings read deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.session.mockResolvedValue(null);
    h.contentSettings.mockResolvedValue({ showNsfw: true });
    h.announcements.mockResolvedValue([{ id: 1 }]);
    h.liveNow.mockResolvedValue(true);
    h.follows.mockResolvedValue([7]);
    h.addons.mockResolvedValue([{ id: 'a' }]);
    h.navBanners.mockResolvedValue([{ id: 'event:e1' }]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('answers normally when every dependency replies', async () => {
    const { done, json } = invoke();
    await vi.runAllTimersAsync();
    await done;

    const body = json.mock.calls[0][0];
    expect(body.settings).toEqual({ showNsfw: true });
    expect(body.announcements).toEqual([{ id: 1 }]);
    expect(body.liveNow).toBe(true);
    expect(body.navBanners).toEqual([{ id: 'event:e1' }]);
  });

  it('still answers when a dependency never replies, and seeds the SAFE settings default', async () => {
    // A promise that never settles is the whole point — a `.catch` cannot see it. The
    // assertion is that the handler resolves anyway; fake timers make the deadline fire
    // without the test waiting on a real clock, so a revert fails fast rather than hanging.
    h.contentSettings.mockReturnValue(new Promise(() => undefined));
    const { json } = invoke();
    await vi.runAllTimersAsync();

    // Asserted WITHOUT awaiting the handler: with the deadline removed it never settles, so
    // awaiting it would wedge the runner for the full test timeout instead of reporting.
    // A revert fails here in milliseconds with "spy not called".
    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    // MUST be undefined, not `{}`. AppProvider passes this to `useQuery({ initialData })`
    // under a global `staleTime: Infinity`, so any defined value is pinned for the whole
    // SPA session and never refetched — and an empty one resolves showNsfw off the JWT,
    // which lags a user who just turned nsfw OFF. Seeding `{}` here is a content leak.
    expect(body.settings).toBeUndefined();
    // The rest of the payload still lands — one bad dependency must not degrade the whole
    // response, which is what the outer catch would do.
    expect(body.announcements).toEqual([{ id: 1 }]);
    expect('session' in body).toBe(true);
  });

  it('bounds the authed-only members too', async () => {
    // Every other case runs the anonymous path, where `getUserFollows` is never called and
    // its deadline is unreachable — removing it would pass those tests.
    h.session.mockResolvedValue({ user: { id: 42 } });
    h.follows.mockReturnValue(new Promise(() => undefined));
    h.addons.mockReturnValue(new Promise(() => undefined));
    const { json } = invoke();
    await vi.runAllTimersAsync();

    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.following).toBeUndefined();
    expect(body.browsingSettingsAddons).toBeUndefined();
    // The authed session still lands — a bounded member must not cost the session seed.
    expect(body.session).toEqual({ user: { id: 42 } });
  });

  it('degrades each hanging member independently', async () => {
    h.announcements.mockReturnValue(new Promise(() => undefined));
    h.liveNow.mockReturnValue(new Promise(() => undefined));
    const { json } = invoke();
    await vi.runAllTimersAsync();

    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.announcements).toBeUndefined();
    expect(body.liveNow).toBe(false);
    // The member that did reply is unaffected.
    expect(body.settings).toEqual({ showNsfw: true });
  });
});

describe('/api/user/settings nav banners', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.session.mockResolvedValue(null);
    h.contentSettings.mockResolvedValue({ showNsfw: true });
    h.announcements.mockResolvedValue([]);
    h.liveNow.mockResolvedValue(false);
    h.follows.mockResolvedValue([]);
    h.addons.mockResolvedValue([]);
    h.navBanners.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('degrades to undefined when they never resolve, so the client fetches them itself', async () => {
    h.navBanners.mockReturnValue(new Promise(() => undefined));
    const { json } = invoke();
    await vi.runAllTimersAsync();

    expect(json).toHaveBeenCalled();
    const body = json.mock.calls[0][0];
    expect(body.navBanners).toBeUndefined();
    expect(body.settings).toEqual({ showNsfw: true });
  });

  // This route answers a signed-out caller with a PUBLIC shared-cache header, so the signed-out
  // body must be the same for every signed-out caller. Banners are resolved from the session alone;
  // the dismissed cookie is applied on the client. Passing anything from the request here (cookies,
  // headers) is how one viewer's answer would reach another.
  it('resolves them from the session user alone, never the request', async () => {
    h.session.mockResolvedValue({ user: { id: 42, isModerator: true } });
    const { done } = invoke();
    await vi.runAllTimersAsync();
    await done;
    expect(h.navBanners).toHaveBeenCalledTimes(1);
    expect(h.navBanners.mock.calls[0]).toEqual([{ viewer: { id: 42, isModerator: true } }]);
  });

  it('resolves them as signed out when there is no session', async () => {
    const { done } = invoke();
    await vi.runAllTimersAsync();
    await done;
    expect(h.navBanners.mock.calls[0]).toEqual([{ viewer: undefined }]);
  });
});

type RenderRequest = Parameters<typeof resolveSettingsBootstrapForRender>[0];

/** A page request as `_app.getInitialProps` receives it during a server render. */
function pageRequest() {
  return {
    headers: { host: 'civitai.com', cookie: 'a=1', authorization: 'Bearer header-token' },
    cookies: { a: '1' },
    // A page URL can carry an unrelated `?token=`, which the session lookup reads as an API
    // credential when it is handed the URL.
    url: '/models/1?token=page-token',
  };
}

describe('settings bootstrap during a server render', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.session.mockResolvedValue(null);
    h.contentSettings.mockResolvedValue({ showNsfw: true });
    h.announcements.mockResolvedValue([{ id: 1, startsAt: new Date('2026-01-02T03:04:05.000Z') }]);
    h.liveNow.mockResolvedValue(true);
    h.follows.mockResolvedValue([7]);
    h.addons.mockResolvedValue([{ id: 'a' }]);
    h.navBanners.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('answers exactly what the route puts on the wire, for the same request', async () => {
    h.session.mockResolvedValue({ user: { id: 42, username: 'x' } });
    const { done, json } = invoke({ host: 'civitai.com' });
    await vi.runAllTimersAsync();
    await done;
    const wire = JSON.parse(JSON.stringify(json.mock.calls[0][0]));

    const rendered = await resolveSettingsBootstrapForRender({
      headers: { host: 'civitai.com' },
      cookies: {},
      url: '/',
    } as unknown as RenderRequest);

    expect(rendered).toEqual(wire);
    // Spelled out rather than derived, so a change to both sides at once still shows.
    expect(rendered).toEqual({
      settings: { showNsfw: true },
      announcements: [{ id: 1, startsAt: '2026-01-02T03:04:05.000Z' }],
      following: [7],
      browsingSettingsAddons: [{ id: 'a' }],
      liveNow: true,
      navBanners: [],
      session: { user: { id: 42, username: 'x' } },
    });
  });

  it('carries an explicit session: null when signed out', async () => {
    const rendered = (await resolveSettingsBootstrapForRender(
      pageRequest() as unknown as RenderRequest
    )) as Record<string, unknown>;
    // Key PRESENT and null is what `_app` reads as "signed out"; a missing key reads as a
    // failed bootstrap. JSON drops `undefined` but keeps `null`, so this must survive it.
    expect('session' in rendered).toBe(true);
    expect(rendered.session).toBeNull();
    expect('following' in rendered).toBe(false);
  });

  it('resolves the session from the page headers and cookies, never its URL or its response', async () => {
    // Records on `req.context` the way the real lookup does, so the isolation assertion below
    // can see a leak instead of passing because nothing ever wrote.
    h.session.mockImplementation(async ({ req }: { req: { context?: unknown } }) => {
      req.context = { session: null };
      return null;
    });
    const page = pageRequest();
    await resolveSettingsBootstrapForRender(page as unknown as RenderRequest);

    expect(h.session).toHaveBeenCalledTimes(1);
    const { req, res } = h.session.mock.calls[0][0];
    expect(req.url).toBe('/api/user/settings');
    expect(req.headers).toBe(page.headers);
    expect(req.cookies).toBe(page.cookies);
    expect(req).not.toBe(page);
    // The lookup records what it resolved on `req.context`; that must not reach the page.
    expect('context' in page).toBe(false);
    // A response the lookup can write cookies to without throwing, and that is not the
    // page's: over HTTP those writes landed on an internal response that was discarded.
    // Driven through the real cookie writer the session roll/upgrade paths use, so a writer
    // that starts needing another response method fails here.
    const token = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString(
      'base64url'
    )}.sig`;
    expect(() => setSessionCookie(res, token, { host: 'civitai.com' })).not.toThrow();
  });

  it('rejects at the 8s render ceiling when the session lookup never replies', async () => {
    h.session.mockReturnValue(new Promise(() => undefined));
    const outcome = resolveSettingsBootstrapForRender(
      pageRequest() as unknown as RenderRequest
    ).then(
      () => 'resolved',
      (e: Error) => e.message
    );

    await vi.advanceTimersByTimeAsync(7999);
    const early = await Promise.race([outcome, Promise.resolve('pending')]);
    expect(early, 'must not give up before the ceiling').toBe('pending');

    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('settings bootstrap timed out after 8000ms');
  });

  it('rejects when the session lookup fails, where the route answers a body with no session key', async () => {
    // Shaped like a database client error: connection details in the message, a code beside it.
    h.session.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED db.internal.example:5432'), { code: 'P1001' })
    );
    // Only name and code travel — the caller logs this message, and the route used to swallow it.
    await expect(
      resolveSettingsBootstrapForRender(pageRequest() as unknown as RenderRequest)
    ).rejects.toThrow(/^settings bootstrap failed: Error P1001$/);

    const { done, json } = invoke();
    await vi.runAllTimersAsync();
    await done;
    expect(json.mock.calls[0][0]).toEqual({});
  });

  it('keeps the per-read deadlines, so one parked read degrades only its own member', async () => {
    h.contentSettings.mockReturnValue(new Promise(() => undefined));
    const outcome = resolveSettingsBootstrapForRender(pageRequest() as unknown as RenderRequest);
    await vi.runAllTimersAsync();
    const rendered = (await outcome) as Record<string, unknown>;
    expect('settings' in rendered).toBe(false);
    expect(rendered.liveNow).toBe(true);
    expect('session' in rendered).toBe(true);
  });

  it.each([
    ['2500', 'settings bootstrap timed out after 2500ms'],
    // Zero is "unset", as it always was for this variable, not a 0ms deadline.
    ['0', 'settings bootstrap timed out after 8000ms'],
    // A zero or negative override must not make every render the degraded one.
    ['-1', 'settings bootstrap timed out after 1000ms'],
  ])('takes the ceiling from APP_SETTINGS_FETCH_TIMEOUT_MS=%s', async (value, message) => {
    vi.stubEnv('APP_SETTINGS_FETCH_TIMEOUT_MS', value);
    vi.resetModules();
    const fresh = await import('~/server/services/settings-bootstrap.service');
    h.session.mockReturnValue(new Promise(() => undefined));
    const outcome = fresh
      .resolveSettingsBootstrapForRender(pageRequest() as unknown as RenderRequest)
      .then(
        () => 'resolved',
        (e: Error) => e.message
      );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe(message);
  });
});

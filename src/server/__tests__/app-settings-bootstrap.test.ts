/**
 * Pins the auth-cookie discriminator in `_app.getInitialProps`.
 *
 * `'session' in data` is a key-presence check that reads as an ordinary null-guard, so
 * collapsing it into a truthiness check looks harmless. It isn't: a response carrying NO
 * `session` key came from the endpoint's own outer catch and is NOT authoritative, so
 * treating it as "logged out" throws away a valid session. This file makes that collapse
 * fail loudly.
 *
 * Its only observable is `pageProps.hasAuthCookie` (false ⇒ render anonymous). The cookie
 * itself is never deleted on any path — `session: null` cannot distinguish an expired token
 * from a fail-soft session lookup (`get-server-auth-session.ts:92,102` `.catch(() => null)`
 * on both the hub and legacy lookups), so a hub outage would otherwise durably log out
 * valid users. The `deleteCookie` assertions below pin that: reintroducing a delete fails
 * them. A dead cookie now lingers until it expires, which is the deliberate trade.
 *
 * What the discriminator covers: a bootstrap payload with no `session` key, and a bootstrap
 * that rejects (a failed session lookup, or the render deadline). What it still cannot see is
 * a fail-soft lookup — that yields an anonymous render rather than a logout, and closing it
 * properly needs an explicit "session lookup degraded" signal from the bootstrap. Tracked
 * separately.
 *
 * The bootstrap is read IN-PROCESS (`resolveSettingsBootstrapForRender`); it used to be an
 * HTTP request to our own `/api/user/settings`. The first describe block pins that no such
 * request is made.
 *
 * Lives outside `src/pages` deliberately: Next treats every file under there as a route
 * and `next build` rejects a test file, which only that build catches.
 */
import type * as CookiesNext from 'cookies-next';
import type { AppContext } from 'next/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const h = vi.hoisted(() => ({
  deleteCookie: vi.fn(),
  jar: {} as Record<string, string>,
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
  fetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<typeof CookiesNext>()),
  getCookie: vi.fn(() => 'dark'),
  getCookies: vi.fn(() => h.jar),
  deleteCookie: h.deleteCookie,
}));

// The real `getFeatureFlagsAsync` awaits a Flipt module load + client init, which opens a
// network client under a node test env. The flag values are irrelevant to the cookie
// decision, so only this one export is replaced.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));

// Wholesale on purpose: `_app` uses only this export, and loading the real module pulls the
// server env schema, the database and redis into a test about a cookie decision.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
}));

// Module scope on purpose: this graph is ~1200 modules and a `await import()` from a test
// body would charge its whole transform to that one test's timeout.
import AppWithTRPC from '~/pages/_app';

const getInitialProps = (
  AppWithTRPC as unknown as {
    getInitialProps: (c: AppContext) => Promise<{ pageProps: Record<string, unknown> }>;
  }
).getInitialProps;

const AUTH_COOKIE = '__Secure-civ-token';
const SETTINGS_PATH = '/api/user/settings';

function makeCtx(): AppContext {
  const noop = () => null;
  return {
    Component: noop,
    AppTree: noop,
    router: {},
    ctx: {
      req: { headers: { host: 'civitai.com' }, url: '/' },
      pathname: '/',
      query: {},
      AppTree: noop,
    },
  } as unknown as AppContext;
}

/**
 * The same context with NO `req` — what Next's client router passes on a client-side
 * navigation. It builds `{ pathname, query, asPath, locale, locales, defaultLocale,
 * AppTree }` and no request object, which is what makes `getInitialProps` early-return.
 */
function makeClientNavCtx(): AppContext {
  const noop = () => null;
  return {
    Component: noop,
    AppTree: noop,
    router: {},
    // `req: undefined` is spelled out rather than omitted: dropping `ctx` entirely would
    // hand off to next/app's own `App.getInitialProps` and yield `{ pageProps: {} }` for a
    // DIFFERENT reason, which would pass the assertions below while testing nothing.
    ctx: { req: undefined, pathname: '/models', query: {}, asPath: '/models', AppTree: noop },
  } as unknown as AppContext;
}

/** Scripts what the in-process bootstrap resolves with. */
const answer = (body: unknown) => h.bootstrap.mockImplementation(async () => body);
/** Scripts the bootstrap rejecting — what a failed session lookup or the deadline does. */
const fail = (error: unknown) =>
  h.bootstrap.mockImplementation(async () => {
    throw error;
  });

const settingsRequests = () =>
  h.fetch.mock.calls.filter(([input]) => String(input).includes(SETTINGS_PATH));

beforeEach(() => {
  h.deleteCookie.mockClear();
  h.bootstrap.mockReset();
  h.fetch.mockReset();
  h.jar = { [AUTH_COOKIE]: 'token-value' };
  answer({ session: null });
  // Every outbound request the bootstrap makes (e.g. the hub provider list) gets a benign
  // failure so it fails open. Recorded, so a request to our own settings route is visible.
  h.fetch.mockImplementation(async () => new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', h.fetch);
});

describe('_app settings bootstrap — read in-process', () => {
  it('makes no HTTP request to its own settings route during a server render', async () => {
    const session = { user: { id: 7, username: 'in-process' } };
    answer({ session, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      settingsRequests().map(([input]) => String(input)),
      'a server render must read the settings bootstrap in-process, not over HTTP to its own server'
    ).toEqual([]);
    // Positive control: the session came from the in-process bootstrap, so the empty list
    // above is about the transport, not about a render that never asked for settings.
    expect(h.bootstrap).toHaveBeenCalledTimes(1);
    expect(pageProps.session).toEqual(session);
  });

  it('hands the bootstrap the page request itself', async () => {
    const ctx = makeCtx();
    await getInitialProps(ctx);
    expect(h.bootstrap.mock.calls[0]![0]).toBe(ctx.ctx.req);
  });

  it('logs the alertable marker when it degrades', async () => {
    // Log-based alerting matches this exact prefix: a degraded bootstrap renders a 200, so this
    // line is the only signal that every page is rendering signed-out.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fail(new Error('settings bootstrap timed out after 8000ms'));
    try {
      await getInitialProps(makeCtx());
      expect(warn).toHaveBeenCalledWith(
        '[_app] settings bootstrap fetch failed, rendering without it: settings bootstrap timed out after 8000ms'
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not read the bootstrap at all on a client-side navigation', async () => {
    await getInitialProps(makeClientNavCtx());
    expect(h.bootstrap).not.toHaveBeenCalled();
    expect(settingsRequests()).toEqual([]);
  });
});

describe('_app settings bootstrap — auth cookie discriminator', () => {
  it('renders anonymous but PRESERVES the cookie when the bootstrap returns session: null', async () => {
    answer({ session: null, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    // `hasAuthCookie` — NOT a deleteCookie spy — is the discriminator's only observable now.
    expect(pageProps.hasAuthCookie, 'an authoritative session: null must render anonymous').toBe(
      false
    );
    expect(
      h.deleteCookie,
      'the cookie must never be deleted here: session: null is ambiguous between an expired token and a fail-soft session lookup, and deleting on the latter logs out a valid user'
    ).not.toHaveBeenCalled();
  });

  it('PRESERVES the cookie when the bootstrap carries no session key', async () => {
    answer({});

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
    expect(pageProps.session).toBeNull();
    // Degraded shape: no snapshot is seeded, so the client queries self-heal.
    expect(pageProps.settings).toBeUndefined();
    expect(pageProps.browsingSettingsAddons).toBeUndefined();
  });

  it('PRESERVES the cookie and threads the session through on a real session', async () => {
    const session = { user: { id: 1, username: 'someone' } };
    answer({ session, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
    expect(pageProps.session).toMatchObject(session);
  });

  it('PRESERVES the cookie when the bootstrap rejects outright (a failed session lookup)', async () => {
    fail(new Error('session lookup failed'));

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
  });

  it('PRESERVES the cookie when the bootstrap misses its render deadline', async () => {
    // Models what the render deadline rejects with, without spending the real 8s — the
    // deadline itself is pinned in settings-endpoint-deadlines.test.ts.
    fail(new Error('settings bootstrap timed out after 8000ms'));

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
  });

  it('PRESERVES the cookie when the bootstrap resolves with nothing', async () => {
    answer(undefined);

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
  });

  it('does not touch the cookie when there was no auth cookie to begin with', async () => {
    h.jar = {};
    answer({ session: null, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'nothing to clear when the request carried no auth cookie'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(false);
  });

  // The LEGACY family is the only population the cookie behaviour ever reached — the
  // delete removed here named `civitai-token`, never `civ-token`. Without this case,
  // dropping `|| x.endsWith('civitai-token')` from the matcher passes the whole file:
  // every other fixture uses a modern cookie.
  it('recognises a legacy civitai-token as an auth cookie', async () => {
    h.jar = { '__Secure-civitai-token': 'legacy-token-value' };
    answer({});

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      pageProps.hasAuthCookie,
      'a legacy-cookie session must survive a degraded settings response too'
    ).toBe(true);
    expect(h.deleteCookie).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 AN INVARIANT GUARD, NOT REGRESSION COVERAGE — it passes on the pre-fix tree too.
 *
 * It exists because it is the only executable statement of the PREMISE behind the 5.1.118
 * white-screen: `<FaroProvider region={region.countryCode} />` threw on every client-side
 * navigation because `region` was `undefined` there. The AST guard in
 * `src/tests/pages/app-region-optional-chain.test.ts` pins the optional chain at the call
 * site, but it can only assert that premise in PROSE — nothing fails if the early return
 * below is moved or deleted and `region` starts being populated on the client.
 *
 *     const { req: request } = appContext.ctx;
 *     if (!request) return initialProps;      // <- everything below is serverside only
 *     …
 *     const region = getRegion(request);
 *
 * So: no request ⇒ no `region` in `pageProps`. If someone later hoists `getRegion` above
 * that guard, or supplies a client-side default, this goes red and the optional chain's
 * justification can be revisited on purpose rather than by accident.
 */
/**
 * Props the serverside branch populates UNCONDITIONALLY, and the client-nav branch
 * therefore cannot. One list, asserted PRESENT in the positive control and ABSENT in the
 * client-nav cases, so the two arms cannot drift apart.
 *
 * 🔴 `domain` is deliberately NOT in this list, and the positive control is how that was
 * found. `getRequestDomainColor` returns `undefined` when the host matches no configured
 * color domain, so `domain` is absent on the SERVERSIDE path too under this fixture — it
 * would have sat in the absence ledger proving nothing, which is exactly the failure a
 * one-sided "assert it is missing" test cannot see. Only add a key here after watching the
 * positive control assert it PRESENT.
 */
const SERVERSIDE_ONLY_PROPS = ['region', 'hasAuthCookie', 'serverDomains', 'canIndex'];

describe('_app getInitialProps — SSR-only props are absent on a client-side navigation', () => {
  // 🔴 THE POSITIVE CONTROL, and it runs FIRST on purpose. "`region` is absent" is a
  // reassuring zero: on its own it cannot be told apart from `getInitialProps` throwing
  // early, a stale mock, or a renamed key. This arm proves the probe can see a `region`
  // at all, so the absence in the next test is a fact about the client-nav path.
  it('POSITIVE CONTROL: the SAME call WITH a req populates every one of those keys', async () => {
    answer({ session: null, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    // Asserts the WHOLE ledger, not just `region`. Without this arm the absence test below
    // is a set of assertions over `{}` — it would pass identically if a key were renamed,
    // because the client-nav path returns an empty object whatever the serverside path
    // calls its keys. Pairing the two is what makes the absence mean something.
    for (const key of SERVERSIDE_ONLY_PROPS) {
      expect(pageProps[key], `${key} must be populated on the serverside path`).toBeDefined();
    }
    expect(pageProps).toHaveProperty('region.countryCode');
  });

  it('omits `region` entirely when the context carries no req', async () => {
    const { pageProps } = await getInitialProps(makeClientNavCtx());

    expect(
      'region' in pageProps,
      '`region` must not be present on the client-nav path — the whole reason `_app` has to optional-chain it'
    ).toBe(false);
    expect(pageProps.region).toBeUndefined();
  });

  it('does not reach the serverside branch at all on that path', async () => {
    // What this adds over the case above, stated no wider than it is: it catches a
    // client-side default being introduced for a serverside-only prop OTHER than `region`.
    // It does NOT discriminate a key rename (the client-nav path returns `{}` regardless)
    // nor a thrown bootstrap (that rejects, failing both cases) — the positive control
    // above is what covers the rename.
    const { pageProps } = await getInitialProps(makeClientNavCtx());

    for (const key of SERVERSIDE_ONLY_PROPS) {
      expect(pageProps[key], `${key} is serverside-only and must be absent here`).toBeUndefined();
    }
  });
});

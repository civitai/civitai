/**
 * Pins the auth-cookie discriminator in `_app.getInitialProps`.
 *
 * A SUCCESSFUL settings fetch returning `session: null` means the token is genuinely
 * expired, so the stale cookie is cleared. An endpoint that swallowed an internal error
 * into `200 {}` carries NO `session` key and is NOT authoritative — clearing the cookie
 * there durably logs out a valid user. The two are told apart ONLY by `'session' in data`,
 * which is a key-presence check that reads as an ordinary null-guard; this file exists so
 * that collapsing it into a truthiness check fails loudly instead of silently logging
 * people out.
 *
 * Lives outside `src/pages` deliberately: Next treats every file under there as a route
 * and `next build` rejects a test file, which only that build catches.
 */
import type { AppContext } from 'next/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const h = vi.hoisted(() => ({
  deleteCookie: vi.fn(),
  jar: {} as Record<string, string>,
  respond: null as null | (() => Promise<Response>),
}));

vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('cookies-next')>()),
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  h.deleteCookie.mockClear();
  h.jar = { [AUTH_COOKIE]: 'token-value' };
  h.respond = async () => json({ session: null });
  // URL-aware: only the settings self-fetch is scripted. Anything else the bootstrap
  // happens to call (e.g. the hub provider list) gets a benign failure so it fails open
  // rather than silently consuming the scripted settings response.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes(SETTINGS_PATH)) return h.respond!();
      return new Response(null, { status: 503 });
    })
  );
});

describe('_app settings bootstrap — auth cookie discriminator', () => {
  it('DELETES the cookie when the fetch succeeds and authoritatively returns session: null', async () => {
    h.respond = async () => json({ session: null, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'an authoritative session: null means the token is genuinely expired — the stale cookie must be cleared'
    ).toHaveBeenCalledTimes(1);
    expect(pageProps.hasAuthCookie).toBe(false);
  });

  it('PRESERVES the cookie when the endpoint swallowed an error into 200 {} (no session key)', async () => {
    h.respond = async () => json({});

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
    h.respond = async () => json({ session, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
    expect(pageProps.session).toMatchObject(session);
  });

  it('PRESERVES the cookie when the fetch rejects outright', async () => {
    h.respond = async () => {
      throw new TypeError('fetch failed');
    };

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
  });

  it('PRESERVES the cookie when the fetch aborts on the timeout', async () => {
    // Models what `AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS)` throws, without
    // spending the real 8s — a test that waited would be timing-dependent for no gain.
    h.respond = async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
  });

  it('PRESERVES the cookie on a non-OK status', async () => {
    h.respond = async () => json({ session: null }, 500);

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'auth cookie must survive a non-authoritative settings response — deleting it here logs out a valid user'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(true);
  });

  it('does not touch the cookie when there was no auth cookie to begin with', async () => {
    h.jar = {};
    h.respond = async () => json({ session: null, settings: { features: {} } });

    const { pageProps } = await getInitialProps(makeCtx());

    expect(
      h.deleteCookie,
      'nothing to clear when the request carried no auth cookie'
    ).not.toHaveBeenCalled();
    expect(pageProps.hasAuthCookie).toBe(false);
  });
});

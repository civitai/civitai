/**
 * `_app.getInitialProps` must write its auth-guard redirect at most once per response.
 *
 * Next can run `App.getInitialProps` twice on one request and response: when the page's
 * `getServerSideProps` returns `notFound` (Next re-renders /404) or throws (Next re-renders
 * /_error). By then the first run's 302 is already sent, and a second `writeHead` on the real
 * `ServerResponse` throws `ERR_HTTP_HEADERS_SENT`.
 *
 * Lives outside `src/pages` deliberately: Next treats every file under there as a route.
 */
import type { ServerResponse } from 'node:http';
import type { AppContext } from 'next/app';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealApiPair } from '~/server/utils/__tests__/real-api-response';

const h = vi.hoisted(() => ({
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
}));

// Wholesale on purpose, as in app-settings-bootstrap.test.ts: `_app` uses only this export.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import AppWithTRPC from '~/pages/_app';

const getInitialProps = (
  AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => Promise<unknown> }
).getInitialProps;

/** Runs `_app.getInitialProps` twice on one real response, as a gssp `notFound`/throw does. */
async function renderTwice(url: string) {
  const { req, res } = createRealApiPair({ url, headers: { host: 'civitai.com' } });
  // Counts every attempt, including one that throws, and keeps Node's own behaviour.
  const writeHead = vi.spyOn(res as unknown as ServerResponse, 'writeHead');
  const noop = () => null;
  const ctx = (pathname: string) =>
    ({
      Component: noop,
      AppTree: noop,
      router: {},
      ctx: { req, res, pathname, query: {}, asPath: url, AppTree: noop },
    } as unknown as AppContext);

  await getInitialProps(ctx(url.split('?')[0]));
  await getInitialProps(ctx('/404'));
  return { res: res as unknown as ServerResponse, writeHead };
}

beforeEach(() => {
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: null }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});

describe('_app auth guard: one redirect per response', () => {
  it('signed-out guarded path: one 302 to login across both runs', async () => {
    const { res, writeHead } = await renderTwice('/moderator/no-such-tool');

    expect(writeHead).toHaveBeenCalledTimes(1);
    expect(writeHead).toHaveBeenCalledWith(302, {
      Location: '/login?returnUrl=%2Fmoderator%2Fno-such-tool',
    });
    expect(res.statusCode).toBe(302);
    expect(res.writableEnded).toBe(true);
  });

  it('a path no guard covers is never redirected', async () => {
    const { writeHead } = await renderTwice('/models');

    expect(writeHead).not.toHaveBeenCalled();
  });
});

// `_app` passes the resolved session to the shared-slot sync: a shared cookie that resolved no session must not be
// sent to the hub, which answers it with its sign-in page on every page view. The helper's own rules are in
// session-cookie-roll.test.ts.
describe('_app shared-slot sync in host mode', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_SESSION_COOKIE_MODE', 'host');
    vi.stubEnv('AUTH_JWT_ISSUER', 'https://auth.civitai.com');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function navigate() {
    const { req, res } = createRealApiPair({
      url: '/models',
      headers: {
        host: 'civitai.com',
        'sec-fetch-mode': 'navigate',
        cookie: '__Secure-civ-token=shared-token',
      },
      cookies: { '__Secure-civ-token': 'shared-token' },
    });
    const writeHead = vi.spyOn(res as unknown as ServerResponse, 'writeHead');
    const noop = () => null;
    await getInitialProps({
      Component: noop,
      AppTree: noop,
      router: {},
      ctx: { req, res, pathname: '/models', query: {}, asPath: '/models', AppTree: noop },
    } as unknown as AppContext);
    return { res: res as unknown as ServerResponse, writeHead };
  }

  it('does not send a shared-slot cookie that resolved no session to the hub', async () => {
    const { writeHead } = await navigate();
    expect(writeHead).not.toHaveBeenCalled();
  });

  it('sends a shared-slot cookie that resolved a session through the sync, with its marker', async () => {
    h.bootstrap.mockImplementation(async () => ({ session: { user: { id: 1 } } }));
    const { res, writeHead } = await navigate();
    expect(writeHead).toHaveBeenCalledWith(302, {
      Location: '/api/auth/authorize?returnUrl=%2Fmodels',
    });
    expect(String(res.getHeader('Set-Cookie'))).toContain('civ_slot_sync=');
  });
});

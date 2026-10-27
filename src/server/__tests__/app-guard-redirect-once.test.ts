/**
 * `_app.getInitialProps` writes its auth-guard redirect ONCE per response.
 *
 * Next's pages renderer runs `App.getInitialProps` BEFORE the page's `getServerSideProps`, and it
 * does not stop when the app has already answered: it still calls `getServerSideProps`, and when
 * that returns `notFound` it renders the 404 page on the SAME request and response — which runs
 * `App.getInitialProps` a second time (`next/dist/server/render.js`: `loadGetInitialProps(App)`,
 * then `getServerSideProps`, then `metadata.isNotFound`). A guard that writes `302` on the first
 * run therefore wrote it again on the second, and Node threw `ERR_HTTP_HEADERS_SENT` ("Cannot
 * write headers after they are sent") out of `getInitialProps`. The client still got the first
 * 302, so the only symptom was the error log.
 *
 * It took a page whose gate returns `notFound` for a signed-out viewer, behind a guard that
 * redirects that viewer: `/apps/build` on a preview deploy (every page is login-gated there), and
 * `/moderator/*` slugs with no migrated route in production. A page whose `getServerSideProps`
 * returns props is unaffected — Next sees the sent response and stops — so `/` and `/models` were
 * always clean.
 *
 * The test drives that exact sequence through the REAL `_app`, the REAL page modules and the REAL
 * `createServerSideProps`, against a real `http.ServerResponse`, so a second write throws exactly
 * as it does in production.
 *
 * Lives outside `src/pages` deliberately: Next treats every file under there as a route.
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type * as CookiesNext from 'cookies-next';
import type { GetServerSideProps } from 'next';
import type { AppContext } from 'next/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EnvOther from '~/env/other';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const h = vi.hoisted(() => ({
  env: { isPreview: false, isProd: false },
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
}));

vi.mock('~/env/other', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvOther>()),
  get isPreview() {
    return h.env.isPreview;
  },
  get isProd() {
    return h.env.isProd;
  },
}));

// Signed out: no session cookie in the jar.
vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<typeof CookiesNext>()),
  getCookie: vi.fn(() => 'dark'),
  getCookies: vi.fn(() => ({})),
}));

// The real `getFeatureFlagsAsync` opens a Flipt client. No flag is on, so `/apps/build` resolves
// to `notFound` for the signed-out viewer — the gate's answer for every flag set it can hold.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));

// Wholesale on purpose, as in app-settings-bootstrap.test.ts: `_app` uses only this export.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
}));

vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

// The build page's React graph is irrelevant to its `getServerSideProps`.
vi.mock('~/components/Apps/AppAssistant/AppAssistantWorkspace', () => ({
  AppAssistantWorkspace: () => null,
}));
vi.mock('~/components/Apps/AppsPageLayout', () => ({ AppsPageLayout: () => null }));
vi.mock('~/components/Apps/AppsBuildBody', () => ({ AppsBuildBody: () => null }));

import AppWithTRPC from '~/pages/_app';
import { getServerSideProps as buildGssp } from '~/pages/apps/build';
import { getServerSideProps as moderatorSlugGssp } from '~/pages/moderator/[...slug]';

const getInitialProps = (
  AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => Promise<unknown> }
).getInitialProps;

function makeRequest(url: string) {
  const req = new IncomingMessage(new Socket());
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'civitai.com' };
  const res = new ServerResponse(req);
  // Counts every attempt, including one that throws, and keeps Node's own behaviour.
  const writeHead = vi.spyOn(res, 'writeHead');
  return { req, res, writeHead };
}

function appContext(req: IncomingMessage, res: ServerResponse, pathname: string): AppContext {
  const noop = () => null;
  return {
    Component: noop,
    AppTree: noop,
    router: {},
    ctx: { req, res, pathname, query: {}, asPath: req.url, AppTree: noop },
  } as unknown as AppContext;
}

/**
 * What Next's pages renderer does with a server request, in its order. `params` only for a
 * dynamic page.
 */
async function serve(
  url: string,
  page: { pathname: string; gssp: GetServerSideProps; params?: Record<string, string[]> }
) {
  const { req, res, writeHead } = makeRequest(url);
  await getInitialProps(appContext(req, res, page.pathname));
  const data = await page.gssp({
    req,
    res,
    query: {},
    resolvedUrl: url,
    ...(page.params ? { params: page.params } : {}),
  } as Parameters<GetServerSideProps>[0]);
  // `notFound` → Next renders /404 on the same request and response, through `_app` again.
  if ('notFound' in data && data.notFound) await getInitialProps(appContext(req, res, '/404'));
  return { data, res, writeHead };
}

const BUILD = { pathname: '/apps/build', gssp: buildGssp as GetServerSideProps };

beforeEach(() => {
  h.env.isPreview = false;
  h.env.isProd = false;
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: null }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});

describe('_app auth guard — one redirect per response', () => {
  it.each(['/apps/build', '/apps/build?view=apps'])(
    'signed-out %s on a preview deploy: one 302 to login, no write after the headers are sent',
    async (url) => {
      h.env.isPreview = true;

      const { data, res, writeHead } = await serve(url, BUILD);

      // The page gate's own answer is unchanged: a refused viewer is `notFound`.
      expect(data).toEqual({ notFound: true });
      expect(writeHead).toHaveBeenCalledTimes(1);
      expect(writeHead).toHaveBeenCalledWith(302, {
        Location: '/login?returnUrl=%2Fapps%2Fbuild',
      });
      expect(res.statusCode).toBe(302);
      expect(res.writableEnded).toBe(true);
    }
  );

  it('signed-out /moderator/<unmigrated> in production: the same, through a page not on the shared wrapper', async () => {
    h.env.isProd = true;

    const { data, writeHead } = await serve('/moderator/no-such-tool', {
      pathname: '/moderator/[...slug]',
      gssp: moderatorSlugGssp,
      params: { slug: ['no-such-tool'] },
    });

    expect(data).toEqual({ notFound: true });
    expect(writeHead).toHaveBeenCalledTimes(1);
    expect(writeHead).toHaveBeenCalledWith(302, {
      Location: '/login?returnUrl=%2Fmoderator%2Fno-such-tool',
    });
  });

  it('a page no guard covers is never redirected', async () => {
    const { data, writeHead } = await serve('/apps/build', BUILD);

    expect(data).toEqual({ notFound: true });
    expect(writeHead).not.toHaveBeenCalled();
  });
});

/**
 * `page_render_total` counts HTML documents. Each case replays the hook sequence Next 16.4.3
 * runs for that response, as recorded from a built Next app with logging `_app` and `_document`
 * hooks (normal render: app, document; gSSP notFound: app, app as `/404`, document as `/404`;
 * gSSP throw: app, app as `/_error`, document as `/_error`; gSSP redirect, `_app` redirect and
 * `/_next/data` request: app only). The same request object flows through every hook.
 */
import { instrumentationRegistry } from '@civitai/telemetry/client';
import type * as CookiesNext from 'cookies-next';
import type { AppContext } from 'next/app';
import type client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_RENDER_METRIC } from '~/server/prom/route-traffic.metrics';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import { usePagesManifestFixture } from '~/server/utils/__tests__/pages-manifest.fixture';

const h = vi.hoisted(() => ({
  jar: {} as Record<string, string>,
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
}));

vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<typeof CookiesNext>()),
  getCookie: vi.fn(() => 'dark'),
  getCookies: vi.fn(() => h.jar),
  deleteCookie: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({})),
}));

// Wholesale on purpose, as in app-settings-bootstrap.test.ts: the real module pulls the server
// env schema, the database and redis into the render.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
}));

import AppWithTRPC from '~/pages/_app';
import AppDocument from '~/pages/_document';

const appGetInitialProps = (
  AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => Promise<unknown> }
).getInitialProps;

type Req = { headers: Record<string, string>; url: string };

function runApp(req: Req, pathname: string) {
  const noop = () => null;
  return appGetInitialProps({
    Component: noop,
    AppTree: noop,
    router: {},
    ctx: { req, pathname, query: {}, asPath: req.url, AppTree: noop },
  } as unknown as AppContext);
}

function runDocument(req: Req, pathname: string) {
  return AppDocument.getInitialProps({
    req,
    pathname,
    defaultGetInitialProps: async () => ({ html: '', head: [], styles: [] }),
  } as unknown as Parameters<typeof AppDocument.getInitialProps>[0]);
}

async function rows() {
  const metric = instrumentationRegistry.getSingleMetric(PAGE_RENDER_METRIC) as
    | client.Counter<string>
    | undefined;
  return metric ? (await metric.get()).values : [];
}

const signedIn = () =>
  h.bootstrap.mockImplementation(async () => ({
    session: { user: { id: 7 } },
    settings: { features: {} },
  }));
const anonymous = () => h.bootstrap.mockImplementation(async () => ({ session: null }));
const degraded = () =>
  h.bootstrap.mockImplementation(async () => {
    throw new Error('render deadline');
  });

beforeEach(() => {
  usePagesManifestFixture();
  (
    instrumentationRegistry.getSingleMetric(PAGE_RENDER_METRIC) as client.Counter | undefined
  )?.reset();
  h.jar = {};
  h.bootstrap.mockReset();
  anonymous();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('page_render_total counts HTML documents', () => {
  it('a normal render counts once, under its route pattern, with the session from _app', async () => {
    signedIn();
    const req = { headers: { host: 'civitai.com' }, url: '/models/1/slug' };
    await runApp(req, '/models/[id]/[[...slug]]');
    await runDocument(req, '/models/[id]/[[...slug]]');
    expect(await rows()).toEqual([
      {
        value: 1,
        labels: { route: '/models/[id]/[[...slug]]', authed: 'true', bot_class: 'none' },
      },
    ]);
  });

  it('a gSSP notFound counts once, as /404, and not under the original route', async () => {
    const req = { headers: {}, url: '/models/1/slug' };
    await runApp(req, '/models/[id]/[[...slug]]');
    await runApp(req, '/404');
    await runDocument(req, '/404');
    expect(await rows()).toEqual([
      { value: 1, labels: { route: '/404', authed: 'false', bot_class: 'none' } },
    ]);
  });

  it('a thrown gSSP counts once, as /_error', async () => {
    const req = { headers: {}, url: '/images' };
    await runApp(req, '/images');
    await runApp(req, '/_error');
    await runDocument(req, '/_error');
    expect(await rows()).toEqual([
      { value: 1, labels: { route: '/_error', authed: 'false', bot_class: 'none' } },
    ]);
  });

  // Next never calls _document for these (observed above); what this pins is that _app does not
  // count them itself.
  it('_app.getInitialProps counts nothing, so redirects and /_next/data requests count zero', async () => {
    signedIn();
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await runApp({ headers: {}, url: '/images' }, '/images');
    await appGetInitialProps({
      Component: () => null,
      AppTree: () => null,
      router: {},
      ctx: {
        req: { headers: {}, url: '/moderator/x' },
        res,
        pathname: '/moderator/[[...slug]]',
        query: {},
      },
    } as unknown as AppContext);
    expect(res.writeHead).toHaveBeenCalledWith(302, expect.anything());
    await runApp({ headers: {}, url: '/_next/data/build/images.json' }, '/images');
    expect(await rows()).toEqual([]);
  });
});

describe('the recorded hook sequences', () => {
  // They were recorded on this Next version; a different one may run the hooks differently.
  it('still describe the installed Next', async () => {
    const { version } = await import('next/package.json');
    expect(
      version,
      'Next changed: re-record the _app/_document hook order for normal, notFound, throw, redirect and data responses, then update this file'
    ).toBe('16.4.3');
  });
});

describe('page_render_total authed', () => {
  it('is unknown, not false, when the session lookup degraded for a signed-in-looking request', async () => {
    h.jar = { '__Secure-civ-token': 'token' };
    degraded();
    const req = { headers: {}, url: '/images' };
    await runApp(req, '/images');
    await runDocument(req, '/images');
    expect((await rows())[0]?.labels.authed).toBe('unknown');
  });

  it('is false when the lookup degraded but there is no session cookie', async () => {
    degraded();
    const req = { headers: {}, url: '/images' };
    await runApp(req, '/images');
    await runDocument(req, '/images');
    expect((await rows())[0]?.labels.authed).toBe('false');
  });

  it('follows the LAST _app run on the request, so a degraded first pass does not stick', async () => {
    h.jar = { '__Secure-civ-token': 'token' };
    const req = { headers: {}, url: '/models/1/slug' };
    degraded();
    await runApp(req, '/models/[id]/[[...slug]]');
    anonymous();
    await runApp(req, '/404');
    await runDocument(req, '/404');
    expect((await rows())[0]?.labels.authed).toBe('false');
  });
});

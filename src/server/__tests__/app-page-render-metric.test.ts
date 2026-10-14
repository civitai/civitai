/**
 * `_app.getInitialProps` records one `page_render_total` per server render, with the route
 * PATTERN, and none on a client-side navigation (where the same function runs in the browser).
 */
import type * as CookiesNext from 'cookies-next';
import type { AppContext } from 'next/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as RouteTraffic from '~/server/prom/route-traffic.metrics';

const h = vi.hoisted(() => ({
  bootstrap: vi.fn<(req: unknown) => Promise<unknown>>(),
  recordPageRender: vi.fn(),
}));

vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<typeof CookiesNext>()),
  getCookie: vi.fn(() => 'dark'),
  getCookies: vi.fn(() => ({})),
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

vi.mock('~/server/prom/route-traffic.metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof RouteTraffic>()),
  recordPageRender: h.recordPageRender,
}));

import AppWithTRPC from '~/pages/_app';

const getInitialProps = (
  AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => Promise<unknown> }
).getInitialProps;

function makeCtx(req: unknown, pathname: string): AppContext {
  const noop = () => null;
  return {
    Component: noop,
    AppTree: noop,
    router: {},
    ctx: { req, pathname, query: {}, asPath: '/models/1/slug', AppTree: noop },
  } as unknown as AppContext;
}

beforeEach(() => {
  h.recordPageRender.mockReset();
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: null }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});

describe('_app page_render_total', () => {
  it('records a server render once, with the route pattern and anonymous state', async () => {
    const headers = { host: 'civitai.com', 'x-civitai-verified-bot': 'googlebot' };
    await getInitialProps(makeCtx({ headers, url: '/models/1/slug' }, '/models/[id]/[[...slug]]'));
    expect(h.recordPageRender).toHaveBeenCalledTimes(1);
    expect(h.recordPageRender).toHaveBeenCalledWith({
      route: '/models/[id]/[[...slug]]',
      authed: false,
      headers,
    });
  });

  it('reports a signed-in render as authed', async () => {
    h.bootstrap.mockImplementation(async () => ({
      session: { user: { id: 7 } },
      settings: { features: {} },
    }));
    await getInitialProps(makeCtx({ headers: { host: 'civitai.com' }, url: '/' }, '/'));
    expect(h.recordPageRender).toHaveBeenCalledWith(expect.objectContaining({ authed: true }));
  });

  it('records nothing on a client-side navigation', async () => {
    await getInitialProps(makeCtx(undefined, '/models/[id]/[[...slug]]'));
    expect(h.recordPageRender).not.toHaveBeenCalled();
  });
});

/**
 * The response headers of `/images/[imageId]`, through the hooks Next runs for a page request in
 * this order (`next/dist/server/render.js`, 16.3.1: `_app.getInitialProps`, the page's
 * `getServerSideProps`, then `_document.getInitialProps` once the page rendered, on one request):
 * the real `_app`, `createServerSideProps` with the page's `shell` option, and `_document`. Only a
 * shell render may carry the edge-cache header, and it may carry no cookie.
 *
 * Lives outside `src/pages`: Next treats every file there as a route.
 */
import type { AppContext } from 'next/app';
import type { GetServerSidePropsContext } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as AuthSessionModule from '~/server/auth/get-server-auth-session';

const h = vi.hoisted(() => ({
  flags: { shellMaster: true, shellImages: true } as Record<string, boolean>,
  bootstrap: vi.fn(),
  authSession: vi.fn(),
}));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync: vi.fn(async () => ({ ...h.flags })),
}));

// Wholesale on purpose, as in app-settings-bootstrap.test.ts: the real module pulls the server
// env schema, the database and redis into the render.
vi.mock('~/server/services/settings-bootstrap.service', () => ({
  resolveSettingsBootstrapForRender: h.bootstrap,
  resolveShellSeeds: vi.fn(async () => ({ liveNow: false })),
}));

vi.mock('~/server/auth/get-server-auth-session', async (importOriginal) => ({
  ...(await importOriginal<typeof AuthSessionModule>()),
  getServerAuthSession: h.authSession,
}));

import AppWithTRPC from '~/pages/_app';
import AppDocument from '~/pages/_document';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

const appGetInitialProps = (
  AppWithTRPC as unknown as { getInitialProps: (c: AppContext) => Promise<unknown> }
).getInitialProps;

const ROUTE = '/images/[imageId]';
const SESSION = { user: { id: 3171, username: 'header-matrix' } };
const SHELL_COOKIES = '__Secure-civ-token=a.b.c; civ-shell-images=1';

const gssp = createServerSideProps({
  useSession: true,
  shell: 'images',
  resolver: async () => ({ props: {} }),
});
/** The same page without the `shell` option: what a route listed in SHELL_ROUTES by mistake has. */
const fullOnlyGssp = createServerSideProps({
  useSession: true,
  resolver: async () => ({ props: {} }),
});

function fakeResponse(initial: Record<string, unknown> = {}) {
  const headers = new Map<string, unknown>(
    Object.entries(initial).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    headersSent: false,
    finished: false,
    setHeader: (name: string, value: unknown) => void headers.set(name.toLowerCase(), value),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    removeHeader: (name: string) => void headers.delete(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
    writeHead: () => undefined,
    end: () => undefined,
  };
}

/** One page request through `_app` then `getServerSideProps`, as Next runs them. */
async function request({
  url = '/images/123',
  headers = {},
  preset = {},
  page = gssp,
  method = 'GET',
}: {
  url?: string;
  headers?: Record<string, string>;
  preset?: Record<string, unknown>;
  page?: typeof gssp;
  method?: string;
}) {
  const req = {
    method,
    url,
    headers: { host: 'civitai.com', cookie: SHELL_COOKIES, ...headers },
  };
  const res = fakeResponse(preset);
  const imageId = url.split('?')[0]!.split('/').pop()!;
  const query: Record<string, string> = { imageId };
  for (const [k, v] of new URLSearchParams(url.split('?')[1] ?? '')) query[k] = v;
  const noop = () => null;
  await appGetInitialProps({
    Component: noop,
    AppTree: noop,
    router: { asPath: url, query },
    ctx: { req, res, pathname: ROUTE, query, asPath: url, AppTree: noop },
  } as unknown as AppContext);
  const result = await page({
    req,
    res,
    query,
    params: { imageId },
    resolvedUrl: url,
  } as unknown as GetServerSidePropsContext);
  // A redirect is sent without rendering anything (`render.js`): no document.
  if ('redirect' in result) return { headers: res.getHeaders(), result, req, res };
  // Then the document, which Next renders only once the page rendered (its `renderPage` is stubbed).
  await AppDocument.getInitialProps({
    req,
    res,
    pathname: ROUTE,
    query,
    asPath: url,
    defaultGetInitialProps: async () => ({ html: '', head: [], styles: [] }),
  } as unknown as Parameters<typeof AppDocument.getInitialProps>[0]);
  return { headers: res.getHeaders(), result, req, res };
}

/** What Next does after a page throws: reset Cache-Control, then `_app` and `_document` as `/_error`. */
async function errorRender(req: object, res: ReturnType<typeof fakeResponse>) {
  res.setHeader('Cache-Control', 'private, no-cache, no-store, max-age=0, must-revalidate');
  const noop = () => null;
  await appGetInitialProps({
    Component: noop,
    AppTree: noop,
    router: { asPath: '/images/123', query: {} },
    ctx: { req, res, pathname: '/_error', query: {}, asPath: '/images/123', AppTree: noop },
  } as unknown as AppContext);
  await AppDocument.getInitialProps({
    req,
    res,
    pathname: '/_error',
    query: {},
    asPath: '/images/123',
    defaultGetInitialProps: async () => ({ html: '', head: [], styles: [] }),
  } as unknown as Parameters<typeof AppDocument.getInitialProps>[0]);
}

const EDGE_HEADERS = ['cloudflare-cdn-cache-control', 'cache-tag', 'x-civ-render'];

function expectFullRender(headers: Record<string, unknown>) {
  for (const name of EDGE_HEADERS) expect(headers, name).not.toHaveProperty(name);
}

beforeEach(() => {
  h.flags = { shellMaster: true, shellImages: true };
  h.bootstrap.mockReset();
  h.bootstrap.mockImplementation(async () => ({ session: SESSION, settings: { features: {} } }));
  h.authSession.mockReset();
  h.authSession.mockImplementation(async () => SESSION);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 }))
  );
});

describe('a shell render', () => {
  it('is edge-cacheable, private to browsers, tagged, labelled and sets no cookie', async () => {
    // A cookie written on the way (here: before the page ran) must not reach a cached response.
    const { headers, result } = await request({ preset: { 'Set-Cookie': ['ref=1; Path=/'] } });

    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers['cloudflare-cdn-cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=30'
    );
    expect(headers['cache-tag']).toMatch(/^shell,shell-images,build-[\w-]+$/);
    expect(headers['x-civ-render']).toBe('shell');
    expect(headers).not.toHaveProperty('set-cookie');
    expect(result).toEqual({ props: { adsGated: true } });
    // Nothing per viewer was read.
    expect(h.bootstrap).not.toHaveBeenCalled();
    expect(h.authSession).not.toHaveBeenCalled();
  });
});

describe('every other response is a full render without the edge headers', () => {
  it.each<[string, Parameters<typeof request>[0], () => void]>([
    ['the kill switch off', {}, () => (h.flags.shellMaster = false)],
    ['an Authorization header', { headers: { authorization: 'Bearer key' } }, () => undefined],
    ['a ?token= credential', { url: '/images/123?token=abc' }, () => undefined],
    ['the ?civ-shell=0 bypass', { url: '/images/123?civ-shell=0' }, () => undefined],
    ['a verified bot', { headers: { 'x-civitai-verified-bot': 'googlebot' } }, () => undefined],
    ['no route cookie', { headers: { cookie: '__Secure-civ-token=a.b.c' } }, () => undefined],
  ])('with %s', async (_, input, arrange) => {
    arrange();
    const { headers, result } = await request(input);
    expectFullRender(headers);
    expect(result).toMatchObject({ props: { session: SESSION } });
  });
});

describe('a full render keeps the route cookie in step with the viewer’s flag', () => {
  const setCookies = (headers: Record<string, unknown>) =>
    ([] as unknown[]).concat(headers['set-cookie'] ?? []).map(String);

  it('sets it for a signed-in viewer the flag is on for', async () => {
    h.flags.shellMaster = false;
    const { headers } = await request({ headers: { cookie: '__Secure-civ-token=a.b.c' } });
    expect(setCookies(headers)).toEqual([
      'civ-shell-images=1; Path=/; Max-Age=604800; Secure; SameSite=Lax',
    ]);
  });

  it('clears it once the flag is off for them', async () => {
    h.flags = { shellMaster: false, shellImages: false };
    const { headers } = await request({});
    expect(setCookies(headers)).toEqual([
      'civ-shell-images=; Path=/; Max-Age=0; Secure; SameSite=Lax',
    ]);
  });

  it('leaves a cookie that is already right alone', async () => {
    h.flags.shellMaster = false;
    const { headers } = await request({});
    expect(setCookies(headers)).toEqual([]);
  });

  it('clears it for a signed-out viewer', async () => {
    h.flags.shellMaster = false;
    h.bootstrap.mockImplementation(async () => ({ session: null }));
    h.authSession.mockImplementation(async () => null);
    const { headers } = await request({});
    expect(setCookies(headers)).toEqual([
      'civ-shell-images=; Path=/; Max-Age=0; Secure; SameSite=Lax',
    ]);
  });
});

describe('the edge headers go only with a shell the page itself rendered', () => {
  it('a route _app marks whose page has no shell option: a full render, no edge headers, cookies kept', async () => {
    const { headers, result } = await request({
      page: fullOnlyGssp,
      preset: { 'Set-Cookie': ['ref=1; Path=/'] },
    });
    expect(result).toMatchObject({ props: { session: SESSION } });
    expectFullRender(headers);
    expect(headers['set-cookie']).toEqual(['ref=1; Path=/']);
  });

  it('a throw after the document added them: the /_error render carries none of them', async () => {
    const { req, res, headers } = await request({});
    // Control: this response did carry them.
    expect(headers['x-civ-render']).toBe('shell');
    await errorRender(req, res);
    expectFullRender(res.getHeaders());
  });
});

/**
 * The canonical path `/images/shell`, where the edge sends every eligible `/images/<id>` request
 * with the original URL in `x-civ-shell-orig`. It answers with the shell, or with a 307 back to the
 * original URL plus `?civ-shell=0` — private, no cookie, no edge-cache header — and is never
 * rendered for a viewer.
 */
describe('the canonical shell path', () => {
  const CANONICAL = '/images/shell';
  const ORIG = { 'x-civ-shell-orig': '/images/123?postId=5' };
  const BOUNCE = '/images/123?postId=5&civ-shell=0';

  function expectBounce(
    { headers, result }: Awaited<ReturnType<typeof request>>,
    destination: string
  ) {
    expect(result).toEqual({ redirect: { destination, permanent: false } });
    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers).not.toHaveProperty('set-cookie');
    expectFullRender(headers);
    // The page bounces before it reads a session (`_app`'s bootstrap is its own and is discarded).
    expect(h.authSession).not.toHaveBeenCalled();
  }

  it('an eligible request gets the shell, with the shell’s headers', async () => {
    const { headers, result } = await request({
      url: CANONICAL,
      headers: ORIG,
      preset: { 'Set-Cookie': ['ref=1; Path=/'] },
    });
    expect(result).toEqual({ props: { adsGated: true } });
    expect(headers['x-civ-render']).toBe('shell');
    expect(headers['cloudflare-cdn-cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=30'
    );
    expect(headers['cache-tag']).toMatch(/^shell,shell-images,build-[\w-]+$/);
    expect(headers['cache-control']).toBe('private, no-store');
    expect(headers).not.toHaveProperty('set-cookie');
  });

  it.each<[string, Parameters<typeof request>[0], () => void]>([
    ['the kill switch off', {}, () => (h.flags.shellMaster = false)],
    ['a HEAD request', { method: 'HEAD' }, () => undefined],
    ['a data request header', { headers: { 'x-nextjs-data': '1' } }, () => undefined],
    ['an Authorization header', { headers: { authorization: 'Bearer key' } }, () => undefined],
    ['a verified bot', { headers: { 'x-civitai-verified-bot': 'googlebot' } }, () => undefined],
    ['no session cookie', { headers: { cookie: 'civ-shell-images=1' } }, () => undefined],
    ['no route cookie', { headers: { cookie: '__Secure-civ-token=a.b.c' } }, () => undefined],
    ['a blocked region', { headers: { 'cf-ipcountry': 'GB' } }, () => undefined],
  ])('declined for %s: 307 to the original URL with civ-shell=0', async (_, input, arrange) => {
    arrange();
    const out = await request({
      ...input,
      url: CANONICAL,
      headers: { ...ORIG, ...input.headers },
      // A cookie written on the way must not ride the bounce.
      preset: { 'Set-Cookie': ['ref=1; Path=/'] },
    });
    expectBounce(out, BOUNCE);
  });

  it.each<[string, string, string]>([
    ['the bypass', '/images/123?civ-shell=0', '/images/123?civ-shell=0'],
    ['a ?token= credential', '/images/123?token=abc', '/images/123?token=abc&civ-shell=0'],
  ])('declined for %s in the ORIGINAL URL', async (_, orig, destination) => {
    expectBounce(
      await request({
        url: CANONICAL,
        headers: { 'x-civ-shell-orig': orig },
        preset: { 'Set-Cookie': ['ref=1; Path=/'] },
      }),
      destination
    );
  });

  it('runs after _app’s full path and still leaves no cookie or edge header on the 307', async () => {
    // Refused (no route cookie), so `_app` takes its full path; a full render would also set the
    // route cookie here, which the bounce must not.
    const out = await request({
      url: CANONICAL,
      headers: { ...ORIG, cookie: '__Secure-civ-token=a.b.c' },
      preset: {
        'Set-Cookie': ['ref=1; Path=/'],
        'Cloudflare-CDN-Cache-Control': 'public, max-age=60',
        'Cache-Tag': 'shell',
        'X-Civ-Render': 'shell',
      },
    });
    expectBounce(out, BOUNCE);
    // CONTROL: `_app` did take its full path (the bootstrap ran).
    expect(h.bootstrap).toHaveBeenCalled();
  });

  it.each<[string, Record<string, string>]>([
    ['no original URL', {}],
    ['an absolute URL', { 'x-civ-shell-orig': 'https://evil.example/images/123' }],
    ['a protocol-relative URL', { 'x-civ-shell-orig': '//evil.example/images/123' }],
    ['another path', { 'x-civ-shell-orig': '/user/account' }],
    ['the canonical path', { 'x-civ-shell-orig': CANONICAL }],
  ])('declined for %s: 307 to /images', async (_, headers) => {
    expectBounce(
      await request({ url: CANONICAL, headers, preset: { 'Set-Cookie': ['ref=1; Path=/'] } }),
      '/images'
    );
  });

  it('a data request for the canonical path is bounced too, never resolved', async () => {
    // Next hands getServerSideProps the page path as `resolvedUrl` for a `/_next/data` request.
    const req = { method: 'GET', url: '/_next/data/b/images/shell.json', headers: { ...ORIG } };
    const res = fakeResponse();
    const result = await gssp({
      req,
      res,
      query: { imageId: 'shell' },
      params: { imageId: 'shell' },
      resolvedUrl: CANONICAL,
    } as unknown as GetServerSidePropsContext);
    expect(result).toEqual({ redirect: { destination: BOUNCE, permanent: false } });
    expect(h.authSession).not.toHaveBeenCalled();
  });

  it('CONTROL: the same declined request on a real image URL is a full render', async () => {
    h.flags.shellMaster = false;
    const { headers, result } = await request({ headers: ORIG });
    expect(result).toMatchObject({ props: { session: SESSION } });
    expectFullRender(headers);
  });
});

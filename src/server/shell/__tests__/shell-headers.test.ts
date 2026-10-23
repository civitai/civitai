/**
 * The response headers of `/images/[imageId]`, through the two hooks Next runs for a page request
 * in this order (`next/dist/server/render.js`, 16.3.1: `_app.getInitialProps`, then the page's
 * `getServerSideProps`, on the same request): the real `_app` and the real `createServerSideProps`
 * with the page's `shell` option. Only a shell render may carry the edge-cache header, and it may
 * carry no cookie.
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
}: {
  url?: string;
  headers?: Record<string, string>;
  preset?: Record<string, unknown>;
}) {
  const req = {
    method: 'GET',
    url,
    headers: { host: 'civitai.com', cookie: SHELL_COOKIES, ...headers },
  };
  const res = fakeResponse(preset);
  const query: Record<string, string> = { imageId: '123' };
  for (const [k, v] of new URLSearchParams(url.split('?')[1] ?? '')) query[k] = v;
  const noop = () => null;
  await appGetInitialProps({
    Component: noop,
    AppTree: noop,
    router: { asPath: url, query },
    ctx: { req, res, pathname: ROUTE, query, asPath: url, AppTree: noop },
  } as unknown as AppContext);
  const result = await gssp({
    req,
    res,
    query,
    params: { imageId: '123' },
    resolvedUrl: url,
  } as unknown as GetServerSidePropsContext);
  return { headers: res.getHeaders(), result };
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

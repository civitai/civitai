import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The lean tRPC runtime (`scripts/trpc-server/lean-trpc.cjs`) replaces ONE step of Next's pages-API
 * template: the route module's per-request `prepare`. These tests run Next's own `prepare` (the
 * `PagesAPIRouteModule` of Next's pages-API runtime, on a build-shaped dist directory) and the lean
 * handler on the same requests, and require the same outcome: the `req.query` and `req.url` the
 * route's handler sees, and the response headers `prepare` sets. The full request-by-request
 * comparison against a running `server.js` is the parity job's lean container.
 *
 * Note: Next's `prepare` installs its unhandled-rejection logger in this worker, as it does in a
 * server.
 */

const require = createRequire(import.meta.url);
const lean = require('../lean-trpc.cjs');
const { PagesAPIRouteModule } = require('next/dist/compiled/next-server/pages-api.runtime.prod.js');
const { setRequestMeta } = require('next/dist/server/request-meta');

const PAGE = '/api/trpc/[trpc]';
const PREVIEW = {
  previewModeId: 'p'.repeat(32),
  previewModeSigningKey: 's'.repeat(64),
  previewModeEncryptionKey: 'e'.repeat(64),
};

let projectDir: string;
let distDir: string;
let relativeProjectDir: string;

/** The manifests Next's `loadManifests` reads for a pages-API route, in this app's shape (one locale). */
function writeDist(dir: string) {
  const write = (rel: string, value: unknown) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('routes-manifest.json', {
    version: 3,
    basePath: '',
    caseSensitive: false,
    i18n: { locales: ['en'], defaultLocale: 'en' },
    // The second rewrite matches one tRPC path, which the lean runtime must hand to the route
    // module (see the delegation tests below); the first, like a real build's, matches none.
    rewrites: {
      beforeFiles: [],
      afterFiles: [
        { source: '/:nextInternalLocale(en)/_axiom/web-vitals', destination: '/x' },
        { source: '/:nextInternalLocale(en)/api/trpc/rewritten', destination: '/y' },
      ],
      fallback: [],
    },
    redirects: [],
    headers: [],
    dynamicRoutes: [],
    staticRoutes: [],
  });
  write('prerender-manifest.json', {
    version: 4,
    routes: {},
    dynamicRoutes: {},
    notFoundRoutes: [],
    preview: PREVIEW,
  });
  write('server/preview-props.json', PREVIEW);
  write('build-manifest.json', { pages: {} });
  write('server/next-font-manifest.json', {});
  write('required-server-files.json', { version: 1, config: { experimental: {} } });
  write('BUILD_ID', 'lean-trpc-test');
}

beforeAll(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), 'lean-trpc-'));
  distDir = path.join(projectDir, '.next');
  writeDist(distDir);
  relativeProjectDir = path.relative(process.cwd(), projectDir);
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** A GET request with no body, as the server receives it, and its response. */
function request(url: string, headers: Record<string, string> = {}) {
  const req = new http.IncomingMessage(new net.Socket());
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'localhost:3000', ...headers };
  req.push(null);
  const res = new http.ServerResponse(req);
  return { req, res };
}

/** What the route handler saw, and the headers on the response when it ran. */
type Seen = { query: unknown; url: string | undefined; headers: Record<string, unknown> };

function recordingUserland(sink: { seen?: Seen; delegated?: string }) {
  return {
    config: { api: { bodyParser: { sizeLimit: '17mb' } } },
    // The compiled module's own handler (Next's whole runtime): recorded, never run here.
    handler: async (req: any, res: any) => {
      sink.delegated = req.url;
      res.end('route module');
    },
    default: async (req: any, res: any) => {
      sink.seen = { query: req.query, url: req.url, headers: { ...res.getHeaders() } };
      res.end('ok');
    },
  };
}

/** Next's own template steps for this page: `prepare`, then the query `render` is given. */
async function viaNextPrepare(url: string, headers?: Record<string, string>): Promise<Seen> {
  const { req, res } = request(url, headers);
  setRequestMeta(req, { relativeProjectDir, distDir });
  const routeModule = new PagesAPIRouteModule({
    definition: { kind: 'PAGES_API', page: PAGE, pathname: PAGE, bundlePath: '', filename: '' },
    userland: recordingUserland({}),
    distDir: '.next',
    relativeProjectDir,
  });
  const prepared = await routeModule.prepare(req, res, { srcPage: PAGE });
  expect(prepared).toBeTruthy();
  return {
    query: { ...prepared.query, ...prepared.params },
    url: req.url,
    headers: { ...res.getHeaders() },
  };
}

async function viaLean(url: string, headers?: Record<string, string>): Promise<Seen> {
  const sink: { seen?: Seen } = {};
  const handler = lean.createLeanPageHandler({
    page: PAGE,
    mod: recordingUserland(sink),
    projectDir,
    distDir,
    relativeProjectDir,
    nextConfig: { experimental: {} },
    PagesAPIRouteModule,
  });
  const { req, res } = request(url, headers);
  await handler(req, res, { requestMeta: { relativeProjectDir, distDir } });
  expect(sink.seen, 'the lean handler never reached the route handler').toBeDefined();
  return sink.seen as Seen;
}

describe('lean prepare matches Next prepare', () => {
  it.each([
    ['a query', '/api/trpc/content.get?input=%7B%22json%22%3A%7B%7D%7D'],
    ['a batch', '/api/trpc/a.b,c.d?batch=1&input=%7B%220%22%3A%7B%7D%7D'],
    ['no query string', '/api/trpc/system.getLiveNow'],
    ['the route param also in the query', '/api/trpc/content.get?trpc=system.getLiveNow&x=1'],
    ['an encoded segment', '/api/trpc/content%2Eget'],
    ['a non-ASCII segment', '/api/trpc/%E2%9C%93'],
    ["the page's own placeholder", '/api/trpc/%5Btrpc%5D'],
    ['a repeated key', '/api/trpc/x?input=1&input=2'],
    ['plus, escapes and a bare key', "/api/trpc/x?a+b=c%20d&e&f=(')*!"],
    ['a Next param-prefixed key', '/api/trpc/x?nxtPtrpc=y&q=1'],
    ['another Next-prefixed key', '/api/trpc/x?nxtPother=y&nxtIz=1&q=1'],
  ])('%s', async (_label, url) => {
    const next = await viaNextPrepare(url);
    // Positive control: Next's prepare resolved a route param, so the comparison has content.
    expect((next.query as Record<string, unknown>).trpc).toBeDefined();
    expect(await viaLean(url)).toEqual(next);
  });

  it.each([
    ['a Next data request', { 'x-nextjs-data': '1' }],
    ['one preview cookie without the other', { cookie: '__prerender_bypass=stale' }],
    ['a stale preview pair', { cookie: '__prerender_bypass=old; __next_preview_data=x' }],
    ['forwarded https', { 'x-forwarded-proto': 'https' }],
  ])('%s', async (_label, headers) => {
    const url = '/api/trpc/user.getSelfStatus';
    const next = await viaNextPrepare(url, headers);
    expect(await viaLean(url, headers)).toEqual(next);
  });

  // Positive control for the header comparison above: these requests make Next's prepare set a
  // response header, so an equal pair is not two empty sets.
  it('Next prepare does set the headers those cases compare', async () => {
    const data = await viaNextPrepare('/api/trpc/x', { 'x-nextjs-data': '1' });
    expect(data.headers['x-nextjs-matched-path']).toBe('/en/api/trpc/[trpc]');
    const preview = await viaNextPrepare('/api/trpc/x', { cookie: '__prerender_bypass=stale' });
    expect(String(preview.headers['set-cookie'])).toContain('__prerender_bypass=;');
  });
});

describe('loadedPagesApiRouteModuleClass', () => {
  class Fake {}
  const runtime = (file: string) => ({ [file]: { exports: { PagesAPIRouteModule: Fake } } });
  const NM = '/app/node_modules/next/dist/compiled/next-server';
  const unrelated = {
    '/app/node_modules/next/dist/server/next-server.js': { exports: {} },
    [`${NM}/pages-api.runtime.dev.js`]: { exports: { PagesAPIRouteModule: class {} } },
    [`${NM}/app-page.runtime.prod.js`]: { exports: {} },
  };

  it.each(['pages-api.runtime.prod.js', 'pages-api-turbo.runtime.prod.js'])(
    'returns the class of the one loaded runtime (%s)',
    (name) => {
      const cache = { ...unrelated, ...runtime(`${NM}/${name}`) };
      expect(lean.loadedPagesApiRouteModuleClass(cache)).toBe(Fake);
    }
  );

  it('refuses when no runtime is loaded, or two are', () => {
    expect(() => lean.loadedPagesApiRouteModuleClass(unrelated)).toThrow(/found 0/);
    const two = {
      ...runtime(`${NM}/pages-api.runtime.prod.js`),
      ...runtime(`${NM}/pages-api-turbo.runtime.prod.js`),
    };
    expect(() => lean.loadedPagesApiRouteModuleClass(two)).toThrow(/found 2/);
  });
});

describe('assertPreconditions', () => {
  const ok = {
    routesManifest: {
      basePath: '',
      i18n: { locales: ['en'], defaultLocale: 'en' },
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    },
    nextConfig: { experimental: {} },
    page: PAGE,
  };

  it("accepts this app's build shape", () => {
    expect(() => lean.assertPreconditions(ok)).not.toThrow();
  });

  it.each([
    ['a basePath', { routesManifest: { ...ok.routesManifest, basePath: '/x' } }, /basePath/],
    [
      'domain locales',
      {
        routesManifest: {
          ...ok.routesManifest,
          i18n: {
            locales: ['en'],
            defaultLocale: 'en',
            domains: [{ domain: 'x.test', defaultLocale: 'en' }],
          },
        },
      },
      /domains/,
    ],
    ['a catch-all page', { page: '/api/trpc/[...trpc]' }, /one trailing/],
    ['a static page', { page: '/api/live' }, /one trailing/],
  ])('refuses %s', (_label, override, message) => {
    expect(() => lean.assertPreconditions({ ...ok, ...override })).toThrow(message);
  });
});

describe('a request a rewrite can match', () => {
  async function run(url: string) {
    const sink: { seen?: Seen; delegated?: string } = {};
    const handler = lean.createLeanPageHandler({
      page: PAGE,
      mod: recordingUserland(sink),
      projectDir,
      distDir,
      relativeProjectDir,
      nextConfig: { experimental: {} },
      PagesAPIRouteModule,
    });
    const { req, res } = request(url);
    await handler(req, res, { requestMeta: { relativeProjectDir, distDir } });
    return sink;
  }

  it("is served by the route module's own handler", async () => {
    const sink = await run('/api/trpc/rewritten?input=1');
    expect(sink.delegated).toBe('/api/trpc/rewritten?input=1');
    expect(sink.seen).toBeUndefined();
  });

  it('every other request is served by the lean runtime', async () => {
    const sink = await run('/api/trpc/rewritten2?input=1');
    expect(sink.delegated).toBeUndefined();
    expect(sink.seen).toBeDefined();
  });
});

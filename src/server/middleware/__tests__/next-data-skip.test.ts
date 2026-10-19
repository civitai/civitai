import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

// The routes-manifest shape `next build` writes: `dataRoutes` holds the pages with
// getServerSideProps/getStaticProps, `staticRoutes` every page without a dynamic segment.
const BUILD_ID = 'test-build';
const STATIC_PAGES = [
  '/',
  '/404',
  '/models',
  '/search/models',
  '/images',
  '/videos',
  '/pricing',
  '/api/v1/images',
];
const DATA_PAGES = ['/', '/pricing', '/models/[id]/[[...slug]]'];

type Manifest = {
  staticRoutes?: { page: string; regex: string }[];
  dataRoutes?: { page: string; dataRouteRegex: string }[];
  rewrites?: unknown;
  i18n?: unknown;
};

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    staticRoutes: STATIC_PAGES.map((page) => ({ page, regex: `^${page}(?:/)?$` })),
    dataRoutes: DATA_PAGES.map((page) => ({
      page,
      dataRouteRegex: `^/_next/data/${BUILD_ID}${page}\\.json$`,
    })),
    rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    i18n: { locales: ['en'], defaultLocale: 'en' },
    ...overrides,
  };
}

/**
 * Writes a temp dist dir and re-imports the middleware graph: the parsed manifest and the region
 * configs are module-level, so each test needs fresh modules.
 */
async function loadProxy(
  routes: Manifest | null = manifest(),
  nodeEnv = 'production',
  env: Record<string, string> = {}
) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-manifest-'));
  onTestFinished(() => fs.rmSync(distDir, { recursive: true, force: true }));
  if (routes) {
    fs.writeFileSync(path.join(distDir, 'routes-manifest.json'), JSON.stringify(routes));
  }
  vi.stubEnv('NEXT_DIST_DIR', distDir);
  vi.stubEnv('NODE_ENV', nodeEnv);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.resetModules();
  const { runMiddlewares } = await import('~/server/middleware/index');
  return { runMiddlewares, distDir };
}

function dataRequest(pathname: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { 'x-nextjs-data': '1', ...headers },
  });
}

function isPassthrough(response: Response) {
  return response.status === 200 && response.headers.get('x-middleware-next') === '1';
}

async function expectSkip(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('x-middleware-skip')).toBe('1');
  expect(response.headers.get('x-middleware-next')).toBeNull();
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  expect(response.headers.get('cache-control')).toMatch(/no-store/);
  expect(await response.json()).toEqual({});
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('proxy: client-navigation data requests', () => {
  it.each(['/models', '/search/models', '/images', '/videos'])(
    'answers a data request for %s (no server props) with Next’s empty skip response',
    async (pathname) => {
      const { runMiddlewares } = await loadProxy();
      await expectSkip(await runMiddlewares(dataRequest(pathname)));
    }
  );

  it('passes through a data request from another build, so its 404 still makes that tab reload', async () => {
    const { runMiddlewares } = await loadProxy();
    // What the proxy receives when the build id is not this server's: Next only strips its own.
    const request = new NextRequest('http://localhost/_next/data/older-build/en/models.json', {
      headers: { 'x-nextjs-data': '1' },
      nextConfig: { i18n: { locales: ['en'], defaultLocale: 'en' } },
    });
    expect(request.nextUrl.pathname).toBe('/models');
    expect(isPassthrough(await runMiddlewares(request))).toBe(true);
  });

  it.each(['/', '/pricing'])(
    'passes a data request for %s (has server props) through to render its props',
    async (pathname) => {
      const { runMiddlewares } = await loadProxy();
      expect(isPassthrough(await runMiddlewares(dataRequest(pathname)))).toBe(true);
    }
  );

  it('passes through a dynamic page, an error page, an API route and a path that is no page', async () => {
    const { runMiddlewares } = await loadProxy();
    for (const pathname of ['/models/123/some-slug', '/404', '/api/v1/images', '/no-such-page']) {
      expect(isPassthrough(await runMiddlewares(dataRequest(pathname)))).toBe(true);
    }
  });

  it('passes through a document request for a page with no server props', async () => {
    const { runMiddlewares } = await loadProxy();
    const response = await runMiddlewares(new NextRequest('http://localhost/models'));
    expect(isPassthrough(response)).toBe(true);
  });

  it('still redirects a region-blocked data request instead of skipping it', async () => {
    const { runMiddlewares } = await loadProxy();
    const response = await runMiddlewares(dataRequest('/models', { 'cf-ipcountry': 'GB' }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/region-blocked');
    expect(response.headers.get('x-middleware-skip')).toBeNull();
  });

  it('still redirects a region-restricted data request to the restricted-region domain', async () => {
    const { runMiddlewares } = await loadProxy(manifest(), 'production', {
      REGION_RESTRICTION_CONFIG: 'FR:2025-01-01',
      SERVER_DOMAIN_GREEN: 'green.example',
    });
    const response = await runMiddlewares(dataRequest('/models', { 'cf-ipcountry': 'FR' }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location') ?? '').host).toBe('green.example');
    expect(response.headers.get('x-middleware-skip')).toBeNull();
  });

  it('control: the same data request from an unblocked region is skipped', async () => {
    const { runMiddlewares } = await loadProxy();
    await expectSkip(await runMiddlewares(dataRequest('/models', { 'cf-ipcountry': 'US' })));
  });

  it('is off outside production, where the dist dir holds no current data routes', async () => {
    const { runMiddlewares } = await loadProxy(manifest(), 'development');
    expect(isPassthrough(await runMiddlewares(dataRequest('/models')))).toBe(true);
  });

  it('is off, warning, when the manifest lists no data routes (Next did not compute them)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runMiddlewares } = await loadProxy(manifest({ dataRoutes: [] }));
    expect(isPassthrough(await runMiddlewares(dataRequest('/models')))).toBe(true);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('[next-data-skip]'))).toHaveLength(1);
  });

  it('is off, warning, without i18n, where another build’s data request looks like this one’s', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runMiddlewares } = await loadProxy(manifest({ i18n: undefined }));
    expect(isPassthrough(await runMiddlewares(dataRequest('/models')))).toBe(true);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('[next-data-skip]'))).toHaveLength(1);
  });

  it('is off when a beforeFiles rewrite could send a static path to another page', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runMiddlewares } = await loadProxy(
      manifest({
        rewrites: {
          beforeFiles: [{ source: '/models', destination: '/pricing', regex: '^/models$' }],
          afterFiles: [],
          fallback: [],
        },
      })
    );
    expect(isPassthrough(await runMiddlewares(dataRequest('/models')))).toBe(true);
  });

  it('still skips with an array-form (afterFiles-only) rewrites list', async () => {
    const { runMiddlewares } = await loadProxy(
      manifest({ rewrites: [{ source: '/x', destination: '/y', regex: '^/x$' }] })
    );
    await expectSkip(await runMiddlewares(dataRequest('/models')));
  });

  it('is off, warning once, when the manifest cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runMiddlewares } = await loadProxy(null);
    expect(isPassthrough(await runMiddlewares(dataRequest('/models')))).toBe(true);
    expect(isPassthrough(await runMiddlewares(dataRequest('/images')))).toBe(true);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('[next-data-skip]'))).toHaveLength(1);
  });

  it('reads the manifest once, not per request', async () => {
    const { runMiddlewares, distDir } = await loadProxy();
    const read = vi.spyOn(fs, 'readFileSync');
    await runMiddlewares(dataRequest('/models'));
    await runMiddlewares(dataRequest('/images'));
    await runMiddlewares(dataRequest('/'));
    expect(read.mock.calls.filter(([p]) => String(p).startsWith(distDir))).toHaveLength(1);
  });
});

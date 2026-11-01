import fs from 'fs';
import path from 'path';
import loadCustomRoutes from 'next/dist/lib/load-custom-routes';
import { getContentType } from 'next/dist/server/serve-static';
import { buildCustomRoute } from 'next/dist/server/lib/router-utils/filesystem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routerPathname } from '~/server/middleware/__tests__/next-proxy-matcher';
import { isStaticAssetRuleCacheControl } from '~/server/utils/static-asset-cache';
import { fileHashWorkerUrl } from '~/hooks/useFileHash';

/**
 * The `Cache-Control` each static file in `public/` is served with. Next's default for a public
 * file is `public, max-age=0`, which makes a CDN revalidate it against the origin on every request.
 *
 * Reads the REAL `next.config.mjs` export through Next's own pipeline: `loadCustomRoutes` (which
 * calls `headers()` and adds the `i18n` locale prefix to every source), `buildCustomRoute` (the
 * matcher the router builds from each rule), and the router's locale-prefixed pathname. Every
 * matching rule applies in order and a later `Cache-Control` overwrites an earlier one, as in
 * `resolve-routes.js`. A text scan of the config would pass on a rule that never reaches Next.
 *
 * The values are a wire contract with the CDN and the browser, so they are pinned as literals:
 * the TTLs and why each was chosen are documented beside the rules in
 * `~/shared/constants/static-asset-cache-rules.mjs`.
 */

const SHORT_LIVED = 'public, max-age=60, s-maxage=300, stale-while-revalidate=300';
const LONG_LIVED = 'public, max-age=3600, s-maxage=14400, stale-while-revalidate=3600';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConfig = any;

async function loadConfig(nodeEnv: string) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  const nextConfig = (await import('../../next.config.mjs')).default as AnyConfig;
  const { headers } = await loadCustomRoutes(nextConfig);
  const routes = headers.map((rule) => buildCustomRoute('header', rule));
  return {
    i18n: nextConfig.i18n,
    /** The Cache-Control Next's custom headers give `url`; undefined if no rule sets one. */
    cacheControl(url: string) {
      const pathname = routerPathname(url, { i18n: nextConfig.i18n });
      let value: string | undefined;
      for (const route of routes) {
        if (route.match(pathname) === false) continue;
        for (const header of route.headers) {
          if (header.key.toLowerCase() === 'cache-control') value = header.value;
        }
      }
      return value;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
    );
}

const PUBLIC_IMAGE_URLS = walk(path.join(PUBLIC_DIR, 'images')).map(
  (file) => '/' + path.relative(PUBLIC_DIR, file).split(path.sep).join('/')
);

// Loaded once: `headers()` reads NODE_ENV when `loadCustomRoutes` calls it, inside `loadConfig`.
const prod = await loadConfig('production');
vi.unstubAllEnvs();

describe('static asset Cache-Control in production', () => {
  it('POSITIVE CONTROL: the real config reached Next with i18n and an existing rule', () => {
    // The pre-existing sitemap rule: proves this pipeline sees rules the config already had, so
    // an `undefined` below means "no rule", not "nothing was loaded".
    expect(prod.i18n?.defaultLocale).toBe('en');
    expect(prod.cacheControl('/sitemap.xml')).toBe('public, max-age=86400, must-revalidate');
    expect(PUBLIC_IMAGE_URLS.length).toBeGreaterThan(100);
  });

  it.each([
    '/workers/signals.worker.js',
    '/workers/signals.worker.js?v=2.3-r2',
    '/workers/civitai-link.worker.js',
    '/workers/file-hash.worker.js',
  ])('worker script %s is short-lived', (url) => {
    expect(prod.cacheControl(url)).toBe(SHORT_LIVED);
  });

  it.each([
    '/favicon.ico',
    '/favicon-blue.ico',
    '/favicon-red.ico',
    '/favicon-green.ico',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/site.webmanifest',
    '/images/base-badge.png',
    '/images/android-chrome-192x192.png',
  ])('%s is long-lived', (url) => {
    expect(prod.cacheControl(url)).toBe(LONG_LIVED);
  });

  it('every committed file under public/images is long-lived', () => {
    const missed = PUBLIC_IMAGE_URLS.filter((url) => prod.cacheControl(url) !== LONG_LIVED);
    // A new image extension needs adding to this rule AND to the proxy page pattern.
    expect(missed).toEqual([]);
  });

  // Pages and API routes share prefixes with the files above and must keep their own headers.
  // `/images`, `/images/iterate` and `/images/[imageId]` are PAGES; `/sw.js` is a service worker,
  // which is left on Next's revalidate-every-time default on purpose.
  it.each([
    '/',
    '/images',
    '/images/123',
    '/images/123?postId=4',
    '/images/iterate',
    '/models/123/v1.5',
    '/workers',
    '/favicon-blue',
    '/api/v1/images',
    '/api/trpc/image.getInfinite',
    '/api/page-data/images/123',
    '/sw.js',
  ])('%s gets no static-asset Cache-Control', (url) => {
    expect(prod.cacheControl(url)).toBeUndefined();
  });
});

/**
 * `_app` recognises a page render that Next gave a static-asset rule header by its VALUE, so each
 * value must be unique to those rules: a page, API route or sitemap that set an identical value
 * would be privatised, and one rule value reused elsewhere would make that code path look like a
 * rule hit. Walks every first-party source file outside tests for the exact strings; only the rules
 * module may hold them. A value built at runtime from parts is outside what this can see.
 */
describe('static-asset rule values are unique to the rules', () => {
  const ROOT = path.resolve(__dirname, '../..');
  const RULES_MODULE = 'src/shared/constants/static-asset-cache-rules.mjs';
  const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
  const SKIP_DIR = new Set(['node_modules', '.next', '__tests__', 'dist', '.git']);

  function sources(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return SKIP_DIR.has(entry.name) ? [] : sources(full);
      return SOURCE.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name) ? [full] : [];
    });
  }

  const files = [
    ...['src', 'scripts', 'apps', 'packages'].flatMap((d) => sources(path.join(ROOT, d))),
    path.join(ROOT, 'next.config.mjs'),
  ];

  it('POSITIVE CONTROL: the walk sees the rules module and many sources', () => {
    expect(files.length).toBeGreaterThan(1000);
    expect(files.map((f) => path.relative(ROOT, f))).toContain(RULES_MODULE);
  });

  it.each([SHORT_LIVED, LONG_LIVED])('only the rules module contains %j', (value) => {
    const holders = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes(value))
      .map((file) => path.relative(ROOT, file));
    expect(holders).toEqual([RULES_MODULE]);
  });

  it.each([
    [SHORT_LIVED, true],
    [LONG_LIVED, true],
    ['PUBLIC,max-age=3600,  s-maxage=14400, stale-while-revalidate=3600', true],
    ['public, max-age=86400, must-revalidate', false],
    ['public, max-age=3600, s-maxage=14400', false],
    ['private, no-cache, no-store, max-age=0, must-revalidate', false],
    [undefined, false],
  ])('isStaticAssetRuleCacheControl(%j) is %s', (value, expected) => {
    expect(isStaticAssetRuleCacheControl(value)).toBe(expected);
  });
});

describe('the file-hash worker URL', () => {
  afterEach(() => {
    delete (globalThis as { __NEXT_DATA__?: unknown }).__NEXT_DATA__;
  });

  it("carries the page's build id, so a page never runs another build's cached script", () => {
    (globalThis as { __NEXT_DATA__?: unknown }).__NEXT_DATA__ = { buildId: 'build 7' };
    expect(fileHashWorkerUrl()).toBe('/workers/file-hash.worker.js?v=build%207');
  });

  it('falls back to the bare path when there is no build id', () => {
    expect(fileHashWorkerUrl()).toBe('/workers/file-hash.worker.js');
  });
});

describe('static asset Cache-Control outside production', () => {
  it('is not applied under next dev, so a rebuilt worker is picked up at once', async () => {
    const dev = await loadConfig('development');
    expect(dev.cacheControl('/workers/signals.worker.js')).toBeUndefined();
    expect(dev.cacheControl('/favicon.ico')).toBeUndefined();
    // Same pipeline, same run: the pre-existing rule is still seen.
    expect(dev.cacheControl('/sitemap.xml')).toBe('public, max-age=86400, must-revalidate');
  });
});

// Invariant guard, not a regression test: Next already serves `.webmanifest` with the manifest
// MIME type (its bundled `send` mime table), which is why the config sets no Content-Type for it.
it('Next serves .webmanifest as application/manifest+json', () => {
  expect(getContentType('webmanifest')).toBe('application/manifest+json');
});

import fs from 'fs';
import path from 'path';
import loadCustomRoutes from 'next/dist/lib/load-custom-routes';
import { getContentType } from 'next/dist/server/serve-static';
import { buildCustomRoute } from 'next/dist/server/lib/router-utils/filesystem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routerPathname } from '~/server/middleware/__tests__/next-proxy-matcher';
import { isStaticAssetRulePath } from '~/server/utils/static-asset-cache';
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
 * `_app` decides which page renders to make private with its OWN compile of the same rule list
 * (`isStaticAssetRulePath`), so the two matchers must agree: one that matched less than Next would
 * leave a page render on a rule path public. Checked on every fixture above plus case and locale
 * variants, against Next's own compiled routes.
 */
describe("_app's rule matcher agrees with Next's", () => {
  const STATIC_VALUES = new Set([SHORT_LIVED, LONG_LIVED]);
  it.each([
    '/workers/signals.worker.js?v=2.3',
    '/workers/file-hash.worker.js',
    '/WORKERS/FILE-HASH.WORKER.JS',
    '/workers/a/b.js',
    '/favicon.ico',
    '/favicon-red.ico',
    '/FAVICON-RED.ICO',
    '/favicon-x.png',
    '/apple-touch-icon.png',
    '/site.webmanifest',
    '/images/base-badge.png',
    '/images/BASE-BADGE.PNG',
    '/images/no-such-file.png',
    '/images/creators/x.webp',
    '/en/images/base-badge.png',
    '/images',
    '/images/123',
    '/images/iterate',
    '/models/123/v1.5',
    '/sitemap.xml',
    '/sw.js',
    '/api/v1/images',
    '/',
  ])('%s', (url) => {
    const next = STATIC_VALUES.has(prod.cacheControl(url) ?? '');
    expect(isStaticAssetRulePath(url, ['en'])).toBe(next);
  });

  it('POSITIVE CONTROL: the fixtures include both answers', () => {
    expect(isStaticAssetRulePath('/images/BASE-BADGE.PNG', ['en'])).toBe(true);
    expect(isStaticAssetRulePath('/images/123', ['en'])).toBe(false);
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

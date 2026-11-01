import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { config } from '~/proxy';
import {
  matchingSources,
  NO_I18N,
  PRODUCTION,
  type NextConfigSubset,
} from '~/server/middleware/__tests__/next-proxy-matcher';

/**
 * The static files every page load requests from `public/` must not run the proxy: no middleware
 * does anything for them (see the comment on the page pattern in `src/proxy.ts`), so each run was
 * pure per-request overhead. Every page, `/api/*` route and `/_next/data/*` request must still run
 * it — above all the image PAGES, which share the `/images` prefix with the static image files:
 * `/images`, `/images/iterate` and `/images/[imageId]`.
 *
 * Read through Next's own matcher compiler (`next-proxy-matcher.ts`), not by re-implementing the
 * regex, and under both the production (`i18n`) and a no-`i18n` config.
 */

// The page pattern, pinned whole: the trpc matcher test finds it by prefix, so this is the one place
// a change to it shows up as a diff to review.
const PAGE_PATTERN =
  '/((?!api|_next|favicon.ico|region-blocked|fonts|sounds|robots.txt|site.webmanifest|workers/|favicon-[a-z]+\\.ico$|apple-touch-icon[^/]*\\.png$|images/.+\\.(?:png|jpe?g|gif|svg|webp|ico)$).*)';

const PUBLIC_DIR = path.resolve(__dirname, '../../../../public');

function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
    );
}

/** Every committed file under `public/images`, as the URL a browser requests it at. */
const PUBLIC_IMAGE_URLS = walk(path.join(PUBLIC_DIR, 'images')).map(
  (file) => '/' + path.relative(PUBLIC_DIR, file).split(path.sep).join('/')
);

// `public/workers/` is generated at build time (gitignored), so its files are listed by name.
const STATIC_URLS = [
  '/workers/signals.worker.js',
  '/workers/signals.worker.js?v=2.3-r1',
  '/workers/civitai-link.worker.js',
  '/workers/file-hash.worker.js',
  '/favicon.ico',
  '/favicon-blue.ico',
  '/favicon-red.ico',
  '/favicon-green.ico',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/site.webmanifest',
  '/images/base-badge.png',
  '/images/civitai-default-account-bg.png',
  '/images/android-chrome-192x192.png',
];

// Paths that must still run the proxy (pages, or paths a page could take). Chosen to tell an over-broad exclusion apart: `/images/123`
// and `/images/iterate` die to an `images` prefix exclusion, `/models/123/v1.5` to an "anything
// with an extension" rule, and `/workers-guide` to an unslashed `workers` prefix.
const PROXIED_URLS = [
  '/',
  '/images',
  '/images/123',
  '/images/123?postId=4',
  '/images/iterate',
  '/models/123/v1.5',
  '/user/someone',
  '/workers-guide',
  '/favicon-blue',
];

const API_URLS = ['/api/v1/images', '/api/v1/models?limit=1', '/api/page-data/images/123'];

const dataUrls = (nextConfig: NextConfigSubset) => {
  const locale = nextConfig.i18n ? `/${nextConfig.i18n.defaultLocale}` : '';
  return [
    `/_next/data/BUILD_ID${locale}/images/123.json`,
    `/_next/data/BUILD_ID${locale}/models/123/slug.json`,
    `/_next/data/BUILD_ID${locale}/index.json`,
  ];
};

it('the page pattern is the one this file pins', () => {
  expect(config.matcher).toContain(PAGE_PATTERN);
});

it('POSITIVE CONTROL: the public/images walk found the files', () => {
  // Without this, an empty walk would pass the "every image file" case below vacuously.
  expect(PUBLIC_IMAGE_URLS.length).toBeGreaterThan(100);
  expect(PUBLIC_IMAGE_URLS).toContain('/images/base-badge.png');
  expect(PUBLIC_IMAGE_URLS.some((url) => url.startsWith('/images/creators/'))).toBe(true);
});

describe.each([
  ['production config (i18n)', PRODUCTION],
  ['no i18n', NO_I18N],
])('proxy matcher, %s', (_, nextConfig) => {
  it.each(STATIC_URLS)('does not run for %s', (url) => {
    expect(matchingSources(config.matcher, url, nextConfig)).toEqual([]);
  });

  it('does not run for any committed file under public/images', () => {
    const matched = PUBLIC_IMAGE_URLS.filter(
      (url) => matchingSources(config.matcher, url, nextConfig).length > 0
    );
    // A new image extension needs adding to the page pattern AND to the cache rule in
    // next.config.mjs.
    expect(matched).toEqual([]);
  });

  // Non-empty, not "via PAGE_PATTERN": a mutated pattern is a different string, so naming it here
  // would fail every case for the wrong reason and hide which paths the mutant actually drops.
  it.each(PROXIED_URLS)('still runs for %s', (url) => {
    expect(matchingSources(config.matcher, url, nextConfig)).not.toEqual([]);
  });

  it.each(API_URLS)('still runs for %s', (url) => {
    expect(matchingSources(config.matcher, url, nextConfig)).not.toEqual([]);
  });

  it.each(dataUrls(nextConfig))('still runs for the data request %s', (url) => {
    expect(matchingSources(config.matcher, url, nextConfig)).not.toEqual([]);
  });

  // Negative controls on the instrument: the over-broad matchers this file exists to stop are seen.
  it('would catch an `images` prefix exclusion swallowing the image pages', () => {
    const broad = PAGE_PATTERN.replace('images/.+\\.(?:png|jpe?g|gif|svg|webp|ico)$', 'images');
    const matcher = config.matcher.map((source) => (source === PAGE_PATTERN ? broad : source));
    expect(matchingSources(matcher, '/images/123', nextConfig)).toEqual([]);
  });

  it('would catch an `/images/:path*` entry putting the static images back', () => {
    const matcher = [...config.matcher, '/images/:path*'];
    expect(matchingSources(matcher, '/images/base-badge.png', nextConfig)).toEqual([
      '/images/:path*',
    ]);
  });
});

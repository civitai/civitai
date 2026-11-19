import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { config } from '~/proxy';
import {
  matchingSources,
  NO_I18N,
  PRODUCTION,
} from '~/server/middleware/__tests__/next-proxy-matcher';

/**
 * The standalone tRPC server (`scripts/trpc-server/server.cjs`) calls route modules directly and
 * never runs the proxy (`src/proxy.ts`). So every page it serves must be one Next does not run the
 * proxy for either — or, for the `api` profile's `/api/v1/` pages, one where the server applies the
 * proxy's API policy itself (`standalone-api-policy.test.ts` pins that the policy IS the proxy's
 * whole effect there). Otherwise the same request gets the proxy's work (region block, bot
 * handling, cache headers, …) under Next and not there, and nothing in either server would say so.
 *
 * This pins that relationship for the WHOLE served list of each profile
 * (`scripts/trpc-server/served-pages.cjs`), so it fails when a page that the proxy covers is added
 * to a list, and when the proxy matcher grows to cover a page that is already on one. Paths are
 * tested with the real matcher, compiled by Next's own compiler, the way Next's router tests them
 * (see `proxy-trpc-matcher.test.ts`).
 */

const require = createRequire(import.meta.url);
const served = require('../../../../scripts/trpc-server/served-pages.cjs') as {
  TRPC_PAGES: string[];
  API_PROFILE_PREFIXES: string[];
  needsApiPolicy: (page: string) => boolean;
  servedPages: (profile: string, manifest: Record<string, string>) => string[];
};
const SERVED_PAGES: string[] = served.TRPC_PAGES;

/** A request path for each served page; a dynamic page needs a concrete one. */
const EXAMPLE_PATHS: Record<string, string[]> = {
  '/api/trpc/[trpc]': ['/api/trpc/model.getById', '/api/trpc/a,b?batch=1'],
  '/api/internal/image-delivery/[id]': ['/api/internal/image-delivery/abc'],
  '/api/internal/ping': ['/api/internal/ping'],
  '/api/internal/pulse': ['/api/internal/pulse'],
  '/api/track/batch': ['/api/track/batch'],
  '/api/live': ['/api/live?token=x'],
  '/api/health': ['/api/health'],
  '/api/ready': ['/api/ready'],
  '/api/readyz': ['/api/readyz'],
  '/api/metrics': ['/api/metrics'],
};

it('has an example path for every served page, and no others', () => {
  expect(Object.keys(EXAMPLE_PATHS).sort()).toEqual([...SERVED_PAGES].sort());
});

describe.each([
  ['production config (i18n)', PRODUCTION],
  ['no i18n', NO_I18N],
])('proxy matcher, %s', (_, nextConfig) => {
  const cases = SERVED_PAGES.flatMap((page) =>
    (EXAMPLE_PATHS[page] ?? []).map((path) => [page, path])
  );

  it.each(cases)('does not run on %s (%s)', (_page, path) => {
    expect(matchingSources(config.matcher, path, nextConfig)).toEqual([]);
  });

  // Negative control: the instrument sees a proxy entry that WOULD cover a served beacon, so the
  // empty results above are not a matcher that matches nothing.
  it.each([
    ['/api/internal/ping', '/api/internal/:path*'],
    ['/api/track/batch', '/api/track/:path*'],
    ['/api/internal/pulse', '/api/:path*'],
  ])('would catch an entry covering %s (%s)', (path, entry) => {
    expect(matchingSources([...config.matcher, entry], path, nextConfig)).toContain(entry);
  });
});

// --- the `api` profile ---------------------------------------------------------------------------

/**
 * The pages-API routes under the `api` profile's prefixes, read from `src/pages` the way Next names
 * them (`index` dropped, extension dropped). The server reads the BUILD's pages-manifest instead;
 * the parity job is what runs against that.
 */
const PAGES_DIR = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  '../../../pages'
);
function pagesUnder(prefix: string): string[] {
  const dir = nodePath.join(PAGES_DIR, prefix);
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = nodePath.join(d, name);
      if (statSync(full).isDirectory()) {
        if (name === '__tests__') continue;
        walk(full);
      } else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
        const rel = nodePath
          .relative(PAGES_DIR, full)
          .replace(/\.tsx?$/, '')
          .split(nodePath.sep)
          .join('/');
        out.push('/' + rel.replace(/\/index$/, ''));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** A concrete request path for a page: one segment per param, two for a catch-all, none for an optional one. */
function examplePath(page: string): string {
  return page
    .replace(/\/\[\[\.\.\.[^\]]+\]\]/g, '')
    .replace(/\[\.\.\.[^\]]+\]/g, 'a/b')
    .replace(/\[[^\]]+\]/g, '123');
}

const API_FAMILY_PAGES = served.API_PROFILE_PREFIXES.flatMap((prefix) => pagesUnder(prefix));

describe('the api profile', () => {
  it('finds the route families it serves (positive control for the walk)', () => {
    expect(API_FAMILY_PAGES).toContain('/api/v1/models/[id]');
    // /api/auth/ stays on Next: not part of the api profile.
    expect(API_FAMILY_PAGES).not.toContain('/api/auth/session');
    expect(API_FAMILY_PAGES.length).toBeGreaterThan(50);
  });

  it('serves the tRPC list plus every page under its prefixes, and nothing else', () => {
    const manifest: Record<string, string> = {};
    for (const page of [
      ...API_FAMILY_PAGES,
      '/api/testing/x',
      '/api/page-data/images/[imageId]',
      '/api/webhooks/stripe',
      '/api/v1x/nope',
      '/models/[id]',
    ])
      manifest[page] = 'x.js';
    for (const page of served.TRPC_PAGES) manifest[page] = 'x.js';
    expect(served.servedPages('api', manifest)).toEqual([
      ...served.TRPC_PAGES,
      ...[...API_FAMILY_PAGES].sort(),
    ]);
    expect(served.servedPages('trpc', manifest)).toEqual(served.TRPC_PAGES);
  });

  describe.each([
    ['production config (i18n)', PRODUCTION],
    ['no i18n', NO_I18N],
  ])('proxy matcher, %s', (_, nextConfig) => {
    // Every page the proxy runs on must be one the server applies the policy to, and the proxy entry
    // that covers it must be the API one alone: a page-pattern match would mean page middlewares
    // (region redirects, bot cache, …) that the policy does not reproduce.
    it.each(API_FAMILY_PAGES.map((page) => [page, examplePath(page)]))(
      '%s (%s) is covered only where the server applies the policy',
      (page, url) => {
        const sources = matchingSources(config.matcher, url, nextConfig);
        if (served.needsApiPolicy(page)) expect(sources).toEqual(['/api/v1/:path*']);
        else expect(sources).toEqual([]);
      }
    );
  });
});

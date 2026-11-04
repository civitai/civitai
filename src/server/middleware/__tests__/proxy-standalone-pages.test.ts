import { createRequire } from 'node:module';
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
 * proxy for either; otherwise the same request gets the proxy's work (region block, bot handling,
 * cache headers, …) under Next and not there, and nothing in either server would say so.
 *
 * This pins that relationship for the WHOLE served list (`scripts/trpc-server/served-pages.cjs`),
 * so it fails when a page that the proxy covers is added to the list, and when the proxy matcher
 * grows to cover a page that is already on it. Paths are tested with the real matcher, compiled by
 * Next's own compiler, the way Next's router tests them (see `proxy-trpc-matcher.test.ts`).
 */

const require = createRequire(import.meta.url);
const SERVED_PAGES: string[] = require('../../../../scripts/trpc-server/served-pages.cjs');

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

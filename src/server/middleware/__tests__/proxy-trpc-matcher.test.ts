import { describe, expect, it } from 'vitest';
import { config } from '~/proxy';
import {
  getMiddlewareMatchers,
  matchingSources,
  NO_I18N,
  PRODUCTION,
} from '~/server/middleware/__tests__/next-proxy-matcher';

/**
 * Next must never invoke the proxy for `/api/trpc/*`: the tRPC route applies the API policy itself
 * (`applyApiRequestPolicy`, pinned by `trpc-route-api-policy.test.ts`), so a proxy run there is pure
 * per-call overhead. Next decides by testing the request path against the regexes it compiles from
 * `config.matcher`, so this compiles the REAL matcher with Next's OWN compiler
 * (`getMiddlewareMatchers`, what the build writes into the middleware manifest) and tests paths the
 * way Next's router does (`resolve-routes.js`): the default locale is prefixed first when `i18n` is
 * configured, and both the raw and the URI-decoded pathname are tried.
 *
 * The locale prefix is not a detail. With `i18n` on, Next prepends `/:nextInternalLocale(...)` to
 * every matcher source, so the broad page pattern `/((?!api|...).*)` compiled with `i18n` DOES match
 * an unprefixed `/api/trpc/x` (the locale group eats `api`). Next never tests that form, because it
 * adds `/en` first; a check that skipped that step would fail for the wrong reason. Both configs are
 * checked, so the guard holds whether or not `i18n` stays in `next.config.mjs`.
 */

// The broad page pattern; its exact text is pinned by `proxy-static-asset-matcher.test.ts`.
const PAGE_PATTERN = config.matcher.find((source) => source.startsWith('/((?!')) ?? '(missing)';

const TRPC_URLS = [
  '/api/trpc/model.getById',
  '/api/trpc/a,b?batch=1',
  '/api/trpc/model.getById?input=%7B%22json%22%3A%7B%22id%22%3A1%7D%7D',
  '/api/trpc/image.getInfinite,model.getAll?batch=1&input=%7B%7D',
];

it("Next's matcher compiler is importable from where this test expects it", () => {
  expect(typeof getMiddlewareMatchers).toBe('function');
  expect(config.matcher.length).toBeGreaterThan(0);
});

describe.each([
  ['production config (i18n)', PRODUCTION],
  ['no i18n', NO_I18N],
])('proxy matcher, %s', (_, nextConfig) => {
  it.each(TRPC_URLS)('does not match %s', (url) => {
    expect(matchingSources(config.matcher, url, nextConfig)).toEqual([]);
  });

  // Positive controls: the same instrument DOES see a match where the proxy must still run, so the
  // empty results above are not an instrument that matches nothing.
  it.each([
    ['/api/v1/images', '/api/v1/:path*'],
    ['/api/page-data/images/123', '/api/page-data/:path*'],
    ['/api/testing/x', '/api/testing/:path*'],
    ['/models/123/slug', PAGE_PATTERN],
  ])('still matches %s (via %s)', (url, source) => {
    expect(config.matcher).toContain(source);
    expect(matchingSources(config.matcher, url, nextConfig)).toContain(source);
  });

  // Negative control on the guard itself: a matcher that still lists tRPC is caught, as is a broad
  // `/api/:path*` entry. Without these, the empty arrays above could be a check that never matches.
  it.each(['/api/trpc/:path*', '/api/:path*'])('would catch %s being added back', (entry) => {
    for (const url of TRPC_URLS) {
      expect(matchingSources([...config.matcher, entry], url, nextConfig)).toContain(entry);
    }
  });
});

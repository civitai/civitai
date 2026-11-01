import * as pageStaticInfo from 'next/dist/build/analysis/get-page-static-info';
import { normalizeLocalePath } from 'next/dist/shared/lib/i18n/normalize-locale-path';
import { addPathPrefix } from 'next/dist/shared/lib/router/utils/add-path-prefix';

/**
 * How Next decides whether a request runs the proxy, reproduced with Next's OWN pieces so tests can
 * ask the question of the real `config.matcher`.
 *
 * Next compiles `config.matcher` with `getMiddlewareMatchers` (what the build writes into the
 * middleware manifest) and tests the request path the way its router does (`resolve-routes.js`):
 * the default locale is prefixed first when `i18n` is configured (except under `/_next/`), and both
 * the raw and the URI-decoded pathname are tried. The locale prefix matters: with `i18n` on, Next
 * prepends `/:nextInternalLocale(...)` to every matcher source, so a test that skipped that step
 * would read a different regex position than production does.
 */

type CompiledMatcher = { regexp: string; originalSource: string };
type I18n = { locales: string[]; defaultLocale: string };
export type NextConfigSubset = { i18n?: I18n; basePath?: string };

// Not in Next's published types, so typed here. `getMiddlewareMatchers` being a function is
// asserted by `proxy-trpc-matcher.test.ts`, so a move upstream fails loudly.
export const { getMiddlewareMatchers } = pageStaticInfo as unknown as {
  getMiddlewareMatchers: (matchers: string[], nextConfig: NextConfigSubset) => CompiledMatcher[];
};

// next.config.mjs: `i18n: { locales: ['en'], defaultLocale: 'en' }`, no basePath.
export const PRODUCTION: NextConfigSubset = { i18n: { locales: ['en'], defaultLocale: 'en' } };
export const NO_I18N: NextConfigSubset = {};

/** The pathname Next's router tests routes against, for a request URL (path + query). */
export function routerPathname(url: string, nextConfig: NextConfigSubset) {
  let pathname = new URL(url, 'http://localhost').pathname;
  const { i18n } = nextConfig;
  if (i18n) {
    const result = normalizeLocalePath(pathname, i18n.locales);
    if (!result.detectedLocale && !result.pathname.startsWith('/_next/')) {
      pathname =
        result.pathname === '/'
          ? `/${i18n.defaultLocale}`
          : addPathPrefix(result.pathname, `/${i18n.defaultLocale}`);
    }
  }
  return pathname;
}

/** The matcher sources that make Next invoke the proxy for `url`. Empty: the proxy does not run. */
export function matchingSources(matcher: string[], url: string, nextConfig: NextConfigSubset) {
  const pathname = routerPathname(url, nextConfig);
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    /* Next tries the raw form only, too */
  }
  return getMiddlewareMatchers(matcher, nextConfig)
    .filter(({ regexp }) => new RegExp(regexp).test(pathname) || new RegExp(regexp).test(decoded))
    .map(({ originalSource }) => originalSource);
}

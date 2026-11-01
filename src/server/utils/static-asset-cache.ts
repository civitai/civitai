import type { ServerResponse } from 'http';
import { pathToRegexp } from 'path-to-regexp';
import {
  STATIC_ASSET_CACHE_RULES,
  STATIC_ASSET_MISS_CACHE_CONTROL,
} from '~/shared/constants/static-asset-cache-rules.mjs';

// The same compile options Next's router uses for a custom header source (`getPathMatch` in
// `next/dist/shared/lib/router/utils/path-match`): case-insensitive, strict, `/` delimiter.
const RULE_REGEXPS = STATIC_ASSET_CACHE_RULES.map(({ source }) =>
  pathToRegexp(source, [], { sensitive: false, strict: true, delimiter: '/' })
);

// `/_next/data/<buildId>/<path>.json` — the client-navigation form of a page request.
const NEXT_DATA_URL = /^\/_next\/data\/[^/]+(\/.*?)?\.json$/i;

/**
 * Whether a `next.config.mjs` static-asset `Cache-Control` rule applies to `url` (path + query), as
 * Next decides it. `_app` only sees the RAW request url, while Next matches the header rules
 * against the normalised page path, so both normalisations Next applies first are applied here:
 * - a data request `/_next/data/<id>/images/a.png.json` is matched as `/images/a.png` (Next's
 *   data normaliser runs before header matching, measured on 16.4.3 with this app's proxy, and
 *   `_app`'s `ctx.req.url` keeps the raw form);
 * - with `i18n`, Next matches each source under a locale prefix, so a leading `/<locale>` segment
 *   is tried with and without.
 */
export function isStaticAssetRulePath(url: string, locales: readonly string[] = []) {
  let pathname = url.split('?')[0].split('#')[0] || '/';
  const data = NEXT_DATA_URL.exec(pathname);
  if (data) pathname = !data[1] || data[1] === '/index' ? '/' : data[1];
  const candidates = [pathname];
  for (const locale of locales) {
    const prefix = `/${locale.toLowerCase()}/`;
    if (pathname.toLowerCase().startsWith(prefix))
      candidates.push(pathname.slice(prefix.length - 1));
  }
  return candidates.some((candidate) => RULE_REGEXPS.some((re) => re.test(candidate)));
}

/**
 * A PAGE render on a static-asset rule path is never the file (Next serves real files before any
 * page), so it must not leave with the rule's public `Cache-Control`: it carries per-viewer `_app`
 * props and cookies. Called first thing in `_app.getInitialProps`, which Next runs before the page's
 * `getServerSideProps` and again for the `/404` and `/_error` it renders on the same response, so
 * the private value is in place whether the page renders, 404s, throws or redirects.
 */
export function privatizeStaticAssetPageRender(
  url: string | undefined,
  res: ServerResponse | undefined,
  locales: readonly string[] = []
) {
  if (!url || !res || res.headersSent) return;
  if (!isStaticAssetRulePath(url, locales)) return;
  res.setHeader('Cache-Control', STATIC_ASSET_MISS_CACHE_CONTROL);
}

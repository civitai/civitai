import type { ServerResponse } from 'http';
import {
  STATIC_ASSET_CACHE_RULES,
  STATIC_ASSET_MISS_CACHE_CONTROL,
} from '~/shared/constants/static-asset-cache-rules.mjs';

const normalise = (value: string) =>
  value
    .split(',')
    .map((directive) => directive.trim().toLowerCase())
    .filter(Boolean)
    .join(', ');

const RULE_VALUES = new Set(
  STATIC_ASSET_CACHE_RULES.map(({ cacheControl }) => normalise(cacheControl))
);

/**
 * Whether `value` is exactly one of the static-asset rules' `Cache-Control` values. A multi-value
 * header (an array) is joined with `', '`, as Node joins it on the wire, then compared the same
 * way. Anything else (a number, `undefined`) is not a rule value.
 */
export function isStaticAssetRuleCacheControl(value: unknown) {
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value) && value.every((part) => typeof part === 'string')
      ? value.join(', ')
      : null;
  return text !== null && RULE_VALUES.has(normalise(text));
}

/**
 * A PAGE render whose response already carries a static-asset rule's `Cache-Control` is never the
 * file (Next serves real files before any page): Next set the header from a `next.config.mjs` rule
 * before it knew no file would answer, and the page carries per-viewer `_app` props and cookies.
 *
 * Decided by the header VALUE, not by re-deriving the path: Next has already matched the rule
 * against its own normalised path (data URLs, `/index/`, locales, case), and the header is on the
 * response before `_app` runs. The values are unique to those rules — `static-asset-cache-headers`
 * pins that no other code sets one — so nothing else is touched.
 *
 * Called first thing in `_app.getInitialProps`, which Next runs before the page's
 * `getServerSideProps` and again for the `/404` and `/_error` it renders on the same response, so
 * the private value is in place whether the page renders, 404s, throws or redirects.
 */
export function privatizeStaticAssetPageRender(res: ServerResponse | undefined) {
  if (!res || res.headersSent) return;
  if (!isStaticAssetRuleCacheControl(res.getHeader('Cache-Control'))) return;
  res.setHeader('Cache-Control', STATIC_ASSET_MISS_CACHE_CONTROL);
}

import { hasAppsStoreQueryParams } from '~/components/Apps/appsStoreQueryParams';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { APPS_STORE_HREF } from '~/shared/constants/apps-routes.constants';
import type { AppsStoreFeatureFlags } from '~/shared/utils/app-blocks-access';
import { buildPassthroughQuery } from '~/utils/query-string-helpers';

export type AppsHomeAccessResult =
  | { notFound: true }
  | { redirect: { destination: string; permanent: false } }
  | { props: Record<string, never> };

type RouteQuery = Record<string, string | string[] | undefined>;

/**
 * The `/apps` SSR decision. `/apps` is the signed-in viewer's app home; the marketplace
 * moved to `/apps/store`.
 *
 *   1. The store gate FIRST, and it is the page's own gate (`resolveAppsPageAccess`), so a
 *      viewer the store refuses gets `notFound` — never a redirect that reveals the
 *      surface exists.
 *   2. A request carrying any store filter param is an old store link (`/apps?category=…`,
 *      shared before the move). It goes to `/apps/store` with its WHOLE query string, so
 *      the filters and anything else on it (`utm_*`, `ref`) survive.
 *   3. A signed-out viewer has no apps of their own, so the store is their landing too.
 *   4. Otherwise render the home.
 *
 * Both redirects are temporary: the store's address may still move, and a permanent
 * redirect is cached by browsers past any later change.
 */
export function resolveAppsHomeAccess(args: {
  features?: AppsStoreFeatureFlags;
  user?: { id?: number } | null;
  query?: RouteQuery;
}): AppsHomeAccessResult {
  const access = resolveAppsPageAccess({ features: args.features });
  if ('notFound' in access) return access;
  const query = args.query ?? {};
  if (hasAppsStoreQueryParams(query) || !args.user) {
    return {
      // `[]`: nothing is excluded — the WHOLE query moves to the store.
      redirect: {
        destination: `${APPS_STORE_HREF}${buildPassthroughQuery(query, [])}`,
        permanent: false,
      },
    };
  }
  return { props: {} };
}

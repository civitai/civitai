/**
 * The `/apps/activity` tab set, as DATA plus the pure `?tab=` resolver.
 *
 * 🔴 THE TABS ARE URL-BACKED, AND THEY WERE NOT BEFORE. The page used to render
 * `<Tabs defaultValue="subscriptions">` — uncontrolled, no query state — while
 * `isActiveAppsRoute`'s own comment claimed `/apps/installed?tab=…` existed. It did
 * not: a deep link silently landed on the default tab, and "the page opens on Recent
 * activity" was untestable because nothing observable carried the selection.
 *
 * Extracted here (pure, React-free, no Mantine/tRPC) so the resolution rules run in
 * the node-env `unit` project rather than only in the report-only browser tier. Same
 * precedent as `resolveAppsPageAccess.ts` / `appsStoreQueryParams.ts`.
 */

/**
 * Every tab the page can render, in RENDER ORDER.
 *
 * 🔴 `activity` LEADS, and that is the rename made real rather than a cosmetic
 * reorder: the route is called `/apps/activity`, so the feed is what it must open on.
 */
export const ACTIVITY_TAB_VALUES = ['activity', 'subscriptions', 'permissions', 'hidden'] as const;

export type ActivityTab = (typeof ACTIVITY_TAB_VALUES)[number];

/** The tab a bare `/apps/activity` opens on. */
export const DEFAULT_ACTIVITY_TAB: ActivityTab = 'activity';

/** The query-string key the selection round-trips through. */
export const ACTIVITY_TAB_QUERY_KEY = 'tab';

export function isActivityTab(value: unknown): value is ActivityTab {
  return typeof value === 'string' && (ACTIVITY_TAB_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve the tab to render from the raw `router.query.tab` value.
 *
 * `raw` is deliberately `unknown`: Next hands back `string | string[] | undefined`
 * (repeat the key and you get an array), and a component that assumed `string` would
 * put an array into `Tabs.value` and render no active tab at all. The array case takes
 * the FIRST entry, which is what every other query reader in this area does.
 *
 * 🔴 A TAB THE VIEWER CANNOT SEE FALLS BACK TO THE DEFAULT, IT DOES NOT RENDER EMPTY.
 * `Installs` is gated on `features.appBlocks` (the slot flag), so
 * `/apps/activity?tab=subscriptions` is a link a page-only viewer can legitimately
 * receive — from a teammate, a bookmark taken before a flag moved, or their own
 * history. Handing that value to `Tabs.value` selects a tab that is not in the list
 * and Mantine renders a bar with nothing active over an empty panel: a blank page with
 * no error. Falling back is the only outcome that is a page.
 */
export function resolveActivityTab(raw: unknown, opts: { canSeeInstalls: boolean }): ActivityTab {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!isActivityTab(first)) return DEFAULT_ACTIVITY_TAB;
  if (first === 'subscriptions' && !opts.canSeeInstalls) return DEFAULT_ACTIVITY_TAB;
  return first;
}

/** Next's `ParsedUrlQuery` shape, named so the helper below can round-trip it. */
export type ActivityRouteQuery = Record<string, string | string[] | undefined>;

/**
 * The `query` object for a tab selection, given the route's CURRENT query.
 *
 * 🔴 THE DEFAULT TAB DROPS THE KEY RATHER THAN WRITING `?tab=activity`. The canonical
 * URL for the page's own default is the bare route — otherwise every arrival that
 * touches a tab and comes back leaves a redundant parameter in the address bar and in
 * anything that copies it. Other keys on the route are preserved untouched: this
 * function owns ONE key, and a spread that dropped the rest would silently discard
 * whatever a future filter puts there.
 */
export function activityTabQuery(
  tab: ActivityTab,
  // Typed concretely rather than as `Record<string, unknown>` so the result drops
  // straight into `router.replace`'s `ParsedUrlQueryInput` without a cast — an `unknown`
  // value is not assignable there, and casting at the call site is how a wrong shape
  // gets in.
  currentQuery: ActivityRouteQuery = {}
): ActivityRouteQuery {
  const next = { ...currentQuery };
  if (tab === DEFAULT_ACTIVITY_TAB) delete next[ACTIVITY_TAB_QUERY_KEY];
  else next[ACTIVITY_TAB_QUERY_KEY] = tab;
  return next;
}

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
 * The tabs whose CONTENT is governed by the `appBlocks` SLOT flag, and which the page
 * therefore renders only for a viewer who holds it.
 *
 * 🔴 A LEDGER, NOT AN ACCUMULATION OF BOOLEANS. Both of these tabs are about SLOT
 * INSTALLS — `subscriptions` lists them, `hidden` lists the ones the viewer has hidden
 * from their model pages — so they share ONE predicate rather than one flag each. That
 * is what lets {@link resolveActivityTab} take a single `canSeeInstallOnlyTabs` and
 * stay correct as the set grows: add a tab here and its `?tab=` fallback comes with it.
 *
 * 🔴 `permissions` IS DELIBERATELY NOT HERE, AND THAT IS A DECISION, NOT AN OVERSIGHT.
 * Scope grants are a consent/audit surface: a full-page app (`appBlocksPages`) invokes
 * scopes with no install row at all, so a viewer holding only the page flag has grants
 * to read and revoke and no `subscriptions` row to reach them through. Gating it on the
 * slot flag would hide the record of access from exactly the people whose access it
 * records. Do not "tidy" the two into one uniform predicate.
 */
export const INSTALL_GATED_ACTIVITY_TABS = [
  'subscriptions',
  'hidden',
] as const satisfies readonly ActivityTab[];

/**
 * What the viewer's sight of the gated tabs turns on — the `appBlocks` slot flag.
 *
 * ONE field, not one per tab: the rule is "can this viewer see the install-only tabs",
 * and spelling it per-tab is how the resolver drifted out of step with the page.
 */
export type ActivityTabVisibility = { canSeeInstallOnlyTabs: boolean };

/** Whether `tab` renders for a viewer with the given visibility. */
export function isActivityTabVisible(tab: ActivityTab, opts: ActivityTabVisibility): boolean {
  if (opts.canSeeInstallOnlyTabs) return true;
  return !(INSTALL_GATED_ACTIVITY_TABS as readonly ActivityTab[]).includes(tab);
}

/**
 * The tabs the page renders for this viewer, in render order.
 *
 * 🔴 THE MINIMUM IS 2, AND THAT IS WHY THERE IS NO `< 2` COLLAPSE HERE. `AppsSubNav`
 * hides its bar when fewer than two rows survive its gates; this bar has no such
 * branch because it cannot reach that state — `activity` and `permissions` are BOTH
 * ungated, and the page itself 404s (`canAccessAppsActivity`) for anyone who holds
 * neither runtime flag, so every viewer who can load the page sees at least those two.
 * A collapse would be a branch that can never execute, which reads as coverage while
 * providing none. `appsActivityTabs.test.ts` pins the floor at 2: if a later change
 * gates `permissions`, that test goes red and the collapse becomes real work.
 */
export function visibleActivityTabs(opts: ActivityTabVisibility): readonly ActivityTab[] {
  return ACTIVITY_TAB_VALUES.filter((tab) => isActivityTabVisible(tab, opts));
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
 * `Installs` and `Hidden` are gated on `features.appBlocks` (the slot flag), so
 * `/apps/activity?tab=subscriptions` and `?tab=hidden` are links a page-only viewer can
 * legitimately receive — from a teammate, a bookmark taken before a flag moved, or their
 * own history. Handing that value to `Tabs.value` selects a tab that is not in the list
 * and Mantine renders a bar with nothing active over an empty panel: a blank page with
 * no error. Falling back is the only outcome that is a page.
 *
 * 🔴 THE FALLBACK IS DERIVED FROM THE VISIBILITY PREDICATE, NEVER FROM A TAB NAME
 * SPELLED HERE. It used to test `first === 'subscriptions'` — a check that stayed green
 * while `hidden` was gated and shipped exactly the blank page above.
 */
export function resolveActivityTab(raw: unknown, opts: ActivityTabVisibility): ActivityTab {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!isActivityTab(first)) return DEFAULT_ACTIVITY_TAB;
  if (!isActivityTabVisible(first, opts)) return DEFAULT_ACTIVITY_TAB;
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

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
 * The tabs whose CONTENT the `appBlocks` SLOT flag governs, and which the page therefore
 * renders only for a viewer who holds it.
 *
 * 🔴 A LEDGER, NOT AN ACCUMULATION OF BOOLEANS. Every tab here shares ONE predicate
 * rather than carrying one flag each, which is what lets {@link resolveActivityTab} take
 * a single `canSeeSlotGatedTabs` and stay correct as the set grows: add a tab here and
 * both its `?tab=` fallback and its place in {@link visibleActivityTabs} come with it.
 *
 * 🔴 EACH ENTRY IS HERE BECAUSE ITS OWN DATA SOURCE IS GATED ON THE SAME FLAG — the tab's
 * predicate is its content's gate restated, never a separate policy:
 *   · `subscriptions` and `hidden` are SLOT-INSTALL surfaces. `subscriptions` lists
 *     `block_user_subscriptions` rows; `hidden` lists the ones the viewer has hidden from
 *     their model pages. Slot installs are `appBlocks`-gated, so without it there are none.
 *   · `permissions` reads `blocks.listMyScopeGrants` and NOTHING else — one `useQuery`
 *     with no `enabled:`. That procedure runs `enforceAppBlocksFlag`, which evaluates the
 *     `app-blocks-enabled` Flipt key (exactly `features.appBlocks`) and short-circuits to
 *     `[]` for anyone without it. So the panel rendered "No apps installed or subscribed
 *     yet." for every slotless viewer, ALWAYS — there was no cohort for whom the ungated
 *     tab showed anything. Gating it loses nothing that was ever displayed, and it closes
 *     the #3899 / #4668 class: a tab offered whose own gate refuses its content.
 *
 * 🔴 `permissions` USED TO BE EXCLUDED ON THE PREMISE THAT A PAGE-FLAG-ONLY VIEWER HAS
 * GRANTS TO READ. That premise is false at the data layer (above), and it was ALREADY
 * retracted one file over: `AppsSubNav.tsx` records that such a viewer cannot run a
 * full-page app at all (`/apps/run/[slug]/[[...path]].tsx` requires BOTH flags) and cannot
 * install, so they generate no scope invocations to have grants FROM. Do not reinstate it.
 */
export const SLOT_GATED_ACTIVITY_TABS = [
  'subscriptions',
  'permissions',
  'hidden',
] as const satisfies readonly ActivityTab[];

/**
 * What the viewer's sight of the gated tabs turns on — the `appBlocks` slot flag.
 *
 * ONE field, not one per tab: the rule is "can this viewer see the slot-gated tabs",
 * and spelling it per-tab is how the resolver drifted out of step with the page.
 */
export type ActivityTabVisibility = { canSeeSlotGatedTabs: boolean };

/** Whether `tab` renders for a viewer with the given visibility. */
export function isActivityTabVisible(tab: ActivityTab, opts: ActivityTabVisibility): boolean {
  if (opts.canSeeSlotGatedTabs) return true;
  return !(SLOT_GATED_ACTIVITY_TABS as readonly ActivityTab[]).includes(tab);
}

/**
 * The tabs the page renders for this viewer, in render order.
 *
 * 🔴 THE MINIMUM IS 1, AND THE PAGE COLLAPSES ITS BAR THERE. `activity` is the only
 * ungated tab, so a viewer without the slot flag gets exactly `['activity']` — and
 * `activity.tsx` hides its `Tabs.List` below two visible tabs, mirroring `AppsSubNav`'s
 * `links.length < 2` behaviour. A one-tab bar is chrome that offers no choice.
 *
 * 🔴 THIS IS THE PAGE'S ONLY SOURCE FOR WHICH TABS TO RENDER. `activity.tsx` maps over
 * this result instead of hand-spelling a `&&` per tab, so the ledger above cannot
 * disagree with the bar: the four hand-spelled guards it replaced were invisible to the
 * node-env `unit` project, and deleting one of them left this suite fully green.
 */
export function visibleActivityTabs(opts: ActivityTabVisibility): readonly ActivityTab[] {
  return ACTIVITY_TAB_VALUES.filter((tab) => isActivityTabVisible(tab, opts));
}

/**
 * The visible LABEL for each tab, kept here rather than inline in the page so the render
 * loop has no per-tab branch left and the `unit` project can pin the strings. Icons stay
 * in `activity.tsx` — they are React, and this module is deliberately React-free.
 */
export const ACTIVITY_TAB_LABELS: Record<ActivityTab, string> = {
  activity: 'Recent activity',
  subscriptions: 'Installs',
  permissions: 'Apps & permissions',
  hidden: 'Hidden',
};

/**
 * Resolve the tab to render from the raw `router.query.tab` value.
 *
 * `raw` is deliberately `unknown`: Next hands back `string | string[] | undefined`
 * (repeat the key and you get an array), and a component that assumed `string` would
 * put an array into `Tabs.value` and render no active tab at all. The array case takes
 * the FIRST entry, which is what every other query reader in this area does.
 *
 * 🔴 A TAB THE VIEWER CANNOT SEE FALLS BACK TO THE DEFAULT, IT DOES NOT RENDER EMPTY.
 * `Installs`, `Apps & permissions` and `Hidden` are gated on `features.appBlocks` (the
 * slot flag), so `?tab=subscriptions`, `?tab=permissions` and `?tab=hidden` are all links
 * a page-only viewer can legitimately receive — from a teammate, a bookmark taken before a
 * flag moved, or their own history. Handing that value to `Tabs.value` selects a tab that
 * is not in the list
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

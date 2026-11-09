import { parseReportHash } from '~/components/Apps/agentReviewReport';

/**
 * The per-submission review PAGE's tab set (`/apps/review/<publishRequestId>`), as DATA
 * plus the pure `?tab=` resolver.
 *
 * 🔴 URL-BACKED, BECAUSE THAT IS THE PAGE'S WHOLE REASON FOR EXISTING. The page module's
 * own docstring calls it "deep-linkable, refresh-survivable" — the property it was built
 * to have over the queue modal. Tabs held in local state would regress exactly that: a
 * mod who shares "look at the permissions on this one" would send a link that opens
 * somewhere else, and a refresh mid-review would silently lose the section.
 *
 * Pure, React-free and Mantine-free (same precedent as `appsActivityTabs.ts` /
 * `appListingEditorTabs.ts`) so the resolution rules run in the node-env `unit` project
 * rather than only in the browser tier.
 */

/**
 * Every tab the page renders, in RENDER ORDER.
 *
 * 🔴 `overview` LEADS AND IS THE DEFAULT. It composes the decision signals a moderator needs
 * for most submissions on ONE screen — the agentic review's finding counts, the requested permissions
 * with their justifications, the running app and its store art — so a routine approve needs no
 * tab at all. The other tabs are the evidence behind each signal, in the order a moderator
 * digs: the code, then the permissions in full, the manifest, the AI report, the preview.
 *
 * (`permissions` led before this; it is still one click away and still deep-linkable as
 * `?tab=permissions`. The reason it led — scopes and their justifications were buried at the
 * bottom of the old single scroll — is now served by the Overview's permission summary.)
 */
export const REVIEW_DETAIL_TAB_VALUES = [
  'overview',
  'code',
  'permissions',
  'manifest',
  'agent',
  'preview',
] as const;

export type ReviewDetailTab = (typeof REVIEW_DETAIL_TAB_VALUES)[number];

/** The tab a bare `/apps/review/<id>` opens on. */
export const DEFAULT_REVIEW_DETAIL_TAB: ReviewDetailTab = 'overview';

/** The query-string key the selection round-trips through. */
export const REVIEW_DETAIL_TAB_QUERY_KEY = 'tab';

/**
 * The visible LABEL for each tab. Kept here rather than inline in the view so the
 * node-env `unit` project can pin the strings and the render loop has no per-tab branch
 * left. Icons stay in the view — they are React, and this module is deliberately
 * React-free.
 */
export const REVIEW_DETAIL_TAB_LABELS: Record<ReviewDetailTab, string> = {
  overview: 'Overview',
  code: 'Code',
  permissions: 'Permissions',
  manifest: 'Manifest',
  agent: 'AI report',
  preview: 'Preview',
};

export function isReviewDetailTab(value: unknown): value is ReviewDetailTab {
  return (
    typeof value === 'string' && (REVIEW_DETAIL_TAB_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Resolve the tab to render from the raw `router.query.tab` value (and, as a fallback,
 * the URL hash).
 *
 * `raw` is deliberately `unknown`: Next hands back `string | string[] | undefined` (repeat
 * the key and you get an array), and a component that assumed `string` would put an array
 * into `Tabs.value` and render a bar with NO active tab over an empty panel. The array
 * case takes the FIRST entry, matching every other query reader in this area.
 *
 * 🔴 AN UNKNOWN OR ABSENT `?tab=` FALLS BACK TO THE DEFAULT, IT NEVER RENDERS AN EMPTY
 * PANEL. `?tab=summary` (a tab that was never here), `?tab=` and `?tab=a&tab=b` are all
 * links a mod can legitimately receive — from a teammate, a bookmark, their own history.
 *
 * 🔴 THE `hash` ARGUMENT EXISTS TO KEEP THE EXISTING PER-FINDING DEEP LINKS WORKING, and
 * without it this redesign would have silently broken them. `ReportTabs` already ships a
 * copy-link affordance that produces `…/apps/review/<id>#finding-security-2`, and it
 * selects its OWN inner tab from that hash. Once the agent report moved behind a tab that
 * is not the default, such a link landed on the default tab and the finding it names was not
 * on screen at all. So a hash that `parseReportHash` recognises — a bare `#scopes` /
 * `#security` / `#code`, or a `#finding-<tab>-<n>` anchor — resolves the OUTER tab to
 * `agent`. An explicit `?tab=` always wins: it is the more specific instruction, and it
 * is what a mod who deliberately shared a tab link sent.
 */
export function resolveReviewDetailTab(
  raw: unknown,
  opts: { hash?: string } = {}
): ReviewDetailTab {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (isReviewDetailTab(first)) return first;
  const hash = opts.hash;
  if (typeof hash === 'string' && parseReportHash(hash).tab) return 'agent';
  return DEFAULT_REVIEW_DETAIL_TAB;
}

/** Next's `ParsedUrlQuery` shape, named so the helper below can round-trip it. */
export type ReviewDetailRouteQuery = Record<string, string | string[] | undefined>;

/**
 * The `query` object for a tab selection, given the route's CURRENT query.
 *
 * 🔴 THE DEFAULT TAB DROPS THE KEY RATHER THAN WRITING `?tab=overview`. The canonical
 * URL for the page's own default is the bare route; otherwise every arrival that touches a
 * tab and comes back leaves a redundant parameter in the address bar and in anything that
 * copies it.
 *
 * 🔴 `publishRequestId` AND EVERY OTHER KEY SURVIVE UNTOUCHED, and on this route that is
 * not merely tidy — it is required. The route is dynamic (`/apps/review/[publishRequestId]`),
 * so Next interpolates the path FROM the query; a spread that dropped it would produce a
 * `router.replace` to a path with a literal `[publishRequestId]` segment. This function
 * owns exactly ONE key.
 */
export function reviewDetailTabQuery(
  tab: ReviewDetailTab,
  // Typed concretely rather than as `Record<string, unknown>` so the result drops straight
  // into `router.replace`'s `ParsedUrlQueryInput` without a cast — an `unknown` value is
  // not assignable there, and casting at the call site is how a wrong shape gets in.
  currentQuery: ReviewDetailRouteQuery = {}
): ReviewDetailRouteQuery {
  const next = { ...currentQuery };
  if (tab === DEFAULT_REVIEW_DETAIL_TAB) delete next[REVIEW_DETAIL_TAB_QUERY_KEY];
  else next[REVIEW_DETAIL_TAB_QUERY_KEY] = tab;
  return next;
}

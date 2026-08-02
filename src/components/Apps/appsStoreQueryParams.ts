import * as z from 'zod';
import {
  listingKindFilterSchema,
  listingSortSchema,
  type ListingKindFilter,
  type ListingSort,
} from '~/server/schema/blocks/app-listing-read.schema';
import {
  MARKETPLACE_CATEGORIES,
  type MarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';

/**
 * `/apps` store URL STATE — the zod schema + the pure parse/serialise/count
 * helpers behind `?kind=…&category=…&sort=…&query=…`.
 *
 * Why the store's filters live in the URL at all: they were `useState`, so
 * `/apps` filtered to "off-site · Generation · newest" was un-shareable, lost on
 * reload, and lost on Back after opening an app. Mirrors the `/models` pattern —
 * a zod schema over `router.query`, read through `useZodRouteParams` (see
 * `useAppsStoreQueryParams.ts`, and `useModelQueryParams2` for the precedent).
 *
 * REACT-FREE ON PURPOSE. CI does not run the browser-mode (`component`) suites
 * at all, so the parse/serialise decisions that decide whether a shared link
 * works have to be coverable by the node `unit` project — same split as
 * `appListingCardView` / `recentAppsRail` / `appListingGrid`.
 *
 * 🔴 EVERY FIELD DEGRADES INDEPENDENTLY (`.catch(...)` per field, not one
 * `safeParse` over the whole object). `useModelQueryParams` takes the other
 * route — one `safeParse`, and ANY bad field drops the WHOLE object to `{}` —
 * which for a 4-field store means `?kind=onsite&sort=bogus` silently discards
 * the valid `kind` too. Per-field `.catch()` means a hand-typed, stale, or
 * bot-crawled param can never do worse than fall back to that ONE field's
 * default, and can never throw. There is no "invalid filter" error state and no
 * empty grid: an unknown `category=hats` renders the same page as no category
 * at all.
 *
 * 🔴 HYDRATION. Everything here is a pure function of `router.query`. No
 * `window`, no `localStorage`, no `Date`, no feature flag — so the server render
 * and the first client paint are identical BY CONSTRUCTION, which is the actual
 * invariant behind the `/apps` hydration incident documented in `AppsSubNav.tsx`
 * (a first-client-paint divergence bailed hydration of the whole `/apps` root
 * and left every page inert). Do not reach for a client-only source in here; the
 * regression test `AppListingsMarketplaceBody.hydration.browser.test.tsx` mounts
 * the body pre- and post-mount with params seeded and asserts they match.
 */

/** The store's default filter/sort state — what a bare `/apps` renders. */
export const APPS_STORE_DEFAULTS = {
  kind: 'all',
  category: null,
  sort: 'top-rated',
  query: '',
} as const satisfies AppsStoreFilters;

export type AppsStoreFilters = {
  kind: ListingKindFilter;
  category: MarketplaceCategory | null;
  sort: ListingSort;
  /** The free-text search box. Client-side over loaded pages — see the body. */
  query: string;
};

/**
 * The raw URL shape. Every field is optional (a bare `/apps` has none of them)
 * and carries `.catch(undefined)` so an invalid value is indistinguishable from
 * an absent one — see the 🔴 note above.
 *
 * `z.string()` on a `router.query` value can also receive `string[]` (Next parses
 * a repeated `?kind=a&kind=b` into an array); the `.catch()` turns that into the
 * default rather than a crash.
 */
export const appsStoreQuerySchema = z
  .object({
    kind: listingKindFilterSchema.optional().catch(undefined),
    category: z.enum(MARKETPLACE_CATEGORIES).optional().catch(undefined),
    sort: listingSortSchema.optional().catch(undefined),
    query: z.string().optional().catch(undefined),
  })
  // 🔴 LOOSE, not the zod default of stripping unknown keys. `useZodRouteParams`
  // REBUILDS the whole query string from `schema.parse({...router.query, ...patch})`
  // on every write, so a stripping schema would silently delete every OTHER param
  // on the URL the first time a viewer touched a filter — `?utm_source=…`,
  // `?ref=…`, anything a campaign or a partner link carried in. Keeping them is
  // free; the resolver below reads only the four fields it knows.
  .loose();

export type AppsStoreQueryParams = z.infer<typeof appsStoreQuerySchema>;

/**
 * Resolve the parsed (partial, possibly-degraded) URL params into the COMPLETE
 * filter state the store renders from. Total: always returns a valid state.
 */
export function resolveAppsStoreFilters(params: AppsStoreQueryParams): AppsStoreFilters {
  return {
    kind: params.kind ?? APPS_STORE_DEFAULTS.kind,
    category: params.category ?? APPS_STORE_DEFAULTS.category,
    sort: params.sort ?? APPS_STORE_DEFAULTS.sort,
    query: params.query?.trim() ? params.query : APPS_STORE_DEFAULTS.query,
  };
}

/** Parse an arbitrary `router.query` straight into the resolved filter state. */
export function parseAppsStoreFilters(query: unknown): AppsStoreFilters {
  // `.catch()` on every field makes this total, but `safeParse` is still the
  // right call: a non-object input (never produced by Next, but this is exported)
  // fails at the OBJECT level, where no field-level `.catch()` can rescue it.
  const result = appsStoreQuerySchema.safeParse(query);
  return resolveAppsStoreFilters(result.success ? result.data : {});
}

/**
 * The shape written back to the URL. Each field keeps its NARROW literal type
 * (rather than `string`) so it satisfies `useZodRouteParams`' `z.input<>`
 * parameter — a `Record<…, string | undefined>` compiles here but is rejected at
 * the call site, and widening it there would need a cast that could hide a real
 * mismatch. `undefined` means "drop this param" (see below).
 */
export type AppsStoreQueryPatch = {
  kind?: ListingKindFilter | undefined;
  category?: MarketplaceCategory | undefined;
  sort?: ListingSort | undefined;
  query?: string | undefined;
};

/**
 * The URL patch for a filter change: a value equal to its DEFAULT serialises to
 * `undefined`, which `removeEmpty` (in `useZodRouteParams`) strips from the
 * query string.
 *
 * Why not just write every value: `/apps` is the entry point in the sub-nav, and
 * a nav that lands you on `/apps?kind=all&category=&sort=top-rated&query=` looks
 * like state you have to clear even though it is the default view. Only
 * NON-default filters appear, so a shared link carries exactly the filters the
 * sharer had applied and a cleared store returns to a bare `/apps`.
 */
export function appsStoreFiltersToQuery(filters: Partial<AppsStoreFilters>): AppsStoreQueryPatch {
  const out: AppsStoreQueryPatch = {};
  if ('kind' in filters)
    out.kind = filters.kind && filters.kind !== APPS_STORE_DEFAULTS.kind ? filters.kind : undefined;
  if ('category' in filters) out.category = filters.category ?? undefined;
  if ('sort' in filters)
    out.sort = filters.sort && filters.sort !== APPS_STORE_DEFAULTS.sort ? filters.sort : undefined;
  if ('query' in filters) out.query = filters.query?.trim() ? filters.query : undefined;
  return out;
}

/**
 * The count rendered on the Filters button's `Indicator`.
 *
 * 🔴 COUNTS ONLY WHAT IS INSIDE THE DROPDOWN — kind and category, max 2. Search
 * and sort stay INLINE in the control row, so a badge that counted them would
 * point at a panel that does not contain them: you would open the dropdown to
 * find the "2" and see one active filter. Sort is also never "off" (it always
 * has a value), so counting it would pin the badge at >= 1 forever.
 */
export function countActiveAppsStoreFilters(
  filters: Pick<AppsStoreFilters, 'kind' | 'category'>
): number {
  return (
    (filters.kind !== APPS_STORE_DEFAULTS.kind ? 1 : 0) +
    (filters.category !== APPS_STORE_DEFAULTS.category ? 1 : 0)
  );
}

/**
 * Whether the EMPTY STATE should offer "Clear filters" — the broader notion,
 * because a viewer staring at "No apps match" cannot tell which control caused
 * it and the search box is the most likely culprit.
 *
 * Deliberately NOT the same predicate as {@link countActiveAppsStoreFilters}:
 * the badge describes the dropdown's contents, this describes "you have narrowed
 * the results somehow". The two are kept as separate named functions so the
 * difference is a decision rather than a bug someone later "fixes" by unifying
 * them.
 */
export function hasActiveAppsStoreFilters(
  filters: Pick<AppsStoreFilters, 'kind' | 'category' | 'query'>
): boolean {
  return countActiveAppsStoreFilters(filters) > 0 || filters.query.trim().length > 0;
}

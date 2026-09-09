import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';
import { trpc } from '~/utils/trpc';

/**
 * THE app-block host chrome's one and only read of `appListings.getAppDetail`.
 *
 * 🔴 IT EXISTS TO MAKE "ONE LISTING, ONE REQUEST" STRUCTURAL RATHER THAN HOPEFUL.
 * Two separate surfaces in one bar now need the same listing row: F2's app-name
 * crumb popover (full name + recommend rollup + "View in App Store") and F4's
 * review entry points (the listing `id` to review, plus the `creator`/`kind` the
 * eligibility gate reads). React Query dedupes by KEY, so two call sites are one
 * network request only while their inputs serialise identically — and "identically"
 * is a property of two pieces of code that nothing checks. A second call site
 * written as `useQuery({ slug }, { retry: false, enabled: true })`, or one that
 * passes `{ slug, kind: undefined }`, or one that simply forgets `retry: false`,
 * still compiles, still renders, still looks right, and doubles the chrome's
 * traffic on a surface that renders on every model page carrying a block.
 *
 * So there is exactly ONE call site, here, and both surfaces reach the query
 * through it. The key cannot drift because there is nothing to drift from.
 * `__tests__/chromeListingQueryIsSingleSourced.test.ts` pins that: it fails if a
 * second `getAppDetail.useQuery(` appears anywhere in the chrome's sources.
 *
 * 🔴 CALL IT LAZILY — it carries NO `enabled` flag on purpose. Both callers mount
 * it inside a floating surface Mantine does not render until the user opens it
 * (`Popover.Dropdown` / `Menu.Dropdown`, neither `keepMounted`), so a closed chrome
 * issues no request at all. That is the same structural-laziness decision F2 made
 * when it moved the query out of `AppNameCrumb` and into `AppNameCrumbCard`; an
 * `enabled` flag would move the rule back into something a caller can get wrong.
 *
 * `retry: false` matches `/apps/store-preview/<slug>`'s own call: a listing that is
 * missing, unapproved or scope-gated 404s server-side and should settle into an
 * unavailable state rather than being retried.
 */
export function useChromeListingDetail(slug: string): {
  detail: ListingDetail | undefined;
  isLoading: boolean;
  error: unknown;
} {
  const { data, isLoading, error } = trpc.appListings.getAppDetail.useQuery(
    { slug },
    { retry: false }
  );
  return { detail: data as ListingDetail | undefined, isLoading, error };
}

import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { AppListingsMarketplaceBody } from '~/components/Apps/AppListingsMarketplaceBody';
import { buildAppsStoreFeedbackContext } from '~/components/Apps/appsStoreFeedbackContext';
import { parseAppsStoreFilters } from '~/components/Apps/appsStoreQueryParams';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { FeedbackPrompt } from '~/components/Feedback/FeedbackPrompt';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  // GATING INVARIANT (F-E E1): the flag gate is the ONLY access control; no
  // session→login redirect, so the marketplace renders for a session-less
  // request BEHIND the flag (dark today; lit when the segment widens). See
  // resolveAppsPageAccess for the full invariant + `deIndex` note.
  resolver: async ({ features }) => resolveAppsPageAccess({ features }),
});

export default function AppsPage() {
  const features = useFeatureFlags();
  const router = useRouter();

  // The store's filter/sort/search state, read straight off the URL. The controls
  // themselves live inside `AppListingsMarketplaceBody`, but they WRITE the query
  // string (`useAppsStoreQueryParams`), so the URL is the shared source both this
  // prompt and that body resolve through the same `parseAppsStoreFilters` — no
  // lifted state, no second copy of the defaults, and a report therefore names the
  // view the reporter was actually looking at.
  //
  // ⚠️ One known lag: the search box only echoes into the URL after its 300ms
  // debounce, so a report submitted mid-keystroke carries the previous term. The
  // grid the reporter is looking at is filtered by that same debounced value, so
  // this matches what they see rather than what they have typed.
  const storeFilters = parseAppsStoreFilters(router.query);

  // W13 (PR-W1a/D8): store-visibility gate = dedicated `appListings` OR-falling-
  // back to `appBlocks`. The SHARED predicate, so this body and the SSR
  // `resolveAppsPageAccess` gate above are literally the same rule.
  if (!hasAppsStoreAccess(features)) return <NotFound />;

  return (
    <>
      <Meta title="Apps — Civitai" description="Civitai Apps marketplace" deIndex />
      {/* Outer chrome (Container + sticky sub-nav) is supplied by AppsPageLayout;
          the marketplace title/subtitle were removed for the page-apps-only
          launch (the sub-nav supplies the wayfinding), so no header props.

          W13 P2d CUTOVER: the default `/apps` store now reads the unified
          `AppListing` record (both on-site App Blocks AND off-site OAuth apps)
          via `AppListingsMarketplaceBody` (the P2a `appListings.listAvailable`
          read path). Still dark/mod-only — the page gate is UNCHANGED
          (`resolveAppsPageAccess` → the shared `hasAppsStoreAccess` predicate,
          i.e. `appListings || appBlocks`, both mod-segmented in Flipt today;
          `deIndex`), this only swaps WHICH grid renders.

          ROLLBACK = one-line revert: the legacy AppBlock path
          (`MarketplaceBody` → `AppBlockCard`) is intentionally retained in the
          tree; swap this back to `<MarketplaceBody />` (re-import it) to fall
          back to the AppBlock-backed grid.
          ⚠️ That rollback is now PARTIAL: `AppBlockCard`'s title/description link
          to `/apps/<appBlockId>`, which is retired and redirects to the store
          detail. Restoring the old grid therefore no longer restores the old
          detail surface — undo the route retirement too if that is the intent.
          ⚠️ It is also partial in a second way now: the legacy grid's 5-star
          rating chip, its "Top rated" sort option and the whole `AppBlockReview`
          system behind them were removed. `blocks.listAvailable` now defaults to
          `popular` and exposes no rating at all, so the rollback restores the
          old grid WITHOUT the old ranking.

          The grid will be EMPTY until the mod-only backfills run on prod
          (`blocks.backfillAppListings` → `appListings.backfillListingAssets`,
          a separate post-deploy op step) — the empty state renders sanely
          ("No apps yet"); expected + fine while dark. */}
      <AppsPageLayout>
        {/* FEEDBACK PROMPT — above the store controls, mirroring where the images
            feed mounts it (above the grid rather than after it).

            It costs no vertical space in the ordinary case: `FeedbackPrompt`
            returns null unless the viewer is signed in, has not dismissed it this
            tab, AND `feedback-area-apps-marketplace` resolves on for them — so for
            everyone outside the segment the page is byte-identical to before and
            nothing is pushed down. For a viewer inside it, the prompt is one
            collapsed line above the search/sort row; the grid stays in view.

            `active` is deliberately UNCONDITIONAL: this prompt asks about the
            marketplace page as a whole, so there is no backend-specific condition
            to gate on and inventing one would only make the surface silently
            dark. The Flipt flag is the rollout control. */}
        <FeedbackPrompt
          area="apps-marketplace"
          active
          notice="Apps are new here. If something's missing or looks off, tell us."
          placeholder="What were you trying to do? Missing apps, broken listings, confusing pages, anything."
          // The view the report is ABOUT — kind/category/sort/search, all read back
          // out of the URL. Built by a named function (not inline) because the
          // search term has to be CLIPPED to the context schema's per-value bound
          // and that clip needs to be reachable by a test; see that file.
          context={buildAppsStoreFeedbackContext({
            filters: storeFilters,
            path: typeof window !== 'undefined' ? window.location.pathname : undefined,
          })}
        />
        {/* Widened past the default `xl` (1320px) token. The width is UNCHANGED by
            the larger-cover pass — the store now runs a 4-across grid at `xl` (see
            `LISTING_GRID_SPAN`), and the container/grid pair is pinned together in
            `appListingGrid.ts` so neither can drift alone. */}
        <AppListingsMarketplaceBody />
      </AppsPageLayout>
    </>
  );
}

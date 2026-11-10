import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsFeedbackNotice } from '~/components/Apps/AppsFeedbackNotice';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { AppListingsMarketplaceBody } from '~/components/Apps/AppListingsMarketplaceBody';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';

/**
 * `/apps/store` — the marketplace, "where you go to get new apps". It was `/apps` until the
 * signed-in app home took that address; this page is that page moved, with the same gate,
 * the same SSR and the same URL state (`appsStoreQueryParams`; the writer keeps whatever
 * pathname it is on, so filters now write `/apps/store?…`). `/apps` redirects old store
 * links here with their query (`resolveAppsHomeAccess`).
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  // GATING INVARIANT (F-E E1): the flag gate is the ONLY access control; no
  // session→login redirect, so the marketplace renders for a session-less
  // request BEHIND the flag. See resolveAppsPageAccess for the full invariant
  // (including who the flags reach) + the `deIndex` note.
  resolver: async ({ features }) => resolveAppsPageAccess({ features }),
});

export default function AppsStorePage() {
  const features = useFeatureFlags();

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

          The store reads the unified `AppListing` record (both on-site App Blocks
          AND off-site OAuth apps) via `AppListingsMarketplaceBody` (the
          `appListings.listAvailable` read path). The page gate is the shared
          `hasAppsStoreAccess` predicate (via `resolveAppsPageAccess`, which owns
          the who-can-see-it invariant); `deIndex` stays on.

          The grid will be EMPTY until the mod-only backfills run on prod
          (`blocks.backfillAppListings` → `appListings.backfillListingAssets`,
          a separate post-deploy op step) — the empty state renders sanely
          ("No apps yet"). */}
      <AppsPageLayout railFooter={({ collapsed }) => <AppsFeedbackNotice collapsed={collapsed} />}>
        {/* The container is `APPS_PAGE_CONTAINER_WIDTH` (2560), applied by
            `AppsPageLayout` — not by anything on this page. This route takes no body
            `measure`, so its content width IS the container width, which is what makes
            the store's column arithmetic true.
            The store spends that width as an explicit column ladder driven by a
            container query (`LISTING_GRID_COLUMN_STEPS`): 1/2/3/4 exactly where the
            retired Mantine breakpoints put them (736 / 960 / 1168px of grid), then 5
            from 2364 and 6 from 2840, both from the 460px card-width floor. On a 2560
            monitor, net of a 10px scrollbar and the 32px gutter, the three rail states
            land as FOUR columns at 548.5px with the left rail OPEN, FIVE at 476.4px
            COLLAPSED, and FIVE at 490.8px with NO RAIL. The sixth column is declared and
            unreachable at this cap in every rail state.

            ⚠️ A LEFT-RAIL RE-TUNE BRIEFLY CHANGED THIS AND IS REVERTED. It made `lg`/`xl`
            mean three columns and moved four to 2242 of grid, so that an OPEN rail still
            reached four — but the ladder keys on grid WIDTH and cannot tell WHY the grid
            is narrow, so no-rail, below-1300 and collapsed viewers paid a column they had
            the width for. Two earlier revisions of this paragraph described that ladder
            (one of them also conflating the no-rail 620px figure with the collapsed
            state); both are superseded by the numbers above. Container
            and ladder are pinned together in `appListingGrid.ts` and its test so neither
            can drift alone. */}
        <AppListingsMarketplaceBody />
      </AppsPageLayout>
    </>
  );
}

import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { AppListingsMarketplaceBody } from '~/components/Apps/AppListingsMarketplaceBody';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

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

  if (!features.appBlocks) return <NotFound />;

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
          (`resolveAppsPageAccess` → `features.appBlocks` Flipt mod segment,
          `deIndex`), this only swaps WHICH grid renders.

          ROLLBACK = one-line revert: the legacy AppBlock path
          (`MarketplaceBody` → `AppBlockCard`) is intentionally retained in the
          tree; swap this back to `<MarketplaceBody />` (re-import it) to fall
          back to the AppBlock-backed grid.

          The grid will be EMPTY until the mod-only backfills run on prod
          (`blocks.backfillAppListings` → `appListings.backfillListingAssets`,
          a separate post-deploy op step) — the empty state renders sanely
          ("No apps yet"); expected + fine while dark. */}
      <AppsPageLayout size="xl">
        <AppListingsMarketplaceBody />
      </AppsPageLayout>
    </>
  );
}

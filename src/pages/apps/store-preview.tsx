import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { AppListingsMarketplaceBody } from '~/components/Apps/AppListingsMarketplaceBody';
import { resolveAppsPageAccess } from '~/components/Apps/resolveAppsPageAccess';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * App Store Listings (W13) — P2b DARK preview mount.
 *
 * A dedicated preview route that renders the NEW unified `AppListing`-backed
 * store (`AppListingsMarketplaceBody`) ALONGSIDE the live `/apps` surface. The
 * default `/apps` render (MarketplaceBody → AppBlockCard, off the AppBlock path)
 * is byte-unchanged — `pages/apps/index.tsx` is not touched. The default-swap /
 * cutover is a later PR (P2d).
 *
 * Gating: reuses `resolveAppsPageAccess` — the SAME mod-segmented `appBlocks`
 * flag gate as `/apps` (the flag's Flipt segment is mod-only today, so this is
 * mod-only dark). `deIndex` stays on so the preview is never crawlable.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => resolveAppsPageAccess({ features }),
});

export default function AppsStorePreviewPage() {
  const features = useFeatureFlags();

  if (!features.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title="App store preview — Civitai" description="Unified app store preview" deIndex />
      <AppsPageLayout size="xl">
        <AppListingsMarketplaceBody />
      </AppsPageLayout>
    </>
  );
}

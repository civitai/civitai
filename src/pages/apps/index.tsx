import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { MarketplaceBody } from '~/components/Apps/MarketplaceBody';
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
          launch (the sub-nav supplies the wayfinding), so no header props. The
          marketplace controls + grid live in MarketplaceBody (extracted so it's
          component-testable without this page's server-side import chain). */}
      <AppsPageLayout size="xl">
        <MarketplaceBody />
      </AppsPageLayout>
    </>
  );
}

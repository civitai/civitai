import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsFeedbackNotice } from '~/components/Apps/AppsFeedbackNotice';
import { AppsHomeBody } from '~/components/Apps/AppsHomeBody';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { resolveAppsHomeAccess } from '~/components/Apps/resolveAppsHomeAccess';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { hasAppsStoreAccess } from '~/shared/utils/app-blocks-access';

/**
 * `/apps` — the signed-in viewer's app HOME ("My apps"). The marketplace that used to live
 * here is `/apps/store`.
 *
 * `resolveAppsHomeAccess` decides, in order: the store gate (`notFound` for a viewer the
 * store refuses, exactly as before), then a redirect to `/apps/store` — query preserved —
 * for an old store link carrying filter params or for a signed-out viewer, else the home.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) =>
    resolveAppsHomeAccess({ features, user: session?.user, query: ctx.query }),
});

export default function AppsHomePage() {
  const features = useFeatureFlags();

  // The same store-visibility predicate as the SSR gate above (via `resolveAppsPageAccess`),
  // so the body and the gate are literally the same rule.
  if (!hasAppsStoreAccess(features)) return <NotFound />;

  return (
    <>
      <Meta title="My apps — Civitai" description="Your Civitai apps" deIndex />
      <AppsPageLayout railFooter={({ collapsed }) => <AppsFeedbackNotice collapsed={collapsed} />}>
        <AppsHomeBody />
      </AppsPageLayout>
    </>
  );
}

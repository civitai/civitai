import { Anchor, Tabs } from '@mantine/core';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppAnalyticsPanel } from '~/components/AppBlocks/AppAnalyticsPanel';
import { RevenuePanel } from '~/components/AppBlocks/RevenuePanel';
import { Meta } from '~/components/Meta/Meta';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { APPS_PAGE_WIDTHS } from '~/components/Apps/appsPageWidths';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    // Author-capability gate (Phase B): the dedicated `appBlocksAuthor` flag
    // (Flipt `app-blocks-author`, static fallback mod-only), INDEPENDENT of the
    // marketplace-visibility `appBlocks` flag (which widens to public at GA).
    if (!features?.appBlocksAuthor) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!isAppDeveloper(session.user, { appBlocksAuthor: features?.appBlocksAuthor })) {
      return { notFound: true };
    }
    return { props: {} };
  },
});

export default function AppBlocksDashboardPage() {
  const features = useFeatureFlags();
  if (!features.appBlocks) return <NotFound />;

  return (
    <>
      <Meta title="Apps Dashboard — Civitai" deIndex />
      <AppsPageLayout
        size={APPS_PAGE_WIDTHS['/apps/revenue']}
        title="Apps Dashboard"
        subtitle={
          <>
            Revenue share and analytics for your apps. Payouts are batched weekly; see{' '}
            <Anchor component={Link} href="/apps/installed">
              Apps
            </Anchor>{' '}
            to manage installations.
          </>
        }
      >
        <Tabs defaultValue="revenue" keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="revenue">Revenue</Tabs.Tab>
            <Tabs.Tab value="analytics">Analytics</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="revenue">
            <RevenuePanel />
          </Tabs.Panel>
          <Tabs.Panel value="analytics">
            <AppAnalyticsPanel />
          </Tabs.Panel>
        </Tabs>
      </AppsPageLayout>
    </>
  );
}

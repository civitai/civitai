import { Anchor, Tabs } from '@mantine/core';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppAnalyticsPanel } from '~/components/AppBlocks/AppAnalyticsPanel';
import { RevenuePanel } from '~/components/AppBlocks/RevenuePanel';
import { Meta } from '~/components/Meta/Meta';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
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
      {/*
        🔴 The `subtitle` below is PINNED WHOLE, normalised, by
        `src/components/AppBlocks/__tests__/payout-copy-truthfulness.test.ts` — a reword goes
        red on purpose. The digital-goods sentence was added together with that guard's
        `SUBTITLE` constant, and the same test now also asserts the goods payout rail really
        exists; without that half, this page would promise an immediate credit on the strength
        of prose alone, which is the exact class of claim the guard was written to stop.

        ⚠️ TWO AUTHORING TRAPS, both measured while writing this, both of which fail as a
        "copy mismatch" that points at the sentence rather than at the real cause:
          1. Keep the comment OUTSIDE the prop's value. The guard flattens that whole
             expression to reader-visible text, so a `//` comment inside it is concatenated
             into the pinned string.
          2. Do not spell the prop's name followed by an open brace anywhere in this comment.
             The guard locates the prop by the first occurrence of that exact text, so a
             mention of it here is found instead of the real one and the comment's own braces
             get read as the subtitle.
      */}
      <AppsPageLayout
        title="Apps Dashboard"
        subtitle={
          <>
            Revenue share and analytics for your apps. Confirmed earnings accrue here; automated
            payouts are not yet enabled. Digital goods sales are separate: that rail pays out in
            Buzz at the time of each settled sale rather than accruing here, and the figures shown
            are your recorded share. See{' '}
            <Anchor component={Link} href="/apps/activity">
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

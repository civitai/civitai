import { useRouter } from 'next/router';
import React, { useEffect } from 'react';

import { AccountLayout } from '~/components/Account/AccountLayout';
import { AccountPane, accountPaneCopy } from '~/components/Account/AccountPanes';
import { LegacyAccountPage } from '~/components/Account/LegacyAccountPage';
import { resolveAccountSection } from '~/components/Account/account-sections';
import { Meta } from '~/components/Meta/Meta';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function Account() {
  const router = useRouter();
  const features = useFeatureFlags();

  const segments = router.query.section;
  const slug = Array.isArray(segments) ? segments[0] : segments;

  // A sub-path only means anything while the shell is on. After a rollback, bookmarks made during
  // the ramp would otherwise render the whole legacy page under a URL promising one section.
  useEffect(() => {
    if (features.accountSettingsV2 || !router.isReady || !slug) return;
    router.replace('/user/account');
  }, [features.accountSettingsV2, router.isReady, slug, router]);

  const content = () => {
    if (!features.accountSettingsV2) return <LegacyAccountPage />;

    // A second segment means a URL this shell has no pane for; treating it as the parent
    // section would render the wrong thing under a URL the user can bookmark.
    if (Array.isArray(segments) && segments.length > 1) return <NotFound />;

    const section = resolveAccountSection(slug);
    if (!section) return <NotFound />;

    const copy = accountPaneCopy[section.id];
    return (
      <AccountLayout section={section} title={copy.title}>
        <AccountPane sectionId={section.id} />
      </AccountLayout>
    );
  };

  return (
    <>
      <Meta title="Manage your Account - Civitai" deIndex />
      {content()}
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session }) => {
    if (!session?.user || session.user.bannedAt)
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };

    await ssg?.account.getAll.prefetch();
    if (session?.user?.subscriptionId) await ssg?.subscriptions.getUserSubscription.prefetch();
  },
});

import React from 'react';
import { Page } from '~/components/AppLayout/Page';
import { UserMediaInfinite } from '~/components/Image/Infinite/UserMediaInfinite';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { getUserBannedAtByUsername } from '~/server/services/user-banned-at.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const username = ctx.query.username as string;
    const user = await getUserBannedAtByUsername(username);

    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };

    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

export default Page(
  function () {
    return <UserMediaInfinite type="image" />;
  },
  { getLayout: UserProfileLayout }
);

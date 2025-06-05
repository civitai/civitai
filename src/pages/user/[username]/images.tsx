import React from 'react';
import { Page } from '~/components/AppLayout/Page';
import { UserMediaInfinite } from '~/components/Image/Infinite/UserMediaInfinite';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => {
    const username = ctx.query.username as string;
    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });

    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };
  },
});

export default Page(
  function () {
    return <UserMediaInfinite type="image" />;
  },
  { getLayout: UserProfileLayout }
);

import React from 'react';
import { useRouter } from 'next/router';
import { Page } from '~/components/AppLayout/Page';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { StickerBookView } from '~/components/StickerBook/StickerBookView';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const username = ctx.query.username as string;
    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });

    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };

    // The book itself is deliberately NOT prefetched: what it may contain
    // depends on the viewer's session and browsing level, and an SSG prefetch is
    // rendered without either.
    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

function StickerBookPage() {
  const username = useUsername();
  if (!username) return null;

  return <StickerBookView username={username} />;
}

export default Page(StickerBookPage, { getLayout: UserProfileLayout });

function useUsername() {
  const router = useRouter();
  const username = router.query.username;
  return typeof username === 'string' ? username : undefined;
}

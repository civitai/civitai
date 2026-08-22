import React from 'react';
import { useRouter } from 'next/router';
import { Page } from '~/components/AppLayout/Page';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { StickerBookSectionPage } from '~/components/StickerBook/StickerBookSectionPage';
import { StickerBookView } from '~/components/StickerBook/StickerBookView';
import { isStickerBookSide } from '~/components/StickerBook/sticker-book.util';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    const username = ctx.query.username as string;

    // The nav hides the tab; this closes the URL. A gate that only removes the
    // link is not a gate — the route is guessable and the page would render for
    // anyone who typed it.
    if (!features?.stickerBook)
      return { redirect: { destination: `/user/${username}`, permanent: false } };
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
  const router = useRouter();
  const username = useUsername();
  if (!username) return null;

  // `?view=` rather than a nested route, so the profile tab bar keeps the
  // sticker book selected on the drill-in — it highlights on the last path
  // segment.
  const view = router.query.view;

  return isStickerBookSide(view) ? (
    <StickerBookSectionPage username={username} side={view} />
  ) : (
    <StickerBookView username={username} />
  );
}

export default Page(StickerBookPage, { getLayout: UserProfileLayout });

function useUsername() {
  const router = useRouter();
  const username = router.query.username;
  return typeof username === 'string' ? username : undefined;
}

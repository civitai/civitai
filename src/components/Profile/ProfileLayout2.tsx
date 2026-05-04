import { trpc } from '~/utils/trpc';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';

import React, { useMemo } from 'react';

import { Meta } from '~/components/Meta/Meta';
import { abbreviateNumber } from '~/utils/number-helpers';
import { env } from '~/env/client';
import { TrackView } from '~/components/TrackView/TrackView';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { NoContent } from '~/components/NoContent/NoContent';
import { useRouter } from 'next/router';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { ProfileNavigation } from '~/components/Profile/ProfileNavigation';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import { usePathname } from 'next/navigation';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

export function ProfileLayout2({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { username } = router.query as { username: string };

  const { isInitialLoading, data: user } = trpc.userProfile.get.useQuery({ username });
  const { data: overview } = trpc.userProfile.overview.useQuery({ username });
  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.some((x) => x.id === user?.id);

  const stats = user?.stats;

  // SEO: deindex inactive accounts and empty subpages so they migrate from
  // "Crawled — currently not indexed" to "Excluded by noindex tag" and stop
  // dragging on site-wide quality. See docs/seo-thin-page-deindexing-plan.md.
  const deIndex = useMemo(() => {
    if (!user) return true;
    if (user.deletedAt || user.bannedAt) return true;

    const hasContent =
      (overview?.modelCount ?? 0) > 0 ||
      (overview?.postCount ?? 0) > 0 ||
      (overview?.imageCount ?? 0) > 0 ||
      (overview?.videoCount ?? 0) > 0 ||
      (overview?.articleCount ?? 0) > 0 ||
      (overview?.comicCount ?? 0) > 0;

    const isThin =
      !hasContent && (user.stats?.followerCountAllTime ?? 0) < 10 && !user.rank?.leaderboardRank;
    if (isThin) return true;

    const subpage = pathname?.match(/^\/user\/[^/]+\/(\w+)/)?.[1];
    if (subpage) {
      const subpageCounts: Record<string, number | undefined> = {
        models: overview?.modelCount,
        posts: overview?.postCount,
        images: overview?.imageCount,
        videos: overview?.videoCount,
        articles: overview?.articleCount,
        comics: overview?.comicCount,
        collections: overview?.collectionCount,
      };
      if (subpageCounts[subpage] === 0) return true;
    }

    return false;
  }, [user, overview, pathname]);
  // const { classes } = useStyles();

  const userMetaImage = user?.profilePicture
    ? getEdgeUrl(user.profilePicture.url, { width: 1200 })
    : user?.image && user.image.startsWith('http')
    ? user.image
    : undefined;
  const metaSchema =
    user && user.username
      ? {
          '@context': 'https://schema.org',
          '@type': 'ProfilePage',
          name: `${user.username} Creator Profile`,
          description: `Learn more about ${user.username} on Civitai.`,
          primaryImageOfPage: {
            '@type': 'ImageObject',
            contentUrl: userMetaImage,
          },
          mainEntity: {
            '@type': 'Person',
            name: user.username,
            image: userMetaImage,
            url: `${env.NEXT_PUBLIC_BASE_URL as string}/user/${username}`,
            interactionStatistic: stats
              ? [
                  {
                    '@type': 'InteractionCounter',
                    interactionType: 'http://schema.org/FollowAction',
                    userInteractionCount: stats.followerCountAllTime,
                  },
                  {
                    '@type': 'InteractionCounter',
                    interactionType: 'http://schema.org/LikeAction',
                    userInteractionCount: stats.thumbsUpCountAllTime,
                  },
                  {
                    '@type': 'InteractionCounter',
                    interactionType: 'http://schema.org/DownloadAction',
                    userInteractionCount: stats.downloadCountAllTime,
                  },
                ]
              : undefined,
          },
        }
      : undefined;

  return (
    <>
      {user && user.username && stats ? (
        <Meta
          title={`${user.username} Creator Profile | Civitai`}
          description={`Models Uploaded: ${abbreviateNumber(0)}, Followers: ${abbreviateNumber(
            stats.followerCountAllTime
          )}, Total Likes Received: ${abbreviateNumber(
            stats.thumbsUpCountAllTime
          )}, Total Downloads Received: ${abbreviateNumber(stats.downloadCountAllTime)}. `}
          images={user.profilePicture}
          canonical={pathname}
          schema={metaSchema}
          deIndex={deIndex}
        />
      ) : (
        <Meta
          title={`${user?.username ?? username} Creator Profile | Civitai`}
          description={`Learn more about ${user?.username ?? username} on Civitai.`}
          canonical={pathname}
          deIndex={deIndex}
        />
      )}
      {user && <TrackView entityId={user.id} entityType="User" type="ProfileView" />}
      <AppLayout
        loading={isInitialLoading}
        notFound={!user || !user.username}
        left={
          <div className="scroll-area relative min-h-full w-[320px] border-r border-gray-3 bg-gray-0 @max-sm:hidden dark:border-dark-4 dark:bg-dark-6">
            <ProfileSidebar username={username} />
          </div>
        }
        subNav={<ProfileNavigation username={username} />}
        announcements={false}
      >
        <div className="px-3">
          {isBlocked ? (
            <div className="mx-auto flex h-full items-center">
              <NoContent message="Unable to display content because you have blocked this user" />
            </div>
          ) : (
            <>
              <ProfileHeader username={username} />
              {children}
            </>
          )}
        </div>
      </AppLayout>
    </>
  );
}

export const UserProfileLayout = (page: React.ReactElement) => (
  <ProfileLayout2>{page}</ProfileLayout2>
);

import { trpc } from '~/utils/trpc';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';

import React from 'react';

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

  const enabled = username.toLowerCase() !== 'civitai';
  const { isInitialLoading, data: user } = trpc.userProfile.get.useQuery({ username }, { enabled });
  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.some((x) => x.id === user?.id);

  const stats = user?.stats;
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
            aggregateRating: stats
              ? {
                  '@type': 'AggregateRating',
                  ratingValue: stats.ratingAllTime.toFixed(2),
                  ratingCount: stats.ratingCountAllTime,
                }
              : undefined,
          },
        }
      : undefined;

  return (
    <>
      {user && user.username && stats ? (
        <Meta
          title={`${user.username} Creator Profile | Civitai`}
          description={`Average Rating: ${stats.ratingAllTime.toFixed(1)} (${abbreviateNumber(
            stats.ratingCountAllTime
          )}), Models Uploaded: ${abbreviateNumber(0)}, Followers: ${abbreviateNumber(
            stats.followerCountAllTime
          )}, Total Likes Received: ${abbreviateNumber(
            stats.thumbsUpCountAllTime
          )}, Total Downloads Received: ${abbreviateNumber(stats.downloadCountAllTime)}. `}
          images={user.profilePicture}
          links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/${pathname}`, rel: 'canonical' }]}
          schema={metaSchema}
        />
      ) : (
        <Meta
          title="Creator Profile | Civitai"
          description="Learn more about this awesome creator on Civitai."
          links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/${pathname}`, rel: 'canonical' }]}
        />
      )}
      {user && <TrackView entityId={user.id} entityType="User" type="ProfileView" />}
      <AppLayout
        loading={isInitialLoading}
        notFound={!user || !user.username || !enabled}
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

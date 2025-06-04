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

  return (
    <>
      {user && stats ? (
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
          links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/${pathname}`, rel: 'canonical' }]}
        />
      ) : (
        <Meta
          title="Creator Profile | Civitai"
          description="Learn more about this awesome creator on Civitai."
          links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/${pathname}`, rel: 'canonical' }]}
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

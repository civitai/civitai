import { trpc } from '~/utils/trpc';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';

import React from 'react';

import { Meta } from '~/components/Meta/Meta';
import { abbreviateNumber } from '~/utils/number-helpers';
import { env } from '~/env/client';
import { TrackView } from '~/components/TrackView/TrackView';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { NoContent } from '~/components/NoContent/NoContent';
import classes from './ProfileLayout.module.scss';

export function ProfileLayout({
  username,
  children,
}: {
  username: string;
  children: React.ReactNode;
}) {
  const enabled = username.toLowerCase() !== 'civitai';
  const { isInitialLoading, data: user } = trpc.userProfile.get.useQuery({ username }, { enabled });
  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.some((x) => x.id === user?.id);

  const stats = user?.stats;

  if (isInitialLoading) {
    return <PageLoader />;
  }

  if (!user || !user.username || !enabled) {
    return <NotFound />;
  }

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
          links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/user/${username}`, rel: 'canonical' }]}
        />
      ) : (
        <Meta
          title="Creator Profile | Civitai"
          description="Learn more about this awesome creator on Civitai."
        />
      )}
      {user && <TrackView entityId={user.id} entityType="User" type="ProfileView" />}
      <div className={classes.root}>
        <div className={classes.sidebar}>
          <ScrollArea>
            <ProfileSidebar username={username} />
          </ScrollArea>
        </div>
        {isBlocked ? (
          <div className="mx-auto flex h-full items-center">
            <NoContent message="Unable to display content because you have blocked this user" />
          </div>
        ) : (
          <ScrollArea p="md">{children}</ScrollArea>
        )}
      </div>
    </>
  );
}

export default ProfileLayout;

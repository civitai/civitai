import { trpc } from '~/utils/trpc';
import { createStyles } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';

import React from 'react';

import { Meta } from '~/components/Meta/Meta';
import { abbreviateNumber } from '~/utils/number-helpers';
import { env } from '~/env/client.mjs';
import { TrackView } from '~/components/TrackView/TrackView';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { containerQuery } from '~/utils/mantine-css-helpers';

export function ProfileLayout({
  username,
  children,
}: {
  username: string;
  children: React.ReactNode;
}) {
  const { isLoading, data: user } = trpc.userProfile.get.useQuery({
    username,
  });

  const stats = user?.stats;
  const { classes } = useStyles();

  if (isLoading) {
    return <PageLoader />;
  }

  if (!user || !user.username) {
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
        <ScrollArea p="md">{children}</ScrollArea>
      </div>
    </>
  );
}

export default ProfileLayout;

const useStyles = createStyles((theme) => ({
  sidebar: {
    width: 320,
    height: '100%',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],

    [containerQuery.smallerThan('sm')]: {
      display: 'none',
    },
  },
  root: {
    display: 'flex',
    flex: 1,
    height: '100%',
  },
}));

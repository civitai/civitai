import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import {
  Center,
  Container,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  createStyles,
  useMantineTheme,
} from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { constants } from '~/server/common/constants';
import React, { useMemo } from 'react';
import {
  getAllAvailableProfileSections,
  ProfileSectionComponent,
  shouldDisplayUserNullState,
} from '~/components/Profile/profile.utils';
import { ProfileSectionSchema, ProfileSectionType } from '~/server/schema/user-profile.schema';
import { IconCloudOff } from '@tabler/icons-react';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import { Meta } from '~/components/Meta/Meta';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
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
            stats.favoriteCountAllTime
          )}, Total Downloads Received: ${abbreviateNumber(stats.downloadCountAllTime)}. `}
          image={!user.image ? undefined : getEdgeUrl(user.image, { width: 1200 })}
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

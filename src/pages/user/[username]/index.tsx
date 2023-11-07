import {
  ActionIcon,
  AspectRatio,
  Box,
  Card,
  Center,
  Chip,
  Container,
  Group,
  Loader,
  Menu,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlProps,
  Stack,
  Tabs,
  Text,
  Title,
  createStyles,
  ThemeIcon,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { MetricTimeframe, ReviewReactions } from '@prisma/client';
import {
  IconArrowBackUp,
  IconBan,
  IconCategory,
  IconCloudOff,
  IconDotsVertical,
  IconFileText,
  IconFlag,
  IconFolder,
  IconInfoCircle,
  IconLayoutList,
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoto,
  IconTrash,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { CivitaiTabs } from '~/components/CivitaiWrapped/CivitaiTabs';
import { DomainIcon } from '~/components/DomainIcon/DomainIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { SortFilter } from '~/components/Filters';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { TrackView } from '~/components/TrackView/TrackView';
import { Username } from '~/components/User/Username';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/server/common/enums';
import { ReportEntity } from '~/server/schema/report.schema';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { sortDomainLinks } from '~/utils/domain-link';
import { showErrorNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { invalidateModeratedContent } from '~/utils/query-invalidation-utils';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { formatDate } from '~/utils/date-helpers';
import { UserStatBadges } from '~/components/UserStatBadges/UserStatBadges';
import { env } from '~/env/client.mjs';
import { ImageFiltersDropdown } from '~/components/Image/Filters/ImageFiltersDropdown';
import ProfileLayout from '~/components/Profile/ProfileLayout';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import {
  getAllAvailableProfileSections,
  ProfileSectionComponent,
  shouldDisplayUserNullState,
} from '~/components/Profile/profile.utils';
import { ProfileSectionSchema, ProfileSectionType } from '~/server/schema/user-profile.schema';
import { UserImagesPage } from '~/pages/user/[username]/images';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx, features }) => {
    const { username, id } = userPageQuerySchema.parse(ctx.params);
    if (username) {
      await ssg?.user.getCreator.prefetch({ username });
    }

    return {
      props: removeEmpty({
        id,
        username,
      }),
    };
  },
});

function ProfileOverview() {
  const router = useRouter();
  const { username } = router.query as { username: string };
  const { isLoading, data: user } = trpc.userProfile.get.useQuery({
    username,
  });
  const { isLoading: isLoadingOverview, data: userOverview } = trpc.userProfile.overview.useQuery({
    username,
  });

  const sections = useMemo(
    () =>
      !user
        ? []
        : getAllAvailableProfileSections(
            user.profile?.profileSectionsSettings as ProfileSectionSchema[]
          ).filter((section) => section.enabled),
    [user]
  );

  if (isLoading || isLoadingOverview) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  if (!user || !user.username || !userOverview) {
    return <NotFound />;
  }

  const shouldDisplayUserNullStateBool = shouldDisplayUserNullState({
    overview: userOverview,
    userWithProfile: user,
  });

  return (
    <>
      {shouldDisplayUserNullStateBool ? (
        <Stack>
          <Stack align="center" py="lg">
            <ThemeIcon size={128} radius={100}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Text size="lg" maw={600} align="center">
              Whoops! Looks like this user doesn&rsquo;t have any content yet or has chosen not to
              display anything. Check back later!
            </Text>
          </Stack>
        </Stack>
      ) : (
        <Stack>
          {sections.map((section) => {
            const Section = ProfileSectionComponent[section.key as ProfileSectionType];

            if (!Section) {
              // Useful if we remove a section :)
              return null;
            }

            return (
              <Section
                key={section.key}
                // Keep typescript happy.
                user={{ ...user, username: user.username as string }}
              />
            );
          })}
        </Stack>
      )}
    </>
  );
}

export function UserProfileEntry() {
  const features = useFeatureFlags();

  if (features.profileOverhaul) {
    return <ProfileOverview />;
  }

  return <UserImagesPage />;
}

UserProfileEntry.getLayout = UserProfileLayout;

export default UserProfileEntry;

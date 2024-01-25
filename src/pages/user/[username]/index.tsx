import { Center, Loader, Stack, Text, ThemeIcon } from '@mantine/core';

import { IconCloudOff } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useMemo } from 'react';

import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { NotFound } from '~/components/AppLayout/NotFound';

import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

import { userPageQuerySchema } from '~/server/schema/user.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

import { removeEmpty } from '~/utils/object-helpers';

import { trpc } from '~/utils/trpc';

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
  resolver: async ({ ssg, ctx }) => {
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
      <Center mt="md">
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
        <Stack spacing={0}>
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

setPageOptions(UserProfileEntry, { innerLayout: UserProfileLayout });
export default UserProfileEntry;

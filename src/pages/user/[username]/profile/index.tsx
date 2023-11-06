import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { trpc } from '~/utils/trpc';
import { Center, Loader, Stack, Text, ThemeIcon } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useMemo } from 'react';
import {
  getAllAvailableProfileSections,
  ProfileSectionComponent,
  shouldDisplayUserNullState,
} from '~/components/Profile/profile.utils';
import { ProfileSectionSchema, ProfileSectionType } from '~/server/schema/user-profile.schema';
import { IconCloudOff } from '@tabler/icons-react';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';
import ProfileLayout from '~/components/Profile/ProfileLayout';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg, ctx }) => {
    const { username } = userPageQuerySchema.parse(ctx.params);

    if (username) {
      await ssg?.userProfile.get.prefetch({ username });
      await ssg?.userProfile.overview.prefetch({ username });
    }

    if (!username) {
      return {
        notFound: true,
      };
    }

    return {
      props: {
        username,
      },
    };
  },
});

export function UserProfileOverview({ username }: { username: string }) {
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
    <ProfileLayout username={username}>
      <ProfileHeader username={username} />
      {shouldDisplayUserNullStateBool ? (
        <Stack mt="md">
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
        <Stack mt="md">
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
    </ProfileLayout>
  );
}

UserProfileOverview.getLayout = (page: React.ReactElement) => <SidebarLayout>{page}</SidebarLayout>;

export default UserProfileOverview;

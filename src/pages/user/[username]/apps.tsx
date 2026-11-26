import { Box, Center, Container, Loader } from '@mantine/core';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { UserAppsGrid } from '~/components/Apps/UserAppsGrid';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { canShowProfileAppsTab } from '~/components/Profile/profile-apps-tab';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getUserBannedAtByUsername } from '~/server/services/user-banned-at.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    // The same predicate as the profile tab: no store access, no page.
    if (!canShowProfileAppsTab(features, null)) return { notFound: true };

    const username = ctx.query.username as string;
    const user = await getUserBannedAtByUsername(username);
    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };

    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

function UserAppsPage() {
  const router = useRouter();
  const features = useFeatureFlags();
  const username = (router.query.username as string) ?? '';
  const { data: user, isLoading } = trpc.userProfile.get.useQuery(
    { username },
    { enabled: !!username }
  );

  if (!username) return <NotFound />;
  if (isLoading)
    return (
      <Box mt="md">
        <Center>
          <Loader />
        </Center>
      </Box>
    );
  if (!user || !canShowProfileAppsTab(features, user)) return <NotFound />;

  // The `/apps` store narrowed to this developer: what it hides from a viewer, this hides too.
  return (
    <Container size="xl" py="md">
      <UserAppsGrid userId={user.id} />
    </Container>
  );
}

export default Page(UserAppsPage, { getLayout: UserProfileLayout });

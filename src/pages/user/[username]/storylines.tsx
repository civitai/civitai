import { Box, Center, Container, Loader } from '@mantine/core';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { StorylinesFeed } from '~/components/Storyline/StorylinesFeed';
import { getUserBannedAtByUsername } from '~/server/services/user-banned-at.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    if (!features?.storylines) return { notFound: true };

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

function UserStorylinesPage() {
  const router = useRouter();
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
  if (!user) return <NotFound />;

  // The /storylines feed narrowed to this owner: what it hides from a reader, this hides too.
  return (
    <Container size="xl" py="md">
      <StorylinesFeed filter="all" sort="newest" userId={user.id} />
    </Container>
  );
}

export default Page(UserStorylinesPage, { getLayout: UserProfileLayout });
